import { it, expect, beforeAll, afterAll } from 'vitest'
import ssh2 from 'ssh2'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { connectSsh, execFull, setHostKeyPolicy, type SshConn } from '@lingshell/terminal-core'
import { diffProfiles, findIssues, summarizeDiff, unifiedDiff, type AgentEvent, type HostProfile, type ProfileMeta, type TerminalInfo, type TurnHostReport } from '@lingshell/shared'
import { registerHostCheck, ProfileStore } from './hostCheck.js'
import { isReadOnlyCommand } from './readonlyCommand.js'
import { findBash } from '../core/index.js'

// 本机回环的假 sshd：exec 交给本机 Git Bash 真跑采集脚本；远端没有的命令（ss / systemctl / docker / last / sshd / openssl / dnf）
// 用 PATH 前置的假脚本顶上，/etc 下的文件放临时目录（LINGSHELL_HC_ROOT 指过去）。不连任何真实主机
const { Server, utils } = ssh2 as unknown as { Server: typeof import('ssh2').Server; utils: typeof import('ssh2').utils }
const BASH = findBash()
const posix = (p: string) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`)

const dir = mkdtempSync(join(tmpdir(), 'lingshell-hc-'))
const root = join(dir, 'root'), bin = join(dir, 'bin'), data = join(dir, 'data')
const put = (p: string, s: string) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, s) }
const etc = (p: string, s: string) => put(join(root, 'etc', p), s)
const tool = (name: string, body: string) => put(join(bin, name), `#!/bin/sh\n${body}\n`)
const setPorts = (ports: number[]) => put(join(dir, 'ports.txt'), ports.map((p) => `LISTEN 0 128 0.0.0.0:${p} 0.0.0.0:* users:(("svc${p}",pid=${p},fd=3))`).join('\n') + '\n')

let srv: { port: number; close(): void } | undefined
let conn: SshConn | undefined

beforeAll(async () => {
  etc('ssh/sshd_config', '# test\nPermitRootLogin yes\nMatch User git\n  PasswordAuthentication no\n')
  etc('nginx/nginx.conf', 'events {}\nhttp { include conf.d/*.conf; }\n')
  etc('nginx/conf.d/site.conf', 'server {\n  listen 443 ssl;\n  ssl_certificate /etc/nginx/ssl/site.pem;\n}\n')
  etc('passwd', 'root:x:0:0:root:/root:/bin/bash\ntoor:x:0:0::/root:/bin/sh\nalice:x:1000:1000::/home/alice:/bin/bash\n')
  etc('hosts', '127.0.0.1 localhost\n')
  etc('os-release', 'PRETTY_NAME="Fake Linux 1.0"\n')
  setPorts([22, 8080])
  tool('ss', `cat "${posix(join(dir, 'ports.txt'))}"`)
  tool('systemctl', 'echo "nginx.service loaded failed failed The nginx HTTP server"')
  tool('docker', 'echo "web|nginx:1.25|running|Up 2 hours"')
  tool('last', 'echo "root     pts/0        203.0.113.9      Wed Oct 14 10:00   still logged in"')
  tool('sshd', 'exit 1')
  // 用 Git Bash 自带的 openssl 生成一张 10 天后到期的真证书。openssl 是原生程序，要靠 MSYS 自动转换 /c/... 路径，不能关路径转换
  const { MSYS_NO_PATHCONV: _off, ...baseEnv } = process.env
  mkdirSync(join(root, 'etc/nginx/ssl'), { recursive: true })
  spawnSync(BASH!, ['-c', 'openssl req -x509 -newkey rsa:2048 -nodes -days 10 -subj //CN=a.test -keyout "$1/k.pem" -out "$1/site.pem"', '_', posix(join(root, 'etc/nginx/ssl'))], { env: baseEnv })
  tool('dnf', 'case "$*" in *check-update*) printf "kernel.x86_64  5.14.1  baseos\\nopenssl.x86_64  3.0.9  baseos\\n"; exit 100;; *updateinfo*) echo "RLSA-2026:1 Important/Sec. openssl";; esac')
  const env = { ...baseEnv, PATH: `${bin};${process.env.PATH}`, LINGSHELL_HC_ROOT: posix(root) }
  const s = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (c) => {
    c.on('authentication', (ctx) => ctx.accept())
    c.on('error', () => {})
    c.on('session', (accept) => {
      accept().on('exec', (ok, _rej, info) => {
        const ch = ok()
        const p = spawn(BASH!, ['-c', info.command], { env })
        p.stdout.pipe(ch, { end: false }); p.stderr.pipe(ch.stderr, { end: false })
        p.on('close', (code) => { ch.exit(code ?? 0); ch.end() })
      })
    })
  })
  srv = await new Promise((r) => s.listen(0, '127.0.0.1', () => r({ port: (s.address() as AddressInfo).port, close: () => s.close() })))
  const db = new Map<string, { keyType: string; fingerprint: string }>()
  setHostKeyPolicy({ lookup: (hp) => db.get(hp), remember: (hp, keyType, fingerprint) => { db.set(hp, { keyType, fingerprint }) }, prompt: async () => true })
  conn = await connectSsh({ host: '127.0.0.1', port: srv!.port, username: 'u', password: 'p' })
})
afterAll(() => { conn?.close(); srv?.close(); rmSync(dir, { recursive: true, force: true }) })

