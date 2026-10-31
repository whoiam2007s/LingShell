// 数据库快查（见 shared/db/dbQuick.ts、sqlReadonly.ts、slowlogDigest.ts）：连接配置存数据目录 db-conns.json（密码只存密钥保险箱的名称）。
// 查询在连接所属的机器上调用命令行客户端：SSH 主机 = 该主机已打开终端的独立 exec channel，本机 = 后台 sh 子进程，都不在用户终端里刷屏。
// 密码在这里取明文作为 stdin 第一行传入（不进命令行 / 日志）；输出里出现的密钥明文换回占位符。
// 默认只读：视图的语句是固定的，EXPLAIN 只放 SELECT，即席查询只放单条只读语句（再加会话只读事务）；写操作只有终止会话（KILL / pg_terminate_backend / CLIENT KILL）、
// 删除 Redis key（db:redisDel）和执行脚本（db:script），生产主机要二次确认，记执行记录。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  DB_BIGKEYS_TIMEOUT_MS, DB_KILL_DECISION, DB_TIMEOUT_MS, MYSQL_SQL, PG_SQL, REDIS_ARGS, REDIS_SUMMARY_KEYS,
  dbAuditCommand, dbCommand, dbErrorText, dbKillSql, digestSlow, explainInput, explainText, isDbSessionId, isDbView, mysqlTimeToSec,
  parseBigkeys, parseDbTable, parseMysqlSlowLog, parseRedisInfo, parseRedisReply, redisSlowlogTable, sanitizeDbConn, sanitizeDbConns,
  slowlogTailCommand, splitDbOutput, tableToKv,
  DB_SCRIPT_DECISION, DB_SCRIPT_MAX, DB_SCRIPT_TIMEOUT_MS, checkScript, fixScriptLines, scriptAuditCommand, scriptInput,
  BACKUP_DECISION, DB_KIND_LABEL, backupCancelCommand, backupCleanupCommand, backupDeleteCommand, backupErrorText, backupEstimateSql, backupFileName, backupListCommand, backupProbeCommand,
  backupSpaceCheck, backupStartCommand, backupStatusCommand, checkBackupOpts, isBackupDir, isBackupName, parseBackupList, parseBackupProbe, parseBackupStatus,
  backupsToPrune, sanitizeBackupSchedule,
  DB_LIST_SQL, REDIS_KEY_DEL_DECISION, isRedisCursor, isRedisKey, parseCsvTable, parseRedisClients, pgDdl, queryInput, redisErrorOf, redisKeyCmds, redisKeyspace,
  redisPreviewTable, schemaTableSql, schemaTablesSql, shq, withDatabase,
  MONGO_SCRIPT_MAX, MONGO_VIEW_JS, docsToTable, isDbIdent, mongoExplain, mongoJs, mongoPageable, mongoParseOut, mongoQueryBody, mongoQueryText, mongoSchemaDetail, mongoViewResult, parseMongoQuery,
  DB_PAGE_MAX, DB_PAGE_SIZE, tr,
  type DbDatabase, type DbPage, type DbQueryResult, type DbSchemaDetail, type DbTableRef, type RedisKeyInfo, type RedisReply,
  type BackupOpts, type BackupPlan, type BackupSchedule, type BackupStatus,
  type DbConn, type DbExplainResult, type DbScriptResult, type DbTable, type DbViewResult, type SlowEntry,
} from '@lingshell/shared'
import type { ExecFullResult } from '@lingshell/terminal-core'
import { nextRunAt } from '../ops/index.js'

export type DbRun = (command: string, o: { timeoutMs: number; maxBytes?: number; stdin?: string }) => Promise<ExecFullResult>
export interface DbIpcDeps {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  file: string
  /** 'local' → 本机；主机 id → 显示名 + 是否生产；主机已删除 → undefined */
  host(hostKey: string): { label: string; prod: boolean } | undefined
  /** 该机器的独立通道（SSH 主机没有打开着的终端时抛错） */
  run(hostKey: string): DbRun
  /** 密钥保险箱取明文（按可用范围校验，不能用时抛错） */
  password(hostKey: string, name: string): string
  /** 明文 → 占位符 */
  mask(text: string): string
  audit(hostKey: string, entry: { command: string; decision: string; exitCode?: number }): void
  // ── 定时备份（不传 schedulesFile 就不启用）──
  schedulesFile?: string
  /** 无人值守时拿一个通道：有在线终端就复用，没有就临时连接、用完断开（默认 = run(hostKey)） */
  withHost?<T>(hostKey: string, fn: (run: DbRun) => Promise<T>): Promise<T>
  notify?(title: string, body: string): void
  /** 群机器人；ok = 成功（推送用「正常」状态） */
  push?(title: string, lines: string[], hosts: string[], ok: boolean): Promise<string | undefined>
  now?(): number
  tickMs?: number               // 调度检查间隔（默认 60 秒；0 = 不自动跑，测试用 db:backupScheduleRun）
  pollMs?: number               // 定时任务查进度间隔（默认 10 秒）
}

const MAX_OUT = 8 * 1024 * 1024   // 要比 DB_OUT_LIMIT 大（截断标记和结束标记要放得下）

export function loadDbConns(file: string): DbConn[] {
  try { return existsSync(file) ? sanitizeDbConns(JSON.parse(readFileSync(file, 'utf8'))) : [] } catch { return [] }
}
function saveDbConns(file: string, list: DbConn[]): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(`${file}.tmp`, JSON.stringify(list, null, 1), 'utf8')
  renameSync(`${file}.tmp`, file)
}

