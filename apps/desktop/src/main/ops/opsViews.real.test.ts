import { it, expect, beforeAll, afterAll } from 'vitest'
import ssh2 from 'ssh2'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { connectSsh, execFull, setHostKeyPolicy, type SshConn } from '@lingshell/terminal-core'
import type { CronList, FwList, TerminalInfo, Topology } from '@lingshell/shared'
import { registerOpsViews } from './opsViewsIpc.js'
import { findBash } from '../core/index.js'

// 本机回环的假 sshd：exec 交给本机 Git Bash 真跑脚本（只回 stdout，同 execRead）；远端的 crontab / sudo / ss / systemctl / nft / iptables / docker / hostname
// 用 PATH 前置的假脚本顶上，/etc 下的文件放临时目录（LINGSHELL_HC_ROOT 指过去），HOME 指临时目录（备份落在这里）。不连任何真实主机
const { Server, utils } = ssh2 as unknown as { Server: typeof import('ssh2').Server; utils: typeof import('ssh2').utils }
const BASH = findBash()
const posix = (p: string) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`)

const dir = mkdtempSync(join(tmpdir(), 'lingshell-ops-'))
const root = join(dir, 'root'), bin = join(dir, 'bin'), home = join(dir, 'home'), state = join(dir, 'state')
const put = (p: string, s: string) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, s) }
const tool = (name: string, body: string) => put(join(bin, name), `#!/bin/sh\n${body}\n`)
const cronFile = join(state, 'cron-user')
const P = (p: string) => posix(p)

let srv: { port: number; close(): void } | undefined
let conn: SshConn | undefined