function setup(enabled = true) {
  const hs = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
  const emitted: string[] = []
  let turn: { dshId: string; turnId: string } | undefined
  const term = { id: 'p1', type: 'ssh', os: 'linux', title: 'web-1', status: 'running' } as TerminalInfo
  const hc = registerHostCheck({
    handle: (ch, fn) => { hs.set(ch, fn) },
    store: new ProfileStore(data),
    terminal: (id) => (id === 'p1' ? term : id === 'loc' ? ({ id, type: 'local', title: 'local', status: 'running' } as TerminalInfo) : undefined),
    hostKey: (id) => (id === 'p1' ? '127.0.0.1:22' : 'local'),
    exec: () => (cmd, o) => execFull(conn!.client, cmd, o),
    liveTerminalOf: () => 'p1',
    diff: unifiedDiff,
    enabled: () => enabled,
    isReadOnly: isReadOnlyCommand,
    turnOf: () => turn,
    dshIdOf: () => 'd1',
    emit: (_sid, turnId) => { emitted.push(turnId) },
    log: () => {},
  })
  const call = <T>(ch: string, ...a: unknown[]) => hs.get(ch)!({}, ...a) as Promise<T>
  const endTurn = (turnId: string) => hc.onEvent({ type: 'agent:turnCompleted', sessionId: 's1', turnId } as AgentEvent)
  return { hc, call, emitted, setTurn: (t?: string) => { turn = t ? { dshId: 'd1', turnId: t } : undefined }, endTurn }
}

const until = async (f: () => boolean, ms = 15000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 50)) } }

it('体检：一次 exec 采全部，解析成档案并找出问题项；改配置 + 加端口后「和上次比」有差异，文件可比较 / 拉取当前内容', async () => {
  const { call } = setup()
  const p1 = await call<HostProfile>('hostCheck:run', 'p1')
  expect(p1).toMatchObject({ type: 'check', hostKey: '127.0.0.1:22', hostLabel: 'web-1' })
  expect(p1.partial).toBeUndefined()
  expect(p1.sys?.os).toBe('Fake Linux 1.0')
  expect(p1.ports?.map((x) => x.port)).toEqual([22, 8080])
  expect(p1.failedUnits).toEqual(['nginx.service'])
  expect(p1.containers).toEqual([{ name: 'web', image: 'nginx:1.25', state: 'running', status: 'Up 2 hours' }])
  expect(p1.files?.map((f) => [f.path, !!f.sha256, f.content])).toEqual([
    ['/etc/ssh/sshd_config', true, true], ['/etc/nginx/nginx.conf', true, true], ['/etc/nginx/conf.d/site.conf', true, true], ['/etc/hosts', true, true],
  ])
  expect(p1.uid0).toEqual(['root', 'toor'])
  expect(p1.logins).toEqual([{ user: 'root', ip: '203.0.113.9', time: 'Wed Oct 14 10:00 still logged in' }])
  expect(p1.sshd).toEqual({ permitRootLogin: 'yes', passwordAuthentication: 'yes', source: 'config' })
  expect(p1.certs).toHaveLength(1)
  expect(p1.certs![0].path).toBe('/etc/nginx/ssl/site.pem')
  expect(p1.updates).toEqual({ manager: 'dnf', total: 2, security: 1 })
  expect(p1.certs![0].notAfter).toBeTruthy()
  expect(findIssues(p1).map((i) => i.kind).filter((k) => k !== 'disk' && k !== 'inode').sort())   // 磁盘是本机真实 df，不定.toEqual(['cert', 'service', 'sshd', 'uid0', 'updates'])

  // 改配置 + 新监听
  etc('nginx/nginx.conf', 'events {}\nhttp { include conf.d/*.conf; server_tokens off; }\n')
  setPorts([22, 8080, 9090])
  const p2 = await call<HostProfile>('hostCheck:run', 'p1')
  const hist = await call<{ hostKey: string; items: ProfileMeta[] }>('hostCheck:history', 'p1')
  expect(hist.items.map((x) => x.id)).toEqual([p2.id, p1.id])
  expect(hist.items[0]).toMatchObject({ type: 'check', issues: findIssues(p2).length, label: 'web-1' })
  const prev = await call<HostProfile>('hostCheck:get', 'p1', p1.id)
  const d = diffProfiles(prev, p2)
  expect(summarizeDiff(d)).toEqual(['端口 +1', 'nginx.conf 已修改'])
  const f = d.files[0]
  const fd = await call<{ diff: string }>('hostCheck:fileDiff', '127.0.0.1:22', f.path, f.from, f.to)
  expect(fd.diff).toContain('+http { include conf.d/*.conf; server_tokens off; }')

  // 拉取当前内容：和本次缓存比
  etc('nginx/nginx.conf', 'events {}\nhttp { include conf.d/*.conf; server_tokens off; gzip on; }\n')
  const ff = await call<{ diff: string; sha256: string }>('hostCheck:fetchFile', 'p1', '/etc/nginx/nginx.conf', f.to)
  expect(ff.diff).toContain('gzip on;')
  await expect(call('hostCheck:fetchFile', 'p1', '/etc/shadow', f.to)).rejects.toThrow('只能拉取')
  await expect(call('hostCheck:run', 'loc')).rejects.toThrow('只支持 Linux')
}, 120_000)