export function createDbQuery(d: Pick<DbIpcDeps, 'run' | 'password' | 'mask'>) {
  // 跑一次客户端：input = 给客户端的 stdin（SQL），extra = redis-cli 的命令；客户端失败抛「说明 + 原文」
  const execT = async (c: DbConn, input: string, extra: string[] = [], timeoutMs = DB_TIMEOUT_MS, csv = false): Promise<{ out: string; truncated?: boolean }> => {
    const pw = c.secret ? d.password(c.hostKey, c.secret) : ''
    if (/[\r\n]/.test(pw)) throw new Error(tr('密钥保险箱里的这个密码含换行，不能用作数据库密码'))
    const r = await d.run(c.hostKey)(dbCommand(c, extra, undefined, csv), { timeoutMs, maxBytes: MAX_OUT, stdin: `${pw}\n${input}` })
    if (r.stopped === 'timeout') throw new Error(tr('执行超时（{n} 秒）', { n: Math.round(timeoutMs / 1000) }))
    const s = splitDbOutput(r.output)
    if (s.rc !== 0) throw new Error(d.mask(dbErrorText(c, s.err || (s.rc === undefined ? s.stdout.slice(-2000) : ''), s.rc)))
    return { out: d.mask(s.stdout), truncated: s.truncated }
  }
  const exec = async (c: DbConn, input: string, extra: string[] = [], timeoutMs = DB_TIMEOUT_MS): Promise<string> => (await execT(c, input, extra, timeoutMs)).out
  // redis-cli --no-raw：错误回复退出码也是 0，这里转成异常
  const redis = async (c: DbConn, args: string[]): Promise<RedisReply> => {
    const out = await exec(c, '', ['--no-raw', ...args])
    const e = redisErrorOf(out)
    if (e) throw new Error(dbErrorText(c, e))
    return parseRedisReply(out)
  }
  const sql = async (c: DbConn, q: string): Promise<DbTable> => {
    const r = await execT(c, `${q}\n;\n`)
    const t = parseDbTable(r.out, c.kind === 'postgres' ? 'postgres' : 'mysql')
    return r.truncated ? { ...t, truncated: true } : t
  }
  const trySql = (c: DbConn, q: string) => sql(c, q).then((t) => ({ t }), (e: Error) => ({ e }))
  const ret = (title: string | undefined, table: DbTable): DbViewResult => ({ tables: [{ title, table }] })

  // MongoDB：跑一段生成的 mongosh 脚本（连接开头见 mongoQuick.mongoPrelude），输出按 @@json / @@doc 行解析
  const mongo = async (c: DbConn, body: string, timeoutMs = DB_TIMEOUT_MS) => {
    const r = await execT(c, mongoJs(c, body), [], timeoutMs)
    return { ...mongoParseOut(r.out), truncated: r.truncated }
  }

  async function version(c: DbConn): Promise<string> {
    if (c.kind === 'mongo') return String((await mongo(c, MONGO_VIEW_JS.version)).json ?? tr('（未知版本）'))
    if (c.kind === 'redis') return parseRedisInfo(await exec(c, '', REDIS_ARGS.version)).flatMap((s) => s.items).find(([k]) => k === 'redis_version')?.[1] ?? tr('（未知版本）')
    const t = await sql(c, c.kind === 'mysql' ? MYSQL_SQL.version : PG_SQL.version)
    return t.rows[0]?.[0] ?? tr('（未知版本）')
  }

  async function mysqlSlow(c: DbConn): Promise<DbViewResult> {
    const v = Object.fromEntries(tableToKv(await sql(c, MYSQL_SQL.slowVars)) ?? [])
    const on = /^(1|on)$/i.test(v.slow_query_log ?? '')
    const kv: DbViewResult['kv'] = [{ title: tr('慢日志设置'), items: [['slow_query_log', v.slow_query_log ?? ''], ['long_query_time', v.long_query_time ?? ''], ['log_output', v.log_output ?? ''], ['slow_query_log_file', v.file ?? '']] }]
    const note = on ? undefined : tr('慢日志没有开启（slow_query_log=OFF），下面是以前留下的记录（如有）。开启要执行 SET GLOBAL slow_query_log = ON（写操作，这里不做，请在终端里执行）。')
    let entries: SlowEntry[] = [], source = ''
    if (/TABLE/i.test(v.log_output ?? '')) {
      const t = await sql(c, MYSQL_SQL.slowTable)
      const col = (n: string) => t.columns.indexOf(n)
      entries = t.rows.map((r) => ({
        // 语句按 LEFT(sql_text, 4000) 取的：取满了就是被截断了，标个「…」（界面上不给 EXPLAIN）
        sql: ((s) => (s.length >= 4000 ? `${s}…` : s))(r[col('sql_text')] ?? ''), queryTime: mysqlTimeToSec(r[col('query_time')] ?? ''), lockTime: mysqlTimeToSec(r[col('lock_time')] ?? ''),
        rowsSent: Number(r[col('rows_sent')]) || 0, rowsExamined: Number(r[col('rows_examined')]) || 0, time: r[col('start_time')], user: r[col('user_host')]?.split('[')[0], db: r[col('db')] || undefined,
      }))
      source = t.truncated ? tr('mysql.slow_log 表（输出太大，只解析了最近的 {n} 条）', { n: entries.length }) : tr('mysql.slow_log 表（最近 5000 条）')
    } else if (v.file) {
      const r = await d.run(c.hostKey)(slowlogTailCommand(c, v.file), { timeoutMs: DB_TIMEOUT_MS, maxBytes: MAX_OUT * 3 })
      const s = splitDbOutput(r.output)
      if (s.rc !== 0) {
        const remote = c.via === 'client' && c.host && !/^(localhost|127\.0\.0\.1|::1)$/.test(c.host)
        return { kv, note: d.mask(`${tr('读不到慢日志文件 {file}：{err}', { file: v.file, err: s.err || tr('退出码 {rc}', { rc: s.rc ?? tr('frag|未知') }) })}\n${remote ? tr('数据库不在这台机器上（地址不是本机）时，慢日志文件也不在这里：请把连接建在数据库所在的主机上。') : tr('没有读权限时可以给当前用户加读权限，或配置免密 sudo。')}`) }
      }
      entries = parseMysqlSlowLog(d.mask(s.stdout))
      source = tr('{file}（末尾 4MB）', { file: v.file })
    }
    return { kv, digests: digestSlow(entries), note, source: `${source}${source ? tr(' · {n} 条', { n: entries.length }) : ''}` }
  }

  async function view(c: DbConn, v: string, limit: number): Promise<DbViewResult> {
    if (c.kind === 'mongo') {
      const js = v === 'tables' ? MONGO_VIEW_JS.tables(limit) : v === 'info' || v === 'sessions' || v === 'slow' || v === 'repl' ? MONGO_VIEW_JS[v] : undefined
      if (!js) throw new Error(tr('非法的视图'))
      return mongoViewResult(v, await mongo(c, js), { db: c.database || 'test' })
    }
    if (c.kind === 'mysql') {
      if (v === 'sessions') return ret(undefined, await sql(c, MYSQL_SQL.sessions))
      if (v === 'locks') {
        const r = await trySql(c, MYSQL_SQL.locks)
        if ('t' in r) return ret(undefined, r.t)
        if (/sys|doesn't exist|Unknown database/i.test(r.e.message)) return { note: `${tr('读不到锁等待：需要 MySQL 5.7+ 的 sys 库（sys.innodb_lock_waits）。')}\n${r.e.message}` }
        throw r.e
      }
      if (v === 'slow') return mysqlSlow(c)
      if (v === 'tables') return ret(undefined, await sql(c, MYSQL_SQL.tables(limit)))
      if (v === 'repl') {
        let rep = await trySql(c, MYSQL_SQL.replica)
        if ('e' in rep) rep = await trySql(c, MYSQL_SQL.replicaOld)
        let pri = await trySql(c, MYSQL_SQL.primary)
        if ('e' in pri) pri = await trySql(c, MYSQL_SQL.primaryNew)
        const kv: NonNullable<DbViewResult['kv']> = []
        const rk = 't' in rep ? tableToKv(rep.t) : undefined, pk = 't' in pri ? tableToKv(pri.t) : undefined
        if (rk) kv.push({ title: tr('从库状态（SHOW REPLICA STATUS）'), items: rk })
        if (pk) kv.push({ title: tr('主库 binlog 位置（SHOW MASTER STATUS）'), items: pk })
        if ('e' in rep && 'e' in pri) throw rep.e
        return { kv, note: rk ? undefined : tr('这个实例不是从库（没有复制通道）。') }
      }
    } else if (c.kind === 'postgres') {
      if (v === 'sessions') return ret(undefined, await sql(c, PG_SQL.sessions))
      if (v === 'locks') return ret(undefined, await sql(c, PG_SQL.locks))
      if (v === 'statements') {
        let r = await trySql(c, PG_SQL.statements('total_exec_time'))
        if ('e' in r && /total_exec_time/.test(r.e.message)) r = await trySql(c, PG_SQL.statements('total_time'))   // PG 12 及以前
        if ('t' in r) return { ...ret(tr('按总耗时排序（pg_stat_statements 已按语句指纹归并）'), r.t), source: 'pg_stat_statements' }
        if (/pg_stat_statements/.test(r.e.message)) return { note: `${tr('没有可用的 pg_stat_statements：需要在 shared_preload_libraries 里加载并在库里 CREATE EXTENSION pg_stat_statements（写操作，请 DBA 处理）。')}\n${r.e.message}` }
        throw r.e
      }
      if (v === 'tables') return ret(undefined, await sql(c, PG_SQL.tables(limit)))
      if (v === 'repl') {
        const rec = tableToKv(await sql(c, PG_SQL.recovery)) ?? []
        const reps = await sql(c, PG_SQL.replicas)
        const standby = rec.find(([k]) => k === 'in_recovery')?.[1] === 't'
        return { kv: [{ title: standby ? tr('本实例是从库（恢复中）') : tr('本实例是主库'), items: rec }], tables: [{ title: tr('连到本实例的从库（pg_stat_replication）'), table: reps }], note: !standby && !reps.rows.length ? tr('没有从库连上来。') : undefined }
      }
    } else {
      if (v === 'info') {
        const raw = await exec(c, '', REDIS_ARGS.info)
        const secs = parseRedisInfo(raw)
        const all = new Map(secs.flatMap((s) => s.items))
        const hits = Number(all.get('keyspace_hits')), miss = Number(all.get('keyspace_misses'))
        const items = REDIS_SUMMARY_KEYS.filter((k) => all.has(k)).map((k): [string, string] => [k, all.get(k) ?? ''])
        if (hits + miss > 0) items.push(['hit_rate', `${((hits / (hits + miss)) * 100).toFixed(1)}%`])
        const ks = secs.find((s) => /keyspace/i.test(s.title))
        return { kv: [{ title: tr('概况'), items }, ...(ks?.items.length ? [{ title: 'Keyspace', items: ks.items }] : [])], text: raw }
      }
      if (v === 'clients') return ret(undefined, parseRedisClients(await exec(c, '', REDIS_ARGS.clients)))
      if (v === 'slowlog') return { ...ret(tr('最近 128 条（耗时单位 ms）'), redisSlowlogTable(parseRedisReply(await exec(c, '', REDIS_ARGS.slowlog)))) }
      if (v === 'bigkeys') {
        const raw = await exec(c, '', REDIS_ARGS.bigkeys, DB_BIGKEYS_TIMEOUT_MS)
        return { ...ret(tr('每种类型最大的 key'), parseBigkeys(raw)), text: raw }
      }
      if (v === 'memory') {
        const mem = parseRedisInfo(await exec(c, '', REDIS_ARGS.memory))
        const doctor = await exec(c, '', REDIS_ARGS.doctor).catch((e: Error) => tr('（MEMORY DOCTOR 不可用：{err}）', { err: e.message }))
        return { kv: mem.length ? mem : undefined, text: doctor }
      }
    }
    throw new Error(tr('非法的视图'))
  }

  async function explain(c: DbConn, input: string): Promise<DbExplainResult> {
    if (c.kind === 'mongo') {
      const body = mongoQueryBody(parseMongoQuery(input), true)
      return { sql: mongoQueryText(input), ...mongoExplain((await mongo(c, body)).json) }
    }
    const x = explainInput(c.kind, input)
    const table = parseDbTable(await exec(c, x.input), c.kind === 'postgres' ? 'postgres' : 'mysql')
    return { sql: x.sql, table, text: explainText(c.kind, table) }
  }

  // 即席查询（只读）：PG 用 --csv 保住值里的换行，psql 12 以前没有 --csv 时退回非对齐输出
  // 分页：多取的一条用来判断有没有下一页，返回前去掉
  const trimPage = (t: DbTable, pg: DbPage) => {
    const hasMore = t.rows.length > pg.limit
    return { table: hasMore ? { ...t, rows: t.rows.slice(0, pg.limit) } : t, paged: { ...pg, hasMore } }
  }
  async function query(c: DbConn, input: string, page?: DbPage): Promise<DbQueryResult> {
    if (c.kind === 'mongo') {
      // 自己解析 shell 语法（不把用户文本当 JS 执行），只放读操作
      const q = parseMongoQuery(input)
      const pg = page && mongoPageable(q) ? page : undefined
      const body = mongoQueryBody(q, false, pg)
      const t0 = Date.now()
      const r = await mongo(c, body)
      let table: DbTable = { ...docsToTable(r.docs), ...(r.truncated ? { truncated: true } : {}) }
      let paged: DbQueryResult['paged']
      if (pg) ({ table, paged } = trimPage(table, pg))
      return { sql: mongoQueryText(input), table, ms: Date.now() - t0, ...(paged ? { paged } : {}) }
    }
    const x = queryInput(c.kind, input, page)
    const t0 = Date.now()
    let table: DbTable
    if (c.kind === 'postgres') {
      const r = await execT(c, x.input, [], DB_TIMEOUT_MS, true).catch((e: Error) => {
        if (/csv/i.test(e.message) && /unrecognized|invalid|unknown|无效|未知/i.test(e.message)) return undefined
        throw e
      })
      if (r) table = { ...parseCsvTable(r.out), ...(r.truncated ? { truncated: true } : {}) }
      else table = await sql(c, x.body)
    } else table = await sql(c, x.input.replace(/\n;\n$/, ''))
    let paged: DbQueryResult['paged']
    if (x.paged && page) ({ table, paged } = trimPage(table, page))
    return { sql: x.sql, table, ms: Date.now() - t0, ...(paged ? { paged } : {}) }
  }

  async function databases(c: DbConn): Promise<DbDatabase[]> {
    if (c.kind === 'mongo') {
      const l = (await mongo(c, MONGO_VIEW_JS.databases)).json
      return (Array.isArray(l) ? l : []).map((x) => ({ name: String(x) })).filter((x) => x.name)
    }
    if (c.kind === 'redis') {
      const ks = new Map(redisKeyspace(await exec(c, '', REDIS_ARGS.keyspace)))
      const top = Math.max(15, ...[...ks.keys()].map(Number), Number(c.database ?? 0))
      return Array.from({ length: top + 1 }, (_v, i) => ({ name: String(i), keys: ks.get(String(i)) ?? 0 }))
    }
    return (await sql(c, DB_LIST_SQL[c.kind])).rows.map((r) => ({ name: r[0] ?? '' })).filter((x) => x.name)
  }

  async function schemaTable(c: DbConn, db: string, t: DbTableRef): Promise<DbSchemaDetail> {
    if (c.kind === 'redis') throw new Error(tr('Redis 没有表结构'))
    if (c.kind === 'mongo') {
      if (!isDbIdent(t.name)) throw new Error(tr('非法的集合名'))
      return mongoSchemaDetail(t.name, (await mongo(c, MONGO_VIEW_JS.schemaTable(t.name))).json)
    }
    const q = schemaTableSql(c.kind, db, t)
    if (c.kind === 'mysql') {
      const [columns, indexes, ddl] = await Promise.all([sql(c, q.columns), sql(c, q.indexes), sql(c, q.ddl)])
      return { columns, indexes, ddl: ddl.rows[0]?.[1] ?? '' }
    }
    // PG 的文本列在 SQL 里按 mysql -B 规则转义过，按 mysql 规则解析还原
    const pg = async (s: string) => parseDbTable(await exec(c, `${s}\n;\n`), 'mysql')
    const [columns, indexes, kind, cons] = await Promise.all([pg(q.columns), pg(q.indexes), pg(q.ddl), pg(q.extra!)])
    const k = kind.rows[0]?.[0] ?? 'r'
    return { columns, indexes: { columns: indexes.columns.slice(0, 2), rows: indexes.rows.map((r) => r.slice(0, 2)) }, ddl: pgDdl(t, columns, cons, indexes, k, kind.rows[0]?.[1] ?? '') }
  }

  // SCAN 一批：一次最多跑 10 轮或凑够 200 个 key，返回下一轮的 cursor（'0' = 扫完）
  async function redisScan(c: DbConn, pattern: string, cursor: string): Promise<{ cursor: string; keys: string[] }> {
    const keys: string[] = []
    let cur = cursor
    for (let i = 0; i < 10 && keys.length < 200; i++) {
      const r = await redis(c, ['SCAN', cur, 'MATCH', shq(pattern || '*'), 'COUNT', '1000'])
      if (!Array.isArray(r)) throw new Error(tr('SCAN 的回复无法解析'))
      cur = String(r[0] ?? '0')
      for (const k of Array.isArray(r[1]) ? r[1] : []) keys.push(String(k))
      if (cur === '0') break
    }
    return { cursor: cur, keys }
  }
  async function redisKey(c: DbConn, key: string): Promise<RedisKeyInfo> {
    const k = shq(key)
    const type = String(await redis(c, ['TYPE', k]))
    if (type === 'none') throw new Error(tr('这个 key 不存在（可能已过期或被删除）'))
    const cmds = redisKeyCmds(type)
    const [ttl, bytes, size, pv] = await Promise.all([
      redis(c, ['TTL', k]),
      redis(c, ['MEMORY', 'USAGE', k]).catch(() => undefined),   // 4.0 以前没有 / ACL 禁用
      cmds.size ? redis(c, [cmds.size, k]) : undefined,
      cmds.preview ? redis(c, cmds.preview.map((a) => (a === '{k}' ? k : a))) : undefined,
    ])
    const value = pv === undefined ? undefined : redisPreviewTable(type, pv)
    const n = typeof size === 'number' ? size : undefined
    const partial = n !== undefined && (typeof value === 'string' ? n > 65536 : !!value && n > value.rows.length)   // string 只取前 64KB（GETRANGE 0 65535）
    return { key, type, ttl: typeof ttl === 'number' ? ttl : -1, bytes: typeof bytes === 'number' ? bytes : undefined, size: n, value, partial }
  }

  // 执行脚本：不抛错，返回输出 + 报错（失败时前面已执行的部分也看得到）。Redis 遇错不退出，按输出里的 (error) 判失败
  async function script(c: DbConn, src: string, tx: boolean): Promise<DbScriptResult> {
    const pw = c.secret ? d.password(c.hostKey, c.secret) : ''
    if (/[\r\n]/.test(pw)) throw new Error(tr('密钥保险箱里的这个密码含换行，不能用作数据库密码'))
    const t0 = Date.now()
    const r = await d.run(c.hostKey)(dbCommand(c, c.kind === 'redis' ? ['--no-raw'] : [], { tx }), { timeoutMs: DB_SCRIPT_TIMEOUT_MS, maxBytes: MAX_OUT, stdin: `${pw}\n${c.kind === 'mongo' ? mongoJs(c, src) : scriptInput(c.kind, src, tx)}` })
    const ms = Date.now() - t0
    const s = splitDbOutput(r.output)
    const stdout = d.mask(s.stdout).replace(/\r\n?/g, '\n')   // redis-cli INFO 等输出行尾带 \r
    if (r.stopped === 'timeout') return { ok: false, output: stdout, error: `${tr('执行超时（{n} 分钟），客户端已被结束', { n: DB_SCRIPT_TIMEOUT_MS / 60_000 })}${tx ? tr('，未提交的事务会回滚') : ''}`, ms }
    const redisErr = c.kind === 'redis' ? stdout.split('\n').filter((l) => /^\(error\)/.test(l)).join('\n') : ''
    const ok = s.rc === 0 && !redisErr
    const error = ok ? '' : d.mask(fixScriptLines(c.kind, tx, s.rc === 0 ? redisErr : dbErrorText(c, s.err, s.rc)))
    return { ok, rc: s.rc, output: stdout, error, ms }
  }

  return { exec, sql, redis, mongo, version, view, explain, script, query, databases, schemaTable, redisScan, redisKey }
}

export function registerDb(d: DbIpcDeps): { stop(): void } {
  let conns = loadDbConns(d.file)
  const q = createDbQuery(d)
  const save = () => { saveDbConns(d.file, conns); return conns }
  const connOf = (id: unknown) => {
    const c = conns.find((x) => x.id === id)
    if (!c) throw new Error(tr('连接不存在（可能已删除）'))
    if (!d.host(c.hostKey)) throw new Error(tr('这个连接所属的主机已被删除，请编辑连接换一台主机'))
    return c
  }
  const limitOf = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 500 ? v : 20)

  d.handle('db:list', () => conns)
  d.handle('db:save', (_e, v) => {
    const c = sanitizeDbConn(v)
    if (typeof c === 'string') throw new Error(c)
    if (!d.host(c.hostKey)) throw new Error(tr('所选主机不存在'))
    const i = conns.findIndex((x) => x.id === c.id)
    conns = i < 0 ? [...conns, c] : conns.map((x, k) => (k === i ? c : x))
    return save()
  })
  // 删连接连带删它的定时备份计划（否则调度器还会按旧计划跑，界面上又看不到）；已有的备份文件不动
  d.handle('db:delete', (_e, id) => {
    conns = conns.filter((x) => x.id !== id)
    if (sched.list.some((s) => s.connId === id)) { sched.list = sched.list.filter((s) => s.connId !== id); saveSched() }
    return save()
  })
  // 测试连接（表单里未保存的也能测）：返回版本号
  d.handle('db:ping', (_e, v) => {
    const c = sanitizeDbConn(v)
    if (typeof c === 'string') throw new Error(c)
    if (!d.host(c.hostKey)) throw new Error(tr('所选主机不存在'))
    return q.version(c)
  })
  d.handle('db:view', (_e, id, view, opts) => {
    const o = (opts ?? {}) as { limit?: unknown; db?: unknown }
    const c = withDatabase(connOf(id), o.db)
    if (!isDbView(c.kind, view)) throw new Error(tr('非法的视图'))
    return q.view(c, view, limitOf(o.limit))
  })
  d.handle('db:explain', (_e, id, sql, db) => q.explain(withDatabase(connOf(id), db), String(sql ?? '')))
  // page：{ offset, limit }（每页行数上限 DB_PAGE_MAX）；不传 = 不分页
  const pageOf = (v: unknown): DbPage | undefined => {
    if (!v || typeof v !== 'object') return undefined
    const o = v as { offset?: unknown; limit?: unknown }
    const int = (x: unknown, d: number, max: number) => (typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= max ? x : d)
    return { offset: int(o.offset, 0, 1e9), limit: Math.min(DB_PAGE_MAX, Math.max(1, int(o.limit, DB_PAGE_SIZE, 1e9))) }
  }
  d.handle('db:query', (_e, id, sql, db, page) => q.query(withDatabase(connOf(id), db), String(sql ?? ''), pageOf(page)))
  d.handle('db:databases', (_e, id) => q.databases(connOf(id)))
  d.handle('db:schemaTables', async (_e, id, db) => {
    const c = connOf(id)
    if (c.kind === 'redis') throw new Error(tr('Redis 没有表结构'))
    if (c.kind === 'mongo') return docsToTable((await q.mongo(withDatabase(c, db), MONGO_VIEW_JS.schemaTables)).docs)
    // PG 的注释列在 SQL 里按 mysql -B 规则转义过（见 pgEsc），两种都按 mysql 规则解析
    return parseDbTable(await q.exec(withDatabase(c, db), `${schemaTablesSql(c.kind, String(db ?? ''))}\n;\n`), 'mysql')
  })
  d.handle('db:schemaTable', (_e, id, db, t) => {
    const c = connOf(id)
    const r = (t ?? {}) as { schema?: unknown; name?: unknown }
    return q.schemaTable(withDatabase(c, db), String(db ?? ''), { name: String(r.name ?? ''), ...(r.schema === undefined ? {} : { schema: String(r.schema) }) })
  })
  const redisConn = (id: unknown, db: unknown) => {
    const c = connOf(id)
    if (c.kind !== 'redis') throw new Error(tr('只有 Redis 连接能浏览 key'))
    return withDatabase(c, db)
  }
  d.handle('db:redisScan', (_e, id, db, pattern, cursor) => {
    const p = typeof pattern === 'string' && pattern ? pattern : '*'
    if (!isRedisKey(p) || p.length > 200) throw new Error(tr('匹配模式不合法（不能有换行，200 字以内）'))
    if (!isRedisCursor(cursor)) throw new Error(tr('非法的 SCAN 游标'))
    return q.redisScan(redisConn(id, db), p, cursor)
  })
  d.handle('db:redisKey', (_e, id, db, key) => {
    if (!isRedisKey(key)) throw new Error(tr('非法的 key'))
    return q.redisKey(redisConn(id, db), key)
  })
  // 删除一个 key：写操作。生产主机必须带二次确认标记；成败都记执行记录
  d.handle('db:redisDel', async (_e, id, db, key, prodConfirmed) => {
    const c = redisConn(id, db)
    if (!isRedisKey(key)) throw new Error(tr('非法的 key'))
    if (d.host(c.hostKey)?.prod && prodConfirmed !== true) throw new Error(tr('生产主机上删除 key 需要二次确认'))
    let rc = 0, err = ''
    try {
      const n = await q.redis(c, ['DEL', shq(key)])
      if (n !== 1) { rc = 1; err = tr('没有删除：这个 key 已经不存在') }
    } catch (e) { rc = 1; err = e instanceof Error ? e.message : String(e) }
    d.audit(c.hostKey, { command: dbAuditCommand(c, `DEL ${JSON.stringify(key)}${c.database ? `  (db ${c.database})` : ''}`), decision: REDIS_KEY_DEL_DECISION, exitCode: rc })
    if (rc) throw new Error(err)
  })
  // 终止会话：写操作。生产主机必须带二次确认标记；成败都记执行记录
  d.handle('db:kill', async (_e, id, sessionId, about, prodConfirmed) => {
    const c = connOf(id)
    if (!isDbSessionId(sessionId)) throw new Error(tr('非法的会话 ID'))
    const killSql = dbKillSql(c.kind, sessionId)
    if (d.host(c.hostKey)?.prod && prodConfirmed !== true) throw new Error(tr('生产主机上终止会话需要二次确认'))
    let rc = 0, err = ''
    try {
      if (c.kind === 'redis') {
        if (await q.redis(c, ['CLIENT', 'KILL', 'ID', String(sessionId)]) !== 1) { rc = 1; err = tr('没有断开：这个客户端已经断开') }
      } else if (c.kind === 'mongo') {
        const r = (await q.mongo(c, MONGO_VIEW_JS.kill(sessionId))).json as { ok?: number; errmsg?: string } | undefined
        if (r?.ok !== 1) { rc = 1; err = tr('没有终止：{reason}', { reason: r?.errmsg ?? tr('操作已经结束，或当前用户没有 killop 权限') }) }
      } else {
        const t = await q.sql(c, killSql)
        if (c.kind === 'postgres' && t.rows[0]?.[0] !== 't') { rc = 1; err = tr('没有终止：会话已经结束，或当前用户没有权限（需要超级用户或同一用户）') }
      }
    } catch (e) { rc = 1; err = e instanceof Error ? e.message : String(e) }
    d.audit(c.hostKey, { command: dbAuditCommand(c, killSql, d.mask(typeof about === 'string' ? about : '')), decision: DB_KILL_DECISION, exitCode: rc })
    if (rc) throw new Error(err)
  })
  // ── 备份（见 shared/db/dbBackup.ts）：在数据库所在机器上后台导出，这里只发起、查进度、取消、列 / 删文件 ──
  const runWith = (run: DbRun, cmd: string, stdin?: string, timeoutMs = DB_TIMEOUT_MS) => run(cmd, { timeoutMs, maxBytes: 256 * 1024, ...(stdin !== undefined ? { stdin } : {}) }).then((r) => d.mask(r.output))
  const runOn = (c: DbConn, cmd: string, stdin?: string, timeoutMs = DB_TIMEOUT_MS) => runWith(d.run(c.hostKey), cmd, stdin, timeoutMs)
  const unixOnly = (c: DbConn) => { if (c.hostKey === 'local' && process.platform === 'win32') throw new Error(tr('本机是 Windows：备份请在数据库所在的 Linux 主机上做（连接选那台主机）')) }
  const defaultDir = (c: DbConn) => `~/lingshell-backups/${c.name.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^[._-]+/, '').slice(0, 40) || c.kind}`
  type Job = { connId: string; path: string; status: BackupStatus; audited?: boolean; label: string }
  const jobs = new Map<string, Job>()   // 完整路径 → 任务（本次运行期间；应用重启后列表里仍能看到已完成的文件）
  const starting = new Set<string>()    // 正在发起（远端命令还没返回）的连接：双击 / 手动+定时并发时挡住第二个
  const optsOf = (c: DbConn, v: unknown): BackupOpts => {
    const raw = (v && typeof v === 'object' ? v : {}) as Partial<BackupOpts>
    const o = checkBackupOpts(c, { ...raw, dir: raw.dir || defaultDir(c), tables: Array.isArray(raw.tables) ? raw.tables.map(String) : [] })
    if (typeof o === 'string') throw new Error(o)
    return o
  }
  const tag = (c: DbConn) => `  # ${DB_KIND_LABEL[c.kind]}「${c.name}」`   // i18n-ignore 执行记录（测试按中文断言）
  // 发起一次备份（手动 / 定时共用）：返回备份文件完整路径，任务记进 jobs
  async function startBackup(c: DbConn, o: BackupOpts, run: DbRun, by = ''): Promise<string> {
    // 同一连接同时只能有一个备份：双击「开始备份」/ 手动与定时撞车时，两个进程会写同一个 .part
    if (starting.has(c.id) || [...jobs.values()].some((j) => j.connId === c.id && j.status.state === 'running')) {
      throw new Error(tr('这个数据库已有备份在进行，等它结束再开始'))
    }
    starting.add(c.id)
    try {
      const pw = c.secret ? d.password(c.hostKey, c.secret) : ''
      if (/[\r\n]/.test(pw)) throw new Error(tr('密钥保险箱里的这个密码含换行，不能用作数据库密码'))
      const out = await runWith(run, backupStartCommand(c, o, backupFileName(c, o.database)), `${pw}\n`)
      const m = /^started (.+)$/m.exec(out)
      if (!m) throw new Error(/^exists /m.test(out) ? tr('同名备份文件已存在，稍后再试') : tr('没能启动备份：{err}', { err: out.trim().slice(0, 500) || tr('没有输出') }))
      const path = m[1].trim()
      const label = `${by}${o.database ?? c.name}${o.tables?.length ? `（${o.tables.length} 张表）` : ''}`   // i18n-ignore 只进执行记录
      jobs.set(path, { connId: c.id, path, label, status: { state: 'running', bytes: 0, file: path, startedAt: Date.now() } })
      d.audit(c.hostKey, { command: `[备份开始] ${label} → ${path}${tag(c)}`, decision: BACKUP_DECISION })   // i18n-ignore 执行记录（测试按中文断言）
      return path
    } finally { starting.delete(c.id) }
  }
  // 查一次进度；跑完记一次执行记录
  async function pollJob(c: DbConn, j: Job, run: DbRun): Promise<void> {
    const s = parseBackupStatus(await runWith(run, backupStatusCommand(j.path)).catch(() => ''))
    j.status.bytes = s.bytes
    if (!s.done) return
    j.status.endedAt = Date.now()
    j.status.state = s.done === 'ok' ? 'ok' : s.done === 'canceled' ? 'canceled' : 'fail'
    if (j.status.state === 'fail') j.status.error = backupErrorText(c, s.err ?? '', s.done)
    await runWith(run, backupCleanupCommand(j.path)).catch(() => '')   // 状态已读到，清掉旁边的 .done / .err
    if (!j.audited) {
      j.audited = true
      d.audit(c.hostKey, { command: `[备份${j.status.state === 'ok' ? '完成' : j.status.state === 'canceled' ? '已取消' : '失败'}] ${j.label} → ${j.path}${j.status.state === 'ok' ? `（${s.bytes} 字节）` : ''}${tag(c)}`, decision: BACKUP_DECISION, exitCode: j.status.state === 'ok' ? 0 : 1 })   // i18n-ignore 执行记录（测试按中文断言）
    }
  }
  d.handle('db:backupPlan', async (_e, id, v): Promise<BackupPlan> => {
    const c = connOf(id); unixOnly(c)
    const o = optsOf(c, v)
    const p = parseBackupProbe(await runOn(c, backupProbeCommand(c, o.dir)))
    let estimateBytes: number | undefined
    try {
      if (c.kind === 'mongo') estimateBytes = Number((await q.mongo(withDatabase(c, o.database), MONGO_VIEW_JS.dataSize)).json) || undefined
      else if (c.kind === 'redis') estimateBytes = Number(Object.fromEntries(parseRedisInfo(await q.exec(c, '', REDIS_ARGS.memory)).flatMap((s) => s.items)).used_memory_dataset) || undefined
      else { const t = await q.sql(c, backupEstimateSql(c, o)!); estimateBytes = Number(t.rows[0]?.[0]) || 0 }
    } catch { /* 估不出来不拦，只是不做空间判断 */ }
    return { dir: p.dir || o.dir, freeBytes: p.freeBytes, estimateBytes, tool: p.tool, ...backupSpaceCheck(p.freeBytes, estimateBytes), ...(!p.tool ? { blocked: backupErrorText(c, 'command not found') } : {}) }
  })
  d.handle('db:backupStart', async (_e, id, v) => {
    const c = connOf(id); unixOnly(c)
    return startBackup(c, optsOf(c, v), d.run(c.hostKey))
  })
  // 本连接的备份任务及进度（定时任务由调度器自己查进度，这里只读它的状态）
  d.handle('db:backupStatus', async (_e, id) => {
    const c = connOf(id)
    const mine = [...jobs.values()].filter((j) => j.connId === c.id)
    for (const j of mine.filter((x) => x.status.state === 'running' && !sched.running.has(x.path))) await pollJob(c, j, d.run(c.hostKey))
    return mine.map((j) => j.status).sort((a, b) => b.startedAt - a.startedAt)
  })
  d.handle('db:backupCancel', async (_e, id, path) => {
    const c = connOf(id)
    const j = jobs.get(String(path))
    if (!j || j.connId !== c.id) throw new Error(tr('没有这个备份任务'))
    await runOn(c, backupCancelCommand(j.path))
  })
  d.handle('db:backupList', async (_e, id, dir) => {
    const c = connOf(id); unixOnly(c)
    const dd = typeof dir === 'string' && dir ? dir : defaultDir(c)
    if (!isBackupDir(dd)) throw new Error(tr('非法的备份目录'))
    return parseBackupList(await runOn(c, backupListCommand(dd)))
  })
  d.handle('db:backupDelete', async (_e, id, dir, name) => {
    const c = connOf(id)
    if (!isBackupDir(dir) || !isBackupName(name)) throw new Error(tr('非法的备份文件'))
    await runOn(c, backupDeleteCommand(dir, name))
    d.audit(c.hostKey, { command: `[删除备份] ${dir}/${name}${tag(c)}`, decision: BACKUP_DECISION })   // i18n-ignore 执行记录
  })

  // ── 定时备份：每个连接一个计划，存 schedulesFile；主进程里每分钟看一次到点没有（只在应用开着时跑，错过的启动后补跑一次）──
  const now = () => (d.now ?? Date.now)()
  const sched = { list: [] as BackupSchedule[], running: new Set<string>(), busyConn: new Set<string>() }
  if (d.schedulesFile) { try { sched.list = existsSync(d.schedulesFile) ? JSON.parse(readFileSync(d.schedulesFile, 'utf8')) : [] } catch { sched.list = [] } }
  const saveSched = () => {
    if (!d.schedulesFile) return
    mkdirSync(dirname(d.schedulesFile), { recursive: true })
    writeFileSync(`${d.schedulesFile}.tmp`, JSON.stringify(sched.list, null, 1), 'utf8')
    renameSync(`${d.schedulesFile}.tmp`, d.schedulesFile)
  }
  const withHost = <T>(hk: string, fn: (run: DbRun) => Promise<T>) => (d.withHost ? d.withHost(hk, fn) : fn(d.run(hk)))
  async function runSchedule(s: BackupSchedule): Promise<void> {
    const c = conns.find((x) => x.id === s.connId)
    if (!c || sched.busyConn.has(s.connId)) return
    sched.busyConn.add(c.id)
    s.lastRunAt = new Date(now()).toISOString(); saveSched()
    const at = s.lastRunAt
    let r: NonNullable<BackupSchedule['lastResult']>
    try {
      if (!d.host(c.hostKey)) throw new Error(tr('连接所属的主机已被删除'))
      unixOnly(c)
      r = await withHost(c.hostKey, async (run) => {
        const path = await startBackup(c, s.opts, run, '[定时] ')   // i18n-ignore 执行记录里的标签
        const j = jobs.get(path)!
        sched.running.add(path)
        try {
          const deadline = Date.now() + 6 * 3_600_000
          while (j.status.state === 'running') {
            if (Date.now() > deadline) { await runWith(run, backupCancelCommand(path)).catch(() => ''); j.status.state = 'fail'; j.status.error = tr('超过 6 小时没有完成，已取消'); break }
            await new Promise((ok) => setTimeout(ok, d.pollMs ?? 10_000))
            await pollJob(c, j, run)
          }
        } finally { sched.running.delete(path) }
        if (j.status.state !== 'ok') return { at, ok: false, file: path, error: j.status.error ?? tr('备份没有完成') }
        // 只保留最近 keep 份（同库同类型）
        const dir = path.slice(0, path.lastIndexOf('/'))
        const old = backupsToPrune(parseBackupList(await runWith(run, backupListCommand(dir)).catch(() => '')), c, s.opts.database, s.keep)
        for (const n of old) {
          await runWith(run, backupDeleteCommand(dir, n)).catch(() => '')
          d.audit(c.hostKey, { command: `[删除备份·超出保留 ${s.keep} 份] ${dir}/${n}${tag(c)}`, decision: BACKUP_DECISION })   // i18n-ignore 执行记录（测试按中文断言）
        }
        return { at, ok: true, file: path, bytes: j.status.bytes, pruned: old.length }
      })
    } catch (e) { r = { at, ok: false, error: e instanceof Error ? e.message : String(e) } } finally { sched.busyConn.delete(c.id) }
    s.lastResult = r; saveSched()
    const host = d.host(c.hostKey)?.label ?? c.hostKey
    const title = r.ok ? tr('数据库定时备份完成：{name}', { name: c.name }) : tr('数据库定时备份失败：{name}', { name: c.name })
    const lines = r.ok ? [tr('文件：{file}', { file: r.file ?? '' }), tr('大小：{n} 字节', { n: r.bytes ?? 0 }), ...(r.pruned ? [tr('清理旧备份 {n} 份（保留 {keep} 份）', { n: r.pruned, keep: s.keep })] : [])] : [tr('原因：{err}', { err: r.error ?? '' })]
    if (!r.ok) d.notify?.(title, lines.join('\n'))
    // push 失败时返回错误文本（不 reject）：记进执行记录，别让「成败都推送」静默落空
    const pushErr = await d.push?.(title, lines, [host], r.ok).catch((e: unknown) => String(e))
    if (pushErr) d.audit(c.hostKey, { command: `[定时备份通知发送失败] ${title}：${pushErr}`, decision: BACKUP_DECISION, exitCode: 1 })   // i18n-ignore 执行记录
  }
  const due = (s: BackupSchedule) => s.enabled && now() >= nextRunAt(s.when, Date.parse(s.lastRunAt ?? s.createdAt))
  const timer = d.schedulesFile && d.tickMs !== 0 ? setInterval(() => { for (const s of sched.list) if (due(s)) void runSchedule(s) }, d.tickMs ?? 60_000) : undefined
  d.handle('db:backupScheduleGet', (_e, id) => sched.list.find((x) => x.connId === connOf(id).id) ?? null)
  d.handle('db:backupScheduleSave', (_e, id, v) => {
    const c = connOf(id)
    const prev = sched.list.find((x) => x.connId === c.id)
    if (v === null) { sched.list = sched.list.filter((x) => x !== prev); saveSched(); return null }
    const raw = (v && typeof v === 'object' ? v : {}) as { opts?: unknown }
    const s = sanitizeBackupSchedule({ ...raw, opts: optsOf(c, raw.opts) }, c, prev)
    if (typeof s === 'string') throw new Error(s)
    // 新建 / 改了时间：从现在算起（不立刻补跑）
    if (!prev || JSON.stringify(prev.when) !== JSON.stringify(s.when)) s.lastRunAt = new Date(now()).toISOString()
    sched.list = [...sched.list.filter((x) => x !== prev), s]
    saveSched()
    return s
  })
  // 立即跑一次（界面「现在跑一次」/ 测试用）：跑完才返回
  d.handle('db:backupScheduleRun', async (_e, id) => {
    const c = connOf(id)
    const s = sched.list.find((x) => x.connId === c.id)
    if (!s) throw new Error(tr('这个连接还没有定时备份计划'))
    // 正在跑时以前静默返回旧结果，界面看着像「刚跑成功」；改为明确报错
    if (sched.busyConn.has(c.id)) throw new Error(tr('这个连接的备份正在执行，稍后再试'))
    await runSchedule(s)
    return sched.list.find((x) => x.connId === c.id) ?? s
  })

  // 执行脚本：写操作。生产主机必须带二次确认标记；成败都记执行记录
  d.handle('db:script', async (_e, id, src, tx, prodConfirmed, db) => {
    const c = withDatabase(connOf(id), db)   // 在上方「库」里切到的库上执行
    const text = typeof src === 'string' ? src : ''
    if (!text.trim()) throw new Error(tr('脚本是空的'))
    if (text.length > DB_SCRIPT_MAX) throw new Error(tr('脚本太大（上限 {n}MB）', { n: DB_SCRIPT_MAX / 1024 / 1024 }))
    if (c.kind === 'mongo' && text.length > MONGO_SCRIPT_MAX) throw new Error(tr('MongoDB 脚本经命令行参数交给 mongosh，上限 {n}KB；大的脚本请在终端里用 mongosh --file 执行', { n: MONGO_SCRIPT_MAX / 1024 }))
    if (d.host(c.hostKey)?.prod && prodConfirmed !== true) throw new Error(tr('生产主机上执行脚本需要二次确认'))
    const useTx = tx === true && c.kind !== 'redis' && c.kind !== 'mongo'
    let r: DbScriptResult
    try { r = await q.script(c, text, useTx) } catch (e) { r = { ok: false, output: '', error: e instanceof Error ? e.message : String(e), ms: 0 } }
    d.audit(c.hostKey, { command: d.mask(scriptAuditCommand(c, checkScript(c.kind, text, useTx), text, useTx)), decision: DB_SCRIPT_DECISION, exitCode: r.ok ? 0 : (r.rc || 1) })
    return r
  })
  return { stop: () => clearInterval(timer) }
}