beforeAll(async () => {
  mkdirSync(home, { recursive: true })
  put(join(root, 'etc/crontab'), 'SHELL=/bin/sh\n17 * * * * root cd / && run-parts --report /etc/cron.hourly\n')
  put(join(root, 'etc/cron.d/certbot'), '0 */12 * * * root certbot -q renew\n')
  put(cronFile, 'MAILTO=""\n0 3 * * * /opt/backup.sh\n*/5 * * * * /opt/ping.sh\n')
  put(join(state, 'cron-root'), '@reboot /root/start.sh\n')
  tool('crontab', [
    `F="${P(cronFile)}"`,
    'case "$*" in',
    `  "-l -u root") cat "${P(join(state, 'cron-root'))}";;`,
    '  "-l") [ -f "$F" ] && cat "$F" || { echo "no crontab" >&2; exit 1; };;',
    '  "-") cat > "$F.new"; if grep -q "^bad" "$F.new"; then echo "\\"-\\":1: bad minute" >&2; echo "errors in crontab file, can\'t install." >&2; rm -f "$F.new"; exit 1; fi; mv "$F.new" "$F";;',
    '  *) exit 2;;',
    'esac',
  ].join('\n'))
  tool('sudo', `[ "$1" = "-n" ] && shift; [ -f "${P(join(state, 'nosudo'))}" ] && { echo "sudo: a password is required" >&2; exit 1; }; exec "$@"`)
  tool('hostname', 'echo "10.0.0.5 172.17.0.1"')
  tool('systemctl', [
    'case "$1" in',
    '  list-timers) case "$*" in *--no-legend*) echo "Sat 2026-10-17 12:00:00 CST 1h left Sat 2026-10-17 00:00:00 CST 10h ago logrotate.timer logrotate.service";; *)',
    '    echo "NEXT                         LEFT          LAST                         PASSED       UNIT                         ACTIVATES"',
    '    echo "Sat 2026-10-17 12:00:00 CST  1h 44min left Sat 2026-10-17 00:00:00 CST  10h ago      logrotate.timer              logrotate.service"',
    '    echo; echo "1 timers listed.";; esac;;',
    '  show) printf "Id=logrotate.timer\\nTimersCalendar={ OnCalendar=*-*-* 00:00:00 ; next_elapse=x }\\nTimersMonotonic=\\n";;',
    'esac',
  ].join('\n'))
  tool('nft', 'printf "table inet filter {\\n\\tchain input {\\n\\t\\ttype filter hook input priority filter; policy drop;\\n\\t\\ttcp dport 22 accept\\n\\t\\tip saddr 10.0.0.0/8 tcp dport 3306 accept\\n\\t}\\n}\\n"')
  tool('iptables', 'case "$1" in -S) echo "-P INPUT ACCEPT";; *) echo "Chain INPUT (policy ACCEPT)";; esac')
  tool('ss', [
    'case "$*" in',
    '  *established*) echo "0 0 127.0.0.1:41000 127.0.0.1:8080 users:((\\"nginx\\",pid=101,fd=12))"; echo "0 0 10.0.0.5:43000 10.9.8.7:3306 users:((\\"java\\",pid=200,fd=23))";;',
    '  *u*) echo "tcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:((\\"sshd\\",pid=1,fd=3))"; echo "tcp LISTEN 0 128 127.0.0.1:8080 0.0.0.0:* users:((\\"java\\",pid=200,fd=9))";;',
    '  *) echo "LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:((\\"nginx\\",pid=100,fd=6))"; echo "LISTEN 0 100 127.0.0.1:8080 0.0.0.0:* users:((\\"java\\",pid=200,fd=9))";;',
    'esac',
  ].join('\n'))
  tool('docker', 'case "$1 $2" in "ps --format") printf "minio\\t0.0.0.0:9000->9000/tcp\\n";; "network ls") echo n1;; "network inspect") echo \'[{"Containers":{"a":{"Name":"minio","IPv4Address":"172.17.0.2/16"}}}]\';; esac')

  const { MSYS_NO_PATHCONV: _off, ...baseEnv } = process.env
  const env = { ...baseEnv, PATH: `${bin};${process.env.PATH}`, LINGSHELL_HC_ROOT: P(root), HOME: P(home) }
  const s = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (c) => {
    c.on('authentication', (ctx) => ctx.accept())
    c.on('error', () => {})
    c.on('session', (accept) => {
      accept().on('exec', (ok, _rej, info) => {
        const ch = ok()
        const p = spawn(BASH!, ['-c', info.command], { env })
        p.stdout.pipe(ch, { end: false }); p.stderr.resume()
        p.on('close', (code) => { ch.exit(code ?? 0); ch.end() })
      })
    })
  })
  srv = await new Promise((r) => s.listen(0, '127.0.0.1', () => r({ port: (s.address() as AddressInfo).port, close: () => s.close() })))
  const db = new Map<string, { keyType: string; fingerprint: string }>()
  setHostKeyPolicy({ lookup: (hp) => db.get(hp), remember: (hp, keyType, fingerprint) => { db.set(hp, { keyType, fingerprint }) }, prompt: async () => true })
  conn = await connectSsh({ host: '127.0.0.1', port: srv!.port, username: 'u', password: 'p' })
}, 30_000)
afterAll(() => { conn?.close(); srv?.close(); rmSync(dir, { recursive: true, force: true }) })

function setup(reply = '{"schedule":"0 3 * * *","command":"find /tmp -type f -mtime +7 -delete","explain":"每天凌晨 3 点清理 /tmp 下 7 天前的文件"}') {
  const hs = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
  const audits: { command: string; decision: string; exitCode?: number }[] = []
  const prompts: string[] = []
  registerOpsViews({
    handle: (ch, fn) => { hs.set(ch, fn) },
    terminal: (id) => (id === 'p1' ? ({ id, type: 'ssh', os: 'linux', title: 'web-1', env: 'prod' } as TerminalInfo) : id === 'loc' ? ({ id, type: 'local', title: 'l' } as TerminalInfo) : undefined),
    exec: () => (cmd, ms) => execFull(conn!.client, cmd, { timeoutMs: ms }).then((r) => r.output),
    audit: (_t, e) => { audits.push(e) },
    complete: async (sys, user) => { prompts.push(`${sys}\n${user}`); return reply },
  })
  const call = <T>(ch: string, ...a: unknown[]) => hs.get(ch)!({}, ...a) as Promise<T>
  return { call, audits, prompts }
}
const backups = () => (existsSync(join(home, '.lingshell/backups')) ? readdirSync(join(home, '.lingshell/backups')) : [])

