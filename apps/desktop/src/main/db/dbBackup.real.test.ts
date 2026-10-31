import { afterAll, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { BackupFile, BackupPlan, BackupStatus, DbConn } from '@lingshell/shared'
import { LOCAL_SHELL } from '../terminal/index.js'
import { runSh } from '../terminal/index.js'
import { registerDb, type DbRun } from './dbIpc.js'

// 数据库备份：真 shell（Windows 用 Git Bash）+ PATH 里的假 mysql / mysqldump / pg_dump，HOME 指到临时目录（~ 展开到这里）。
// 核对：密码只经 stdin → 环境变量（命令行里没有）；后台导出写 .part、成功改名并 gzip；失败给中文说明 + 原文；列表 / 删除；预检的空间与工具判断。
// 取消要用 pkill（Git Bash 没有），在真机上验
const dir = mkdtempSync(join(tmpdir(), 'lingshell-bk-'))
const home = join(dir, 'home')
const PW = "S3cret pw'$x"
const sh = (name: string, body: string) => { writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`); chmodSync(join(dir, name), 0o755) }
sh('mysql', `in=$(cat); case "$in" in *information_schema.TABLES*) printf 'bytes\\n52428800\\n' ;; *) printf 'x\\n1\\n' ;; esac`)
sh('mysqldump', [
  `[ "$MYSQL_PWD" = ${JSON.stringify(PW).replace(/\$/g, '\\$')} ] || { echo "mysqldump: Got error: 1045: Access denied for user 'root'" >&2; exit 2; }`,
  'case "$*" in *faildb*) echo "mysqldump: Got error: 1044: Access denied to database faildb" >&2; exit 2 ;; esac',
  'echo "-- MySQL dump ARGS: $*"; for i in $(seq 1 2000); do echo "INSERT INTO t VALUES ($i,\'row $i\');"; done',
].join('\n'))
sh('pg_dump', 'printf "PGDMP-fake ARGS: %s\\n" "$*"')
sh('psql', `printf 'bytes\\n1048576\\n'`)
const shell = { file: LOCAL_SHELL.file, env: () => ({ ...LOCAL_SHELL.env(), HOME: home, PATH: `${dir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}` }) }
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const conns: DbConn[] = [
  { id: 'm', name: '订单库', hostKey: 'h1', kind: 'mysql', via: 'client', user: 'root', database: 'shop', secret: 'mysql-root' },
  { id: 'p', name: 'PG 库', hostKey: 'h1', kind: 'postgres', via: 'client', user: 'postgres', database: 'app' },
]
writeFileSync(join(dir, 'db-conns.json'), JSON.stringify(conns))
const hs = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
const audits: { command: string; decision: string; exitCode?: number }[] = []
const cmds: string[] = []
const run: DbRun = (cmd, o) => { cmds.push(cmd); return runSh(cmd, o, shell) }
registerDb({
  handle: (ch, fn) => { hs.set(ch, fn) },
  file: join(dir, 'db-conns.json'),
  host: (hk) => (hk === 'h1' ? { label: 'h1', prod: false } : undefined),
  run: () => run,
  password: () => PW,
  mask: (t) => t.split(PW).join('{{secret:mysql-root}}'),
  audit: (_hk, e) => { audits.push(e) },
})
const call = <T>(ch: string, ...a: unknown[]) => Promise.resolve().then(() => hs.get(ch)!({}, ...a)) as Promise<T>
const until = async (f: () => Promise<boolean>, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await f()) return true; await new Promise((r) => setTimeout(r, 300)) } return false }
const winPath = (p: string) => (process.platform === 'win32' ? p.replace(/^\/([a-z])\//i, '$1:/').replace(/^\/tmp\//, `${tmpdir().replace(/\\/g, '/')}/`) : p)

describe('数据库备份（真 shell + 假导出工具）', () => {
  it('预检：默认目录在 ~/lingshell-backups/<连接名> 下，工具在，估算大小与剩余空间都有', async () => {
    const p = await call<BackupPlan>('db:backupPlan', 'm', {})
    expect(p.dir.replace(/\\/g, '/')).toMatch(/\/home\/lingshell-backups\/_$|\/lingshell-backups\//)
    expect(p.tool).toBe(true)
    expect(p.estimateBytes).toBe(52428800)
    expect(p.freeBytes).toBeGreaterThan(0)
  })
  it('MySQL 备份：后台导出 + gzip，成功后改成正式文件名；密码不在命令行；记两条执行记录', async () => {
    const path = await call<string>('db:backupStart', 'm', { database: 'shop', tables: ['t_order'] })
    expect(path).toMatch(/shop-\d{8}-\d{6}\.sql\.gz$/)
    let st: BackupStatus[] = []
    expect(await until(async () => { st = await call<BackupStatus[]>('db:backupStatus', 'm'); return st[0]?.state !== 'running' })).toBe(true)
    expect(st[0]).toMatchObject({ state: 'ok', file: path })
    expect(st[0].bytes).toBeGreaterThan(1000)
    const sql = gunzipSync(readFileSync(winPath(path))).toString()
    expect(sql).toContain('ARGS: --single-transaction --quick --no-tablespaces --triggers --routines -u root shop t_order')
    expect(sql).toContain("INSERT INTO t VALUES (2000,'row 2000');")
    expect(existsSync(winPath(`${path}.part`))).toBe(false)
    expect(['.done', '.err', '.rc', '.pid'].filter((x) => existsSync(winPath(path + x)))).toEqual([])   // 状态文件读完即清
    for (const c of cmds) expect(c).not.toContain('S3cret')
    expect(audits.filter((a) => a.decision === 'db_backup').map((a) => a.command.slice(0, 6))).toEqual(['[备份开始]', '[备份完成]'])
    // 列表 + 删除
    const dirOf = path.slice(0, path.lastIndexOf('/'))
    const list = await call<BackupFile[]>('db:backupList', 'm', dirOf)
    expect(list.map((f) => f.name)).toEqual([path.slice(path.lastIndexOf('/') + 1)])
    await call('db:backupDelete', 'm', dirOf, list[0].name)
    expect(await call<BackupFile[]>('db:backupList', 'm', dirOf)).toEqual([])
  }, 60_000)
  it('导出失败：状态 fail + 中文说明 + 原文，不留 .part', async () => {
    const path = await call<string>('db:backupStart', 'm', { database: 'faildb' })
    let st: BackupStatus[] = []
    await until(async () => { st = await call<BackupStatus[]>('db:backupStatus', 'm'); return st.find((s) => s.file === path)?.state !== 'running' })
    const s = st.find((x) => x.file === path)!
    expect(s.state).toBe('fail')
    expect(s.error).toMatch(/用户名或密码不对，或账号没有导出权限[\s\S]*Access denied to database faildb/)
    expect(existsSync(winPath(path))).toBe(false)
    expect(existsSync(winPath(`${path}.part`))).toBe(false)   // 失败不能留半截文件
    expect(audits.at(-1)).toMatchObject({ decision: 'db_backup', exitCode: 1 })
  }, 60_000)
  it('PostgreSQL：pg_dump -Fc 不再 gzip，-t 指定表', async () => {
    const path = await call<string>('db:backupStart', 'p', { tables: ['orders', 'users'] })
    expect(path).toMatch(/app-\d{8}-\d{6}\.dump$/)
    await until(async () => (await call<BackupStatus[]>('db:backupStatus', 'p'))[0]?.state !== 'running')
    expect(readFileSync(winPath(path), 'utf8')).toContain('PGDMP-fake ARGS: -Fc -w -U postgres -t orders -t users -d app')
  }, 60_000)
  it('非法参数直接拒绝：库名 / 表名 / 目录', async () => {
    await expect(call('db:backupStart', 'm', { database: 'a;rm -rf /' })).rejects.toThrow(/库名/)
    await expect(call('db:backupStart', 'm', { database: 'shop', tables: ['x y'] })).rejects.toThrow(/表名/)
    await expect(call('db:backupStart', 'm', { database: 'shop', dir: '/tmp/../etc' })).rejects.toThrow(/备份目录/)
    await expect(call('db:backupDelete', 'm', '~/x', '../../etc/passwd')).rejects.toThrow(/非法/)
  })
})

describe('定时备份（同一套假工具；不自动跑，用「立即跑一次」驱动）', () => {
  const hs2 = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
  const pushes: { title: string; ok: boolean; lines: string[] }[] = []
  const notes: string[] = []
  let viaHost = 0
  const reg = registerDb({
    handle: (ch, fn) => { hs2.set(ch, fn) },
    file: join(dir, 'db-conns.json'),
    host: (hk) => (hk === 'h1' ? { label: 'h1', prod: false } : undefined),
    run: () => { throw new Error('定时任务不该走终端通道') },
    password: () => PW,
    mask: (t) => t.split(PW).join('{{secret:mysql-root}}'),
    audit: (_hk, e) => { audits.push(e) },
    schedulesFile: join(dir, 'db-backup-schedules.json'),
    withHost: (_hk, fn) => { viaHost++; return fn(run) },
    notify: (t) => { notes.push(t) },
    push: async (title, lines, _h, ok) => { pushes.push({ title, ok, lines }); return undefined },
    tickMs: 0, pollMs: 300,
  })
  afterAll(() => reg.stop())
  const call2 = <T>(ch: string, ...a: unknown[]) => Promise.resolve().then(() => hs2.get(ch)!({}, ...a)) as Promise<T>
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  it('保留 2 份：跑三次后只剩最近两份；成功推送「完成」，不弹系统通知；计划存盘', async () => {
    const s = await call2<{ lastRunAt: string }>('db:backupScheduleSave', 'm', { enabled: true, when: { kind: 'daily', time: '03:00' }, keep: 2, opts: { dir: '~/sched', database: 'shop' } })
    expect(s.lastRunAt).toBeTruthy()
    for (let i = 0; i < 3; i++) { await call2('db:backupScheduleRun', 'm'); await sleep(1100) }
    const last = await call2<{ lastResult: { ok: boolean; pruned: number; file: string } }>('db:backupScheduleGet', 'm')
    expect(last.lastResult).toMatchObject({ ok: true, pruned: 1 })
    const dirOf = last.lastResult.file.slice(0, last.lastResult.file.lastIndexOf('/'))
    expect((await call2<BackupFile[]>('db:backupList', 'm', dirOf).catch(() => null)) ?? (await call<BackupFile[]>('db:backupList', 'm', dirOf))).toHaveLength(2)
    expect(pushes.map((p) => [p.title, p.ok])).toEqual(Array(3).fill(['数据库定时备份完成：订单库', true]))
    expect(pushes[2].lines.join('|')).toMatch(/清理旧备份 1 份（保留 2 份）/)
    expect(notes).toEqual([])
    expect(viaHost).toBe(3)
    expect(audits.some((a) => a.command.startsWith('[删除备份·超出保留 2 份]'))).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, 'db-backup-schedules.json'), 'utf8'))[0]).toMatchObject({ connId: 'm', keep: 2, lastResult: { ok: true } })
  }, 90_000)
  it('失败：推送「失败」并弹系统通知，结果带原因', async () => {
    await call2('db:backupScheduleSave', 'm', { enabled: true, when: { kind: 'interval', hours: 6 }, keep: 3, opts: { dir: '~/sched', database: 'faildb' } })
    await call2('db:backupScheduleRun', 'm')
    const s = await call2<{ lastResult: { ok: boolean; error: string } }>('db:backupScheduleGet', 'm')
    expect(s.lastResult.ok).toBe(false)
    expect(s.lastResult.error).toMatch(/Access denied to database faildb/)
    expect(pushes.at(-1)).toMatchObject({ title: '数据库定时备份失败：订单库', ok: false })
    expect(notes).toEqual(['数据库定时备份失败：订单库'])
  }, 60_000)
  it('计划校验与删除', async () => {
    await expect(call2('db:backupScheduleSave', 'm', { when: { kind: 'daily', time: '3点' }, keep: 2, opts: { database: 'shop' } })).rejects.toThrow(/HH:MM/)
    expect(await call2('db:backupScheduleSave', 'm', null)).toBeNull()
    expect(await call2('db:backupScheduleGet', 'm')).toBeNull()
  })
})
