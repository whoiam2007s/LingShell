import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DbConn, DbScriptResult, DbTable, DbViewResult } from '@lingshell/shared'
import { LOCAL_SHELL } from '../terminal/index.js'
import { runSh } from '../terminal/index.js'
import { registerDb, type DbRun } from './dbIpc.js'

// 真 shell（Windows 用 Git Bash）+ PATH 里的假 mysql / psql / docker 脚本：核对密码只经 stdin → 环境变量传给客户端（命令行里没有），
// SQL 经 stdin 进客户端，输出按制表符解析；EXPLAIN 拒绝写语句（客户端都不会被调起）；终止会话的生产确认与执行记录
const dir = mkdtempSync(join(tmpdir(), 'lingshell-db-'))
const log = join(dir, 'calls.log')
const PW = "S3cret pw'$x"
const script = (body: string) => `#!/bin/bash\nin=$(cat)\n{ printf '%s ARGV:' "$(basename "$0")"; printf ' [%s]' "$@"; printf '\\nENV:%s|%s\\nENC:%s\\nSTDIN:%s\\n--\\n' "\${MYSQL_PWD-unset}" "\${PGPASSWORD-unset}" "\${PGCLIENTENCODING-unset}" "$in"; } >> "$FAKE_DB_LOG"\n${body}\n`
writeFileSync(join(dir, 'mysql'), script([
  `[ "$MYSQL_PWD" = ${JSON.stringify(PW).replace(/\$/g, '\\$')} ] || { echo "ERROR 1045 (28000): Access denied for user 'root'@'localhost'" >&2; exit 1; }`,
  'case "$in" in',
  "  *PROCESSLIST*) printf 'ID\\tUSER\\tHOST\\tDB\\tCOMMAND\\tTIME\\tSTATE\\tINFO\\n12\\tapp\\tweb1:5555\\tshop\\tQuery\\t35\\tSending data\\tselect * from t_order\\\\nwhere 1\\n' ;;",
  "  *EXPLAIN*) printf 'id\\tselect_type\\ttable\\ttype\\tkey\\trows\\n1\\tSIMPLE\\tt_order\\tALL\\tNULL\\t500000\\n' ;;",
  "  *bigq*) printf 'id\\tv\\n'; awk 'BEGIN { for (i = 1; i <= 800000; i++) printf \"%d\\tabcdefgh\\n\", i }' ;;",
  "  *'SHOW DATABASES'*) printf 'Database\\nshop\\ncrm\\n' ;;",
  "  *information_schema.TABLES*) printf 'name\\ttype\\tengine\\trows_est\\tmb\\tcomment\\nt_order\\tBASE TABLE\\tInnoDB\\t10\\t0.02\\t订单\\n' ;;",
  "  *information_schema.COLUMNS*) printf 'name\\ttype\\tnullable\\tkey\\tdefault\\textra\\tcomment\\nid\\tint\\tNO\\tPRI\\tNULL\\tauto_increment\\t\\n' ;;",
  "  *information_schema.STATISTICS*) printf 'name\\tuniq\\tcolumns\\ttype\\nPRIMARY\\tUNIQUE\\tid\\tBTREE\\n' ;;",
  "  *'SHOW CREATE TABLE'*) printf 'Table\\tCreate Table\\nt_order\\tCREATE TABLE `t_order` (\\\\n  `id` int\\\\n)\\n' ;;",
  "  *'from t_order'*) printf 'id\\tnote\\n1\\ta\\\\nb\\n2\\tNULL\\n' ;;",
  "  *'from many'*) printf 'id\\tv\\n'; for i in $(seq 1 300); do printf '%d\\tx%d\\n' $i $i; done ;;",
  '  KILL*) ;;',
  `  *BADSQL*) printf 'Query OK, 1 row affected\\n'; echo "ERROR 1064 (42000) at line 3: You have an error near 'BADSQL'" >&2; exit 1 ;;`,
  `  START\\ TRANSACTION*) printf 'Query OK, 2 rows affected\\n' ;;`,
  "  *) echo \"ERROR 1064: unexpected $in\" >&2; exit 1 ;;",
  'esac',
].join('\n')))
writeFileSync(join(dir, 'psql'), script([
  'case "$in" in',
  "  *pg_terminate_backend*) printf 'terminated\\nf\\n' ;;",
  `  *BIGOUT*) echo "PGO=\${PGOPTIONS-unset}"; head -c 1500000 /dev/zero | tr '\\0' 'x'; printf '\\nUPDATE 7\\n' ;;`,
  `  *q_csv*) case " $* " in *' --csv '*) printf 'id,note\\n1,"多\\n行"\\n2,\\n' ;; *) echo "psql: unrecognized option '--csv'" >&2; exit 1 ;; esac ;;`,
  "  *) printf 'version\\nPostgreSQL 16.2\\n' ;;",
  'esac',
].join('\n')))
// 假 redis-cli：去掉连接参数后按命令回复（--no-raw 格式）；中文 key 按真 redis-cli 的样子输出成 \xHH
writeFileSync(join(dir, 'redis-cli'), script([
  'while [ $# -gt 0 ]; do case "$1" in -n|-h|-p|--user) shift 2 ;; --no-auth-warning|--no-raw) shift ;; *) break ;; esac; done',
  'case "$*" in',
  "  'INFO keyspace') printf '# Keyspace\\r\\ndb0:keys=3,expires=0,avg_ttl=0\\r\\ndb2:keys=1,expires=0\\r\\n' ;;",
  "  'CLIENT LIST') printf 'id=3 addr=10.0.0.5:5000 laddr=x fd=8 name=web age=100 idle=2 flags=N db=0 cmd=get user=default\\nid=9 addr=127.0.0.1:1 name= age=0 idle=0 flags=N db=0 cmd=client|list user=default\\n' ;;",
  "  'CLIENT KILL ID 3') echo '(integer) 1' ;;",
  "  'CLIENT KILL ID'*) echo '(integer) 0' ;;",
  "  'SCAN 0 MATCH '*) printf '1) \"17\"\\n2) 1) \"user:1\"\\n' ;;",
  "  'SCAN 17 MATCH '*) printf '1) \"0\"\\n2) 1) \"\\\\xe8\\\\xae\\\\xa2\\\\xe5\\\\x8d\\\\x95:1\"\\n' ;;",
  "  'TYPE user:1') echo hash ;;",
  "  'TYPE 订单:1') echo string ;;",
  "  TYPE*) echo none ;;",
  "  TTL*) echo '(integer) -1' ;;",
  "  'MEMORY USAGE'*) echo '(error) ERR unknown command' ;;",
  "  'HLEN user:1') echo '(integer) 2' ;;",
  "  'HSCAN user:1 0 COUNT 100') printf '1) \"0\"\\n2) 1) \"name\"\\n   2) \"张三\"\\n   3) \"age\"\\n   4) \"3\"\\n' ;;",
  "  'STRLEN 订单:1') echo '(integer) 5' ;;",
  "  'GETRANGE 订单:1 0 65535') echo '\"hello\"' ;;",
  "  'DEL 订单:1') echo '(integer) 1' ;;",
  "  DEL*) echo '(integer) 0' ;;",
  '  *) echo "(error) ERR unknown $*" ;;',
  'esac',
].join('\n')))
// 假 mongosh：脚本在最后一个参数（--eval），按我们生成脚本里的 /*ls:xxx*/ 标记回复；记下环境变量里的密码和脚本
writeFileSync(join(dir, 'mongosh'), [
  '#!/bin/bash',
  'js="${@: -1}"',
  `{ printf 'mongosh ARGC:%s PWD:%s\\nJS:%s\\n--\\n' "$#" "\${MONGO_PWD-unset}" "$js"; } >> "$FAKE_DB_LOG"`,
  'case "$js" in',
  "  *'/*ls:version*/'*) echo '@@json \"7.0.12\"' ;;",
  "  *'/*ls:databases*/'*) echo '@@json [\"admin\",\"app\",\"logs\"]' ;;",
  "  *'/*ls:currentop*/'*) echo '@@doc {\"opid\":4711,\"secs\":42,\"op\":\"query\",\"ns\":\"app.orders\",\"waitingForLock\":false}' ;;",
  "  *'/*ls:replstatus*/'*) echo '@@json {\"error\":\"not running with --replSet\"}' ;;",
  "  *'/*ls:killop*/'*) echo '@@json {\"ok\":1,\"info\":\"attempting to kill op\"}' ;;",
  "  *'/*ls:collections*/'*) echo '@@doc {\"name\":\"orders\",\"type\":\"collection\",\"rows_est\":3,\"mb\":null,\"comment\":\"\"}' ;;",
  "  *'/*ls:collschema*/'*) echo '@@json {\"type\":\"collection\",\"options\":{},\"indexes\":[{\"v\":2,\"key\":{\"_id\":1},\"name\":\"_id_\"}],\"sampled\":3,\"fields\":[{\"field\":\"_id\",\"types\":\"ObjectId\",\"seen\":\"100%\"}]}' ;;",
  "  *\"explain('executionStats')\"*) echo '@@json {\"queryPlanner\":{\"namespace\":\"app.orders\",\"winningPlan\":{\"stage\":\"COLLSCAN\"}},\"executionStats\":{\"nReturned\":1,\"totalDocsExamined\":3,\"executionTimeMillis\":0}}' ;;",
  "  *'/*ls:find*/'*) printf '%s\\n' 'Warning: something' '@@doc {\"_id\":{\"$oid\":\"64b7f0c2a1b2c3d4e5f60718\"},\"st\":\"paid\",\"at\":{\"$date\":\"2024-01-01T00:00:00Z\"}}' '@@doc {\"_id\":{\"$oid\":\"64b7f0c2a1b2c3d4e5f60719\"},\"st\":\"paid\",\"items\":[1,2]}' ;;",
  "  *'/*ls:'*) echo \"MongoServerError: unexpected\" >&2; exit 1 ;;",
  "  *) echo 'script ran' ;;",
  'esac',
].join('\n'))
for (const f of ['mysql', 'psql', 'redis-cli', 'mongosh']) chmodSync(join(dir, f), 0o755)
const shell = { file: LOCAL_SHELL.file, env: () => ({ ...LOCAL_SHELL.env(), PATH: `${dir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`, FAKE_DB_LOG: log }) }
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const conns: DbConn[] = [
  { id: 'm', name: '订单库', hostKey: 'local', kind: 'mysql', via: 'client', user: 'root', secret: 'mysql-root' },
  { id: 'p', name: '生产 PG', hostKey: 'prod1', kind: 'postgres', via: 'client', user: 'postgres' },
  { id: 'r', name: '缓存', hostKey: 'local', kind: 'redis', via: 'client' },
  { id: 'rp', name: '生产缓存', hostKey: 'prod1', kind: 'redis', via: 'client' },
  { id: 'g', name: '日志库', hostKey: 'local', kind: 'mongo', via: 'client', user: 'ops', database: 'app', secret: 'mysql-root' },
]
writeFileSync(join(dir, 'db-conns.json'), JSON.stringify(conns))
const hs = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
const audits: { hostKey: string; command: string; decision: string; exitCode?: number }[] = []
const cmds: string[] = []
const run: DbRun = (cmd, o) => { cmds.push(cmd); return runSh(cmd, o, shell) }
registerDb({
  handle: (ch, fn) => { hs.set(ch, fn) },
  file: join(dir, 'db-conns.json'),
  schedulesFile: join(dir, 'db-schedules.json'),
  tickMs: 0,
  host: (hk) => (hk === 'local' ? { label: '本机', prod: false } : hk === 'prod1' ? { label: 'prod1', prod: true } : undefined),
  run: () => run,
  password: (_hk, name) => { if (name !== 'mysql-root') throw new Error('没有这个密钥'); return PW },
  mask: (t) => t.split(PW).join('{{secret:mysql-root}}'),
  audit: (hostKey, e) => { audits.push({ hostKey, ...e }) },
})
const call = <T>(ch: string, ...a: unknown[]) => Promise.resolve().then(() => hs.get(ch)!({}, ...a)) as Promise<T>
const calls = () => { try { return readFileSync(log, 'utf8') } catch { return '' } }