it('定时任务：列出各来源 + timer；新建 / 注释 / 删除写回并备份、记执行记录；原文对不上 / 写失败不改', async () => {
  const { call, audits, prompts } = setup()
  const l = await call<CronList>('cron:list', 'p1')
  expect(l.rootDenied).toBeUndefined()
  expect(l.entries.map((e) => [e.source, e.schedule, e.command])).toEqual([
    ['user', '0 3 * * *', '/opt/backup.sh'],
    ['user', '*/5 * * * *', '/opt/ping.sh'],
    ['root', '@reboot', '/root/start.sh'],
    ['/etc/crontab', '17 * * * *', 'cd / && run-parts --report /etc/cron.hourly'],
    ['/etc/cron.d/certbot', '0 */12 * * *', 'certbot -q renew'],
  ])
  expect(l.timers).toEqual([expect.objectContaining({ unit: 'logrotate.timer', activates: 'logrotate.service', calendar: 'OnCalendar=*-*-* 00:00:00' })])
  expect(l.tzOffsetMin).toBeTypeOf('number')

  // AI 生成：提示词带需求、生产提示；不落盘
  const g = await call('cron:generate', 'p1', '每天凌晨 3 点清理 /tmp 下 7 天前的文件')
  expect(g).toEqual({ schedule: '0 3 * * *', command: 'find /tmp -type f -mtime +7 -delete', explain: '每天凌晨 3 点清理 /tmp 下 7 天前的文件' })
  expect(prompts[0]).toContain('生产主机')
  expect(prompts[0]).toContain('需求：每天凌晨 3 点清理')

  const r = await call<{ backup?: string }>('cron:add', 'p1', { schedule: '0 3 * * *', command: 'find /tmp -type f -mtime +7 -delete; date +%F', note: '清理 /tmp' })
  expect(readFileSync(cronFile, 'utf8')).toBe('MAILTO=""\n0 3 * * * /opt/backup.sh\n*/5 * * * * /opt/ping.sh\n# 清理 /tmp\n0 3 * * * find /tmp -type f -mtime +7 -delete; date +\\%F\n')
  expect(r.backup).toMatch(/\.lingshell\/backups\/\d{8}-\d{6}-\d{3}_crontab$/)
  expect(backups()).toHaveLength(1)
  expect(readFileSync(join(home, '.lingshell/backups', backups()[0]), 'utf8')).toBe('MAILTO=""\n0 3 * * * /opt/backup.sh\n*/5 * * * * /opt/ping.sh\n')
  expect(audits.at(-1)).toMatchObject({ decision: 'cron_add', exitCode: 0 })
  expect(audits.at(-1)!.command).toContain('原 crontab 已备份到')

  await call('cron:toggle', 'p1', 3, '*/5 * * * * /opt/ping.sh', true)
  expect(readFileSync(cronFile, 'utf8')).toContain('\n# */5 * * * * /opt/ping.sh\n')
  const l2 = await call<CronList>('cron:list', 'p1')
  expect(l2.entries.find((e) => e.command === '/opt/ping.sh')).toMatchObject({ disabled: true, line: 3 })
  await call('cron:toggle', 'p1', 3, '# */5 * * * * /opt/ping.sh', false)
  await call('cron:remove', 'p1', 2, '0 3 * * * /opt/backup.sh')
  expect(readFileSync(cronFile, 'utf8')).toBe('MAILTO=""\n*/5 * * * * /opt/ping.sh\n# 清理 /tmp\n0 3 * * * find /tmp -type f -mtime +7 -delete; date +\\%F\n')
  expect(audits.map((a) => a.decision)).toEqual(['cron_add', 'cron_disable', 'cron_enable', 'cron_delete'])
  expect(backups()).toHaveLength(4)

  // 读取后被别处改过：拒绝，不写、不记
  const before = readFileSync(cronFile, 'utf8')
  await expect(call('cron:remove', 'p1', 2, '0 3 * * * /opt/backup.sh')).rejects.toThrow('已被改动')
  expect(readFileSync(cronFile, 'utf8')).toBe(before)
  expect(audits).toHaveLength(4)
  // 命令多行：参数校验直接拒
  await expect(call('cron:add', 'p1', { schedule: '* * * * *', command: 'x\nbad' })).rejects.toThrow('一行')
  // crontab 拒收（假 crontab 见到 bad 开头的行就报错）：原文不变，报错带原因，照样记一笔（退出码 1）
  writeFileSync(cronFile, 'bad line\n')
  await expect(call('cron:add', 'p1', { schedule: '0 2 * * *', command: 'y' })).rejects.toThrow('bad minute')
  expect(readFileSync(cronFile, 'utf8')).toBe('bad line\n')
  expect(audits.at(-1)).toMatchObject({ decision: 'cron_add', exitCode: 1 })

  // 免密 sudo 不可用：读不到 root 的 crontab，其余照常
  writeFileSync(join(state, 'nosudo'), '')
  const l3 = await call<CronList>('cron:list', 'p1')
  expect(l3.rootDenied).toBe(true)
  expect(l3.entries.some((e) => e.source === 'root')).toBe(false)
  rmSync(join(state, 'nosudo'))

  await expect(call('cron:list', 'loc')).rejects.toThrow('只支持 Linux 的 SSH 终端')
  await expect(call('cron:generate', 'p1', ' ')).rejects.toThrow('请先写下')
  const { call: bad } = setup('{"error":"这不是定时任务"}')
  await expect(bad('cron:generate', 'p1', '帮我写首诗')).rejects.toThrow('这不是定时任务')
}, 60_000)