it('变更保险：只读命令不拍；首次写命令前拍快照（限时 10s），回合结束再拍，有变化出报告；无变化不出', async () => {
  setPorts([22, 8080])
  const { hc, call, emitted, setTurn, endTurn } = setup()
  setTurn('turn_1')
  await hc.beforeChange('s1', ['p1'], 'cat /etc/hosts | grep x')   // 只读：不拍
  expect((await call<{ items: ProfileMeta[] }>('hostCheck:history', 'p1')).items.filter((x) => x.type === 'snapshot')).toHaveLength(0)
  const t0 = Date.now()
  await hc.beforeChange('s1', ['p1', 'loc'], 'touch /tmp/x && sed -i s/a/b/ /etc/hosts')
  expect(Date.now() - t0).toBeLessThan(10_000)
  await hc.beforeChange('s1', ['p1'], 'systemctl restart nginx')   // 本轮同一主机不再拍
  expect((await call<{ items: ProfileMeta[] }>('hostCheck:history', 'p1')).items.filter((x) => x.type === 'snapshot')).toHaveLength(1)
  // AI 的改动
  etc('hosts', '127.0.0.1 localhost\n10.0.0.5 db\n')
  setPorts([22, 8080, 3306])
  endTurn('turn_1')
  await until(() => emitted.includes('turn_1'))
  const reps = await call<TurnHostReport[]>('hostChanges:list', 's1')
  expect(reps).toHaveLength(1)
  expect(reps[0]).toMatchObject({ dshId: 'd1', turnId: 'turn_1' })
  expect(reps[0].hosts[0]).toMatchObject({ hostKey: '127.0.0.1:22', hostLabel: 'web-1', summary: ['端口 +1', 'hosts 已修改'] })
  const fc = reps[0].hosts[0].diff!.files[0]
  expect((await call<{ diff: string }>('hostCheck:fileDiff', '127.0.0.1:22', fc.path, fc.from, fc.to)).diff).toContain('+10.0.0.5 db')

  // 下一轮：写了但主机没变 → 不出报告
  setTurn('turn_2')
  await hc.beforeChange('s1', ['p1'], 'echo hi > /tmp/y')
  endTurn('turn_2')
  await new Promise((r) => setTimeout(r, 4000))
  expect(emitted).toEqual(['turn_1'])
  expect(await call<TurnHostReport[]>('hostChanges:list', 's1')).toHaveLength(1)

  // 开关关了：不拍
  const off = setup(false)
  off.setTurn('turn_3')
  const before = (await call<{ items: ProfileMeta[] }>('hostCheck:history', 'p1')).items.length
  await off.hc.beforeChange('s1', ['p1'], 'rm -f /tmp/x')
  expect((await call<{ items: ProfileMeta[] }>('hostCheck:history', 'p1')).items.length).toBe(before)
}, 120_000)