describe('数据库快查（真 shell + 假客户端）', () => {
  it('会话列表：密码经环境变量、SQL 经 stdin，命令行里没有密码；-B 转义还原', async () => {
    const r = await call<DbViewResult>('db:view', 'm', 'sessions')
    expect(r.tables?.[0].table.columns[0]).toBe('ID')
    expect(r.tables?.[0].table.rows[0]).toEqual(['12', 'app', 'web1:5555', 'shop', 'Query', '35', 'Sending data', 'select * from t_order\nwhere 1'])
    const c = calls()
    expect(c).toContain(`ENV:${PW}|unset`)
    expect(c).toContain('information_schema.PROCESSLIST')
    expect(c).toMatch(/mysql ARGV: \[--binary-mode\] \[--default-character-set=utf8mb4\] \[-B\] \[--connect-timeout=8\] \[-u\] \[root\]/)
    for (const cmd of cmds) expect(cmd).not.toContain('S3cret')
  })
  it('密码不对 → 中文说明 + 原文', async () => {
    await expect(call('db:ping', { ...conns[0], secret: undefined })).rejects.toThrow(/用户名或密码不对[\s\S]*Access denied/)
  })
  it('EXPLAIN：SELECT 放行并解析；写语句直接拒绝，客户端不会被调起', async () => {
    const r = await call<{ text: string; sql: string }>('db:explain', 'm', 'select * from t_order where user_id = 1;')
    expect(r.sql).toBe('select * from t_order where user_id = 1')
    expect(r.text).toBe('#1 id=1  select_type=SIMPLE  table=t_order  type=ALL  rows=500000')
    expect(calls()).toContain('SET SESSION TRANSACTION READ ONLY;\nEXPLAIN select * from t_order where user_id = 1')
    const n = cmds.length
    await expect(call('db:explain', 'm', 'DELETE FROM t_order')).rejects.toThrow(/只能 EXPLAIN 查询语句/)
    await expect(call('db:explain', 'm', 'select 1; drop table t')).rejects.toThrow(/一条语句/)
    expect(cmds.length).toBe(n)
  })
  it('终止会话：记执行记录；生产主机没有二次确认不执行；PG 返回 f 视为失败', async () => {
    await call('db:kill', 'm', 12, 'app@web1 select', false)
    expect(calls()).toMatch(/STDIN:KILL 12\n;/)
    expect(audits.at(-1)).toEqual({ hostKey: 'local', command: 'KILL 12  # MySQL「订单库」 app@web1 select', decision: 'db_kill', exitCode: 0 })
    const n = cmds.length
    await expect(call('db:kill', 'p', 99, '', false)).rejects.toThrow(/二次确认/)
    expect(cmds.length).toBe(n)
    await expect(call('db:kill', 'p', 99, '', true)).rejects.toThrow(/没有终止/)
    expect(audits.at(-1)).toMatchObject({ hostKey: 'prod1', decision: 'db_kill', exitCode: 1 })
    expect(calls()).toContain('psql ARGV: [-X] [-w] [-q] [-A] [-F] [\t]')
  })
  it('执行脚本：整体事务包装、末尾补分号、输出给人看；失败返回已执行输出 + 回正的行号；都记执行记录', async () => {
    const ok = await call<DbScriptResult>('db:script', 'm', 'UPDATE t SET a = 1 WHERE id = 2;\nDELETE FROM t WHERE id = 3', true, false)
    expect(ok).toMatchObject({ ok: true, rc: 0, output: 'Query OK, 2 rows affected', error: '' })
    expect(calls()).toContain('STDIN:START TRANSACTION;\nUPDATE t SET a = 1 WHERE id = 2;\nDELETE FROM t WHERE id = 3\n;\nDELIMITER ;\nCOMMIT;')
    expect(calls()).toMatch(/mysql ARGV: \[--binary-mode\] \[--default-character-set=utf8mb4\] \[-t\] \[-vvv\]/)
    expect(audits.at(-1)).toMatchObject({ hostKey: 'local', decision: 'db_script', exitCode: 0, command: expect.stringMatching(/^\[脚本 2 条：UPDATE 1、DELETE 1，整体事务\] UPDATE t SET/) })
    const bad = await call<DbScriptResult>('db:script', 'm', 'select 1;\nselect 2;\nBADSQL;', true, false)
    expect(bad).toMatchObject({ ok: false, rc: 1, output: 'Query OK, 1 row affected' })
    expect(bad.error).toContain("at line 2: You have an error near 'BADSQL'")
    expect(audits.at(-1)).toMatchObject({ decision: 'db_script', exitCode: 1 })
    for (const cmd of cmds) expect(cmd).not.toContain('S3cret')
  })
  it('执行脚本：在上方切到的库上执行（-D），执行记录里写明库', async () => {
    const r = await call<DbScriptResult>('db:script', 'm', 'UPDATE t SET a = 1 WHERE id = 2', true, false, 'crm')
    expect(r.ok).toBe(true)
    expect(calls()).toMatch(/mysql ARGV: [^\n]*\[-D\] \[crm\][^\n]*\nENV:[^\n]*\nENC:[^\n]*\nSTDIN:START TRANSACTION;\nUPDATE t SET a = 1 WHERE id = 2/)
    expect(audits.at(-1)?.command).toMatch(/# MySQL「订单库」 库 crm$/)
    await expect(call('db:script', 'm', 'select 1', true, false, "a';x")).rejects.toThrow(/库名/)
  })
  it('执行脚本：生产主机要二次确认；PG 不加只读闸、-1 整体事务；超大输出只留首尾且退出码不丢', async () => {
    const n = cmds.length
    await expect(call('db:script', 'p', 'BIGOUT;', true, false)).rejects.toThrow(/二次确认/)
    expect(cmds.length).toBe(n)
    const r = await call<DbScriptResult>('db:script', 'p', 'BIGOUT;', true, true)
    expect(r.ok).toBe(true)
    expect(r.output.startsWith('PGO=unset\nxxx')).toBe(true)
    expect(r.output).toMatch(/…（中间省略 \d+ 字节）…/)
    expect(r.output.endsWith('UPDATE 7')).toBe(true)
    expect(r.output.length).toBeLessThan(1_400_000)
    expect(calls()).toContain('psql ARGV: [-X] [-w] [-b] [-v] [ON_ERROR_STOP=1] [-1] [-U] [postgres] [-f] [-]')
    expect(calls()).toContain('ENC:UTF8')
    await expect(call('db:script', 'm', '   ', true, false)).rejects.toThrow(/空/)
  })
  it('连接增删改：密码只存名称', async () => {
    const list = await call<DbConn[]>('db:save', { name: '缓存', hostKey: 'local', kind: 'redis', via: 'docker', container: 'redis1', secret: '{{secret:redis-pw}}' })
    expect(list.at(-1)).toMatchObject({ kind: 'redis', container: 'redis1', secret: 'redis-pw' })
    expect(readFileSync(join(dir, 'db-conns.json'), 'utf8')).toContain('"secret": "redis-pw"')
    await expect(call('db:save', { name: 'x', hostKey: 'gone', kind: 'mysql' })).rejects.toThrow(/主机不存在/)
    expect((await call<DbConn[]>('db:delete', list.at(-1)!.id)).length).toBe(5)
  })
  it('删连接连带删它的定时备份计划', async () => {
    const list = await call<DbConn[]>('db:save', { name: '临时', hostKey: 'local', kind: 'mysql', via: 'client' })
    const id = list.at(-1)!.id
    await call('db:backupScheduleSave', id, { enabled: true, when: { kind: 'daily', time: '03:00' }, keep: 2, opts: { database: 'shop' } })
    expect(readFileSync(join(dir, 'db-schedules.json'), 'utf8')).toContain(id)
    await call('db:delete', id)
    expect(readFileSync(join(dir, 'db-schedules.json'), 'utf8')).not.toContain(id)
  })
  it('输出超过上限：截断而不是报错，表格标 truncated，最后一行完整', async () => {
    const r = await call<{ table: DbTable }>('db:query', 'm', 'select * from bigq')
    expect(r.table.truncated).toBe(true)
    expect(r.table.columns).toEqual(['id', 'v'])
    expect(r.table.rows.length).toBeGreaterThan(50_000)
    expect(r.table.rows.at(-1)).toEqual([String(r.table.rows.length), 'abcdefgh'])
  })
  it('即席查询：只读校验（写语句不调客户端）、MySQL 只读事务、-B 转义还原、切库 -D', async () => {
    const r = await call<{ sql: string; table: DbTable }>('db:query', 'm', 'select id, note from t_order;', 'crm')
    expect(r.table).toEqual({ columns: ['id', 'note'], rows: [['1', 'a\nb'], ['2', 'NULL']] })
    expect(calls()).toContain('STDIN:SET SESSION TRANSACTION READ ONLY;\nselect id, note from t_order\n;')
    expect(calls()).toMatch(/\[-D\] \[crm\]/)
    const n = cmds.length
    await expect(call('db:query', 'm', 'delete from t_order')).rejects.toThrow(/只读/)
    await expect(call('db:query', 'm', 'select 1', "x';rm")).rejects.toThrow(/库名/)
    expect(cmds.length).toBe(n)
  })
  it('查询分页：补 LIMIT n+1 OFFSET，只返回这一页并标 hasMore；用户自己写 LIMIT 的不动', async () => {
    const p = await call<{ table: DbTable; paged?: { offset: number; limit: number; hasMore: boolean } }>('db:query', 'm', 'select * from many', undefined, { offset: 0, limit: 100 })
    expect(p.paged).toEqual({ offset: 0, limit: 100, hasMore: true })
    expect(p.table.rows).toHaveLength(100)
    expect(calls()).toMatch(/STDIN:SET SESSION TRANSACTION READ ONLY;\nselect \* from many\nLIMIT 101\n;\n/)
    const p2 = await call<{ table: DbTable; paged?: { offset: number } }>('db:query', 'm', 'select * from many', undefined, { offset: 100, limit: 100 })
    expect(p2.paged?.offset).toBe(100)
    expect(calls()).toMatch(/select \* from many\nLIMIT 101 OFFSET 100\n;\n/)
    const own = await call<{ paged?: unknown }>('db:query', 'm', 'select * from t_order limit 2')
    expect(own.paged).toBeUndefined()
    expect(await call('db:query', 'm', 'select * from t_order', undefined, { offset: 0, limit: 99999 })).toMatchObject({ paged: { limit: 1000 } })   // 上限 1000
  }, 60_000)
  it('PG 即席查询用 --csv 保住换行；--csv 不认时退回非对齐输出', async () => {
    const r = await call<{ table: DbTable }>('db:query', 'p', 'select * from q_csv')
    expect(r.table).toEqual({ columns: ['id', 'note'], rows: [['1', '多\n行'], ['2', '']] })
  })
  it('库列表 / 表列表 / 表结构（MySQL SHOW CREATE）', async () => {
    expect(await call('db:databases', 'm')).toEqual([{ name: 'shop' }, { name: 'crm' }])
    const tl = await call<DbTable>('db:schemaTables', 'm', 'shop')
    expect(tl.rows[0].slice(0, 2)).toEqual(['t_order', 'BASE TABLE'])
    expect(calls()).toContain("table_schema = 'shop'")
    const s = await call<{ columns: DbTable; indexes: DbTable; ddl: string }>('db:schemaTable', 'm', 'shop', { name: 't_order' })
    expect(s.columns.rows[0][0]).toBe('id')
    expect(s.indexes.rows[0]).toEqual(['PRIMARY', 'UNIQUE', 'id', 'BTREE'])
    expect(s.ddl).toBe('CREATE TABLE `t_order` (\n  `id` int\n)')
    await expect(call('db:schemaTable', 'm', 'shop', { name: 'a`b' })).rejects.toThrow(/非法/)
  })
  it('Redis：库列表带 key 数、客户端列表、断开客户端（记执行记录）', async () => {
    const dbs = await call<{ name: string; keys: number }[]>('db:databases', 'r')
    expect(dbs.length).toBe(16)
    expect(dbs[0]).toEqual({ name: '0', keys: 3 })
    expect(dbs[2]).toEqual({ name: '2', keys: 1 })
    const v = await call<DbViewResult>('db:view', 'r', 'clients')
    expect(v.tables?.[0].table.rows).toEqual([['3', '10.0.0.5:5000', 'web', 'default', '0', '100', '2', 'N', 'get']])
    await call('db:kill', 'r', 3, 'web 10.0.0.5', false)
    expect(audits.at(-1)).toMatchObject({ decision: 'db_kill', exitCode: 0, command: expect.stringMatching(/^CLIENT KILL ID 3/) })
    await expect(call('db:kill', 'r', 99, '', false)).rejects.toThrow(/已经断开/)
  }, 60_000)
  it('Redis Key：SCAN 分批续扫、中文 key 原样传回、按类型预览、删除要生产确认并记录', async () => {
    const s = await call<{ cursor: string; keys: string[] }>('db:redisScan', 'r', '2', 'user:*', '0')
    expect(s).toEqual({ cursor: '0', keys: ['user:1', '订单:1'] })
    expect(calls()).toMatch(/redis-cli ARGV: \[--no-auth-warning\] \[-n\] \[2\] \[--no-raw\] \[SCAN\] \[0\] \[MATCH\] \[user:\*\]/)
    const h = await call<{ type: string; size: number; value: DbTable; bytes?: number; partial: boolean }>('db:redisKey', 'r', '', 'user:1')
    expect(h).toMatchObject({ type: 'hash', size: 2, partial: false, value: { columns: ['field', 'value'], rows: [['name', '张三'], ['age', '3']] } })
    expect(h.bytes).toBeUndefined()
    expect(await call('db:redisKey', 'r', '', '订单:1')).toMatchObject({ type: 'string', ttl: -1, size: 5, value: 'hello' })
    await expect(call('db:redisKey', 'r', '', 'gone')).rejects.toThrow(/不存在/)
    await expect(call('db:redisKey', 'r', '', 'a\nb')).rejects.toThrow(/非法/)
    const n = cmds.length
    await expect(call('db:redisDel', 'rp', '', 'x', false)).rejects.toThrow(/二次确认/)
    expect(cmds.length).toBe(n)
    await call('db:redisDel', 'r', '', '订单:1', false)
    expect(audits.at(-1)).toMatchObject({ decision: 'db_key_del', exitCode: 0, command: 'DEL "订单:1"  # Redis「缓存」' })
    await expect(call('db:redisDel', 'r', '', 'nope', false)).rejects.toThrow(/不存在/)
    expect(audits.at(-1)).toMatchObject({ decision: 'db_key_del', exitCode: 1 })
  }, 60_000)
  it('MongoDB：密码只经环境变量，查询解析成 EJSON 再拼脚本；视图 / 结构 / EXPLAIN / 终止操作 / 脚本', async () => {
    expect(await call('db:ping', conns.find((c) => c.id === 'g'))).toBe('7.0.12')
    expect(await call('db:databases', 'g')).toEqual([{ name: 'admin' }, { name: 'app' }, { name: 'logs' }])
    const q = await call<{ sql: string; table: DbTable }>('db:query', 'g', "db.orders.find({ st: 'paid', _id: { $gt: ObjectId('64b7f0c2a1b2c3d4e5f60700') } }).limit(5);", 'logs')
    expect(q.sql).toBe("db.orders.find({ st: 'paid', _id: { $gt: ObjectId('64b7f0c2a1b2c3d4e5f60700') } }).limit(5)")
    expect(q.table).toEqual({ columns: ['_id', 'st', 'at', 'items'], rows: [['ObjectId("64b7f0c2a1b2c3d4e5f60718")', 'paid', '2024-01-01T00:00:00Z', ''], ['ObjectId("64b7f0c2a1b2c3d4e5f60719")', 'paid', '', '[1,2]']] })
    const log1 = calls()
    expect(log1).toContain(`mongosh ARGC:5 PWD:${PW}`)
    expect(log1).toContain('db = __conn.getDB("logs")')   // 切到的库
    expect(log1).toContain('EJSON.parse("{\\"st\\":\\"paid\\",\\"_id\\":{\\"$gt\\":{\\"$oid\\":\\"64b7f0c2a1b2c3d4e5f60700\\"}}}")')
    for (const cmd of cmds) expect(cmd).not.toContain('S3cret')
    const n = cmds.length
    await expect(call('db:query', 'g', 'db.orders.deleteMany({})')).rejects.toThrow(/只读查询只支持/)
    await expect(call('db:query', 'g', 'db.orders.find({ $where: "1" })')).rejects.toThrow(/\$where/)
    expect(cmds.length).toBe(n)
    const v = await call<DbViewResult>('db:view', 'g', 'sessions')
    expect(v.tables?.[0].table.rows[0].slice(0, 3)).toEqual(['4711', '42', 'query'])
    expect((await call<DbViewResult>('db:view', 'g', 'repl')).note).toMatch(/不是副本集/)
    expect((await call<DbTable>('db:schemaTables', 'g', 'app')).rows[0][0]).toBe('orders')
    expect((await call<{ ddl: string }>('db:schemaTable', 'g', 'app', { name: 'orders' })).ddl).toBe('db.createCollection("orders")')
    expect((await call<{ text: string }>('db:explain', 'g', 'db.orders.find({ st: "paid" })')).text).toMatch(/COLLSCAN/)
    await call('db:kill', 'g', 4711, 'query app.orders', false)
    expect(audits.at(-1)).toMatchObject({ decision: 'db_kill', exitCode: 0, command: expect.stringMatching(/^db\.killOp\(4711\) {2}# MongoDB「日志库」/) })
    const s = await call<DbScriptResult>('db:script', 'g', 'printjson(db.orders.countDocuments({}))', true, false)
    expect(s).toMatchObject({ ok: true, output: 'script ran' })
    expect(calls()).toMatch(/JS:var __hp[\s\S]*printjson\(db\.orders\.countDocuments\(\{\}\)\)/)
    await expect(call('db:script', 'g', 'x'.repeat(200 * 1024), true, false)).rejects.toThrow(/100KB/)
  }, 60_000)
})