it('定时任务：超过 2000 字的长命令也能删除（原文只用于逐字比对）', async () => {
  const { call } = setup()
  const long = `0 3 * * * /opt/run.sh ${'x'.repeat(3000)}`
  writeFileSync(cronFile, `MAILTO=""\n${long}\n*/5 * * * * /opt/ping.sh\n`)
  const l = await call<CronList>('cron:list', 'p1')
  const e = l.entries.find((x) => x.source === 'user' && x.command.includes('/opt/run.sh'))!
  expect(e.line).toBe(2)
  await call('cron:remove', 'p1', e.line, e.raw)
  expect(readFileSync(cronFile, 'utf8')).toBe('MAILTO=""\n*/5 * * * * /opt/ping.sh\n')
}, 30_000)

it('防火墙：探测到的工具逐个解析，选在用的；附监听端口', async () => {
  const { call } = setup()
  const f = await call<FwList>('firewall:list', 'p1')
  expect(f.primary).toBe('nft')
  expect(f.sections.map((s) => [s.tool, s.active])).toEqual([['nft', true], ['iptables', false]])
  expect(f.sections[0].rules.map((r) => r.text)).toEqual(['允许任何地址访问 22/tcp', '允许 10.0.0.0/8 访问 3306/tcp'])
  expect(f.listen).toContain('127.0.0.1:8080')
}, 30_000)

it('服务拓扑：进程 → 进程 / 外部；容器', async () => {
  const { call } = setup()
  const t = await call<Topology>('topology:get', 'p1')
  expect(t.edges.map((e) => `${e.from}>${e.to}:${e.port}`).sort()).toEqual(['proc:java>ext:10.9.8.7:3306:3306', 'proc:nginx>proc:java:8080'])
  expect(t.nodes.find((n) => n.id === 'ctr:minio')).toBeUndefined()   // 没监听映射端口、没连接的容器不画
  expect(t.docker).toBe(true)
}, 30_000)
