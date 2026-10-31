// 数据库快查（纯逻辑）：连接配置校验、在目标机上调用命令行客户端（mysql / psql / redis-cli，或 docker exec 进容器）的命令拼装、
// 输出解析（批量 / 制表符模式、redis-cli --no-raw 的嵌套回复）、各视图的 SQL、kill 与 EXPLAIN 的语句和给 AI 的提示。
// 密码：连接里只存密钥保险箱的名称；执行时主进程取出明文作为 stdin 第一行传入，远端 shell 读进环境变量
// （MYSQL_PWD / PGPASSWORD / REDISCLI_AUTH）再起客户端——不出现在命令行、进程列表、终端和日志里。
import { shq } from '../files/explorer.js'
import { checkExplainSql, checkReadonlySql, sqlPageable } from './sqlReadonly.js'
import type { SlowDigest } from '../ops/index.js'
import { tk, tr } from '../i18n/i18n.js'

export type DbKind = 'mysql' | 'postgres' | 'redis' | 'mongo'
export type DbVia = 'client' | 'docker'
export interface DbConn {
  id: string
  name: string
  hostKey: string              // 命令在哪台机器上执行：'local' | 已保存主机 id
  kind: DbKind
  via: DbVia                   // 本机客户端 / docker exec 进容器
  container?: string
  host?: string                // 数据库地址（空 = 客户端默认：本机 socket / 容器内）
  port?: number
  user?: string
  database?: string            // MySQL / PG 的库名；Redis 的库序号
  secret?: string              // 密码：密钥保险箱里的名称（只存名称）
}
export type DbView = 'sessions' | 'locks' | 'slow' | 'statements' | 'tables' | 'repl' | 'info' | 'clients' | 'slowlog' | 'bigkeys' | 'memory'
/** truncated：客户端输出超过上限被截断，只解析了前面的行 */
export interface DbTable { columns: string[]; rows: string[][]; truncated?: boolean }
export interface DbViewResult {
  tables?: { title?: string; table: DbTable }[]
  kv?: { title: string; items: [string, string][] }[]
  digests?: SlowDigest[]
  text?: string                // 原文（大 key 扫描 / 内存诊断）
  note?: string                // 提示（慢日志没开、pg_stat_statements 没装等）
  source?: string              // 数据来源说明（慢日志文件路径等）
}
export interface DbExplainResult { sql: string; table: DbTable; text: string }
export interface DbQueryResult { sql: string; table: DbTable; ms: number; paged?: { offset: number; limit: number; hasMore: boolean } }
/** 「查询」页签默认每页多少行（不一次把整张表拉回来）；用户语句自己写了 LIMIT 时按用户的来 */
export const DB_PAGE_SIZE = 100
export const DB_PAGE_MAX = 1000
export interface DbPage { offset: number; limit: number }
export interface DbSchemaDetail { columns: DbTable; indexes: DbTable; ddl: string }
/** 库列表：Redis 带 key 数（INFO keyspace 里有数据的库） */
export interface DbDatabase { name: string; keys?: number }
export interface RedisKeyInfo { key: string; type: string; ttl: number; bytes?: number; size?: number; value?: DbTable | string; partial?: boolean }

export const DB_KIND_LABEL: Record<DbKind, string> = { mysql: 'MySQL', postgres: 'PostgreSQL', redis: 'Redis', mongo: 'MongoDB' }
export const DB_DEFAULT_PORT: Record<DbKind, number> = { mysql: 3306, postgres: 5432, redis: 6379, mongo: 27017 }
export const DB_CLIENT: Record<DbKind, string> = { mysql: 'mysql', postgres: 'psql', redis: 'redis-cli', mongo: 'mongosh' }
export const DB_VIEWS: Record<DbKind, { id: DbView; label: string }[]> = {
  mysql: [{ id: 'sessions', label: tk('db|会话') }, { id: 'locks', label: tk('锁等待') }, { id: 'slow', label: tk('慢查询') }, { id: 'tables', label: tk('表大小') }, { id: 'repl', label: tk('db|复制') }],
  postgres: [{ id: 'sessions', label: tk('db|会话') }, { id: 'locks', label: tk('锁等待') }, { id: 'statements', label: tk('慢查询') }, { id: 'tables', label: tk('表大小') }, { id: 'repl', label: tk('db|复制') }],
  redis: [{ id: 'info', label: tk('概况') }, { id: 'clients', label: tk('客户端') }, { id: 'slowlog', label: tk('慢日志') }, { id: 'bigkeys', label: tk('大 key') }, { id: 'memory', label: tk('内存') }],
  mongo: [{ id: 'info', label: tk('概况') }, { id: 'sessions', label: tk('当前操作') }, { id: 'slow', label: tk('慢查询') }, { id: 'tables', label: tk('集合大小') }, { id: 'repl', label: tk('db|复制') }],
}
/** 视图 / 查询的客户端输出上限：超过只留开头（结束标记和退出码不丢），表格丢掉最后半行并标 truncated */
export const DB_OUT_LIMIT = 6 * 1024 * 1024   // 一页宽表（长文本列）也可能好几 MB；再大就截断并提示把每页行数调小
export const DB_TIMEOUT_MS = 30_000
export const DB_BIGKEYS_TIMEOUT_MS = 180_000
export const DB_SLOWLOG_TAIL_BYTES = 4 * 1024 * 1024
export const DB_KILL_DECISION = 'db_kill'
export const DB_LONG_SEC = 10            // 会话耗时超过这么多秒标黄

// ── 连接配置校验 ─────────────────────────────────────────
const RE = {
  name: /^[^\n\r]{1,60}$/,
  hostKey: /^[\w.:@-]{1,128}$/,
  container: /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/,
  host: /^[A-Za-z0-9._:[\]-]{1,253}$/,
  user: /^[A-Za-z0-9._@$-]{1,64}$/,
  database: /^[A-Za-z0-9_$.-]{1,64}$/,
  secret: /^[a-z0-9_-]{1,64}$/,
}
const isKind = (v: unknown): v is DbKind => v === 'mysql' || v === 'postgres' || v === 'redis' || v === 'mongo'

/** 渲染层传来的连接 → 校验后的连接；不合法给原因 */
export function sanitizeDbConn(v: unknown): DbConn | string {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const s = (k: string) => (typeof o[k] === 'string' ? (o[k] as string).trim() : '')
  if (!isKind(o.kind)) return tr('请选择数据库类型')
  const name = s('name'), hostKey = s('hostKey') || 'local'
  if (!RE.name.test(name)) return tr('请填写连接名称（60 字以内）')
  if (!RE.hostKey.test(hostKey)) return tr('非法的主机')
  const via: DbVia = o.via === 'docker' ? 'docker' : 'client'
  const c: DbConn = { id: s('id') || `db-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, hostKey, kind: o.kind, via }
  if (via === 'docker') {
    if (!RE.container.test(s('container'))) return tr('请填写容器名或 ID（字母数字开头，只含字母数字 _ . -）')
    c.container = s('container')
  }
  if (s('host')) { if (!RE.host.test(s('host'))) return tr('数据库地址不合法'); c.host = s('host') }
  if (o.port !== undefined && o.port !== null && o.port !== '') {
    const p = Number(o.port)
    if (!Number.isInteger(p) || p < 1 || p > 65535) return tr('端口要在 1–65535 之间')
    c.port = p
  }
  if (s('user')) { if (!RE.user.test(s('user'))) return tr('用户名只能含字母数字和 . _ @ $ -'); c.user = s('user') }
  if (s('database')) {
    if (o.kind === 'redis' ? !/^\d{1,2}$/.test(s('database')) : !RE.database.test(s('database'))) return o.kind === 'redis' ? tr('Redis 库序号是 0–99 的数字') : tr('库名只能含字母数字和 _ $ . -')
    c.database = s('database')
  }
  if (s('secret')) {
    const n = s('secret').replace(/^\{\{secret:([a-z0-9_-]+)\}\}$/, '$1')
    if (!RE.secret.test(n)) return tr('密码只能选密钥保险箱里的一项')
    c.secret = n
  }
  return c
}
export function sanitizeDbConns(v: unknown): DbConn[] {
  if (!Array.isArray(v)) return []
  const out: DbConn[] = []
  for (const x of v.slice(0, 200)) { const c = sanitizeDbConn(x); if (typeof c !== 'string' && !out.some((y) => y.id === c.id)) out.push(c) }
  return out
}
export const isDbView = (kind: DbKind, v: unknown): v is DbView => DB_VIEWS[kind].some((x) => x.id === v)
export const isDbSessionId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 2 ** 53

// ── 命令拼装 ─────────────────────────────────────────────
// mongosh 不认环境变量里的密码：我们生成的脚本从 process.env.MONGO_PWD 取来拼连接串（见 mongoQuick.ts），密码不进命令行
export const PW_ENV: Record<DbKind, string> = { mysql: 'MYSQL_PWD', postgres: 'PGPASSWORD', redis: 'REDISCLI_AUTH', mongo: 'MONGO_PWD' }
export const DB_END = '@@db:end '
export const DB_TRUNC = '@@db:trunc '

// script：执行脚本（「脚本」页签）——输出给人看（MySQL 表格 + Query OK 行，psql 对齐表格 + 命令标签），PG 不加只读闸，tx = psql -1 整体事务
// csv：PG 即席查询用 psql --csv（值里的换行 / 制表符按 CSV 引号保留，非对齐模式会把一行拆乱；psql 12+）
function clientArgv(c: DbConn, extra: string[], script?: { tx: boolean }, csv = false): string {
  const a: string[] = []
  if (c.kind === 'mysql') {
    // --binary-mode：不认 \! 等客户端命令（stdin 里的 SQL 不会被当 shell 执行）；-B 制表符分隔 + 首行列名，值里的换行 / 制表符转义
    // --default-character-set：Windows 的 mysql.exe 默认按系统代码页（GBK）输出，中文会变乱码；统一要 UTF-8
    a.push('mysql', '--binary-mode', '--default-character-set=utf8mb4', ...(script ? ['-t', '-vvv'] : ['-B']), '--connect-timeout=8')
    if (c.host) a.push('-h', shq(c.host))
    if (c.port) a.push('-P', String(c.port))
    if (c.user) a.push('-u', shq(c.user))
    if (c.database) a.push('-D', shq(c.database))
  } else if (c.kind === 'postgres') {
    // -X 不读 ~/.psqlrc，-w 不提示输入密码，-A -F 制表符：非对齐输出；ON_ERROR_STOP 出错即停
    if (script) a.push('psql', '-X', '-w', '-b', '-v', 'ON_ERROR_STOP=1', ...(script.tx ? ['-1'] : []))
    else if (csv) a.push('psql', '-X', '-w', '-q', '--csv', '-v', 'ON_ERROR_STOP=1')
    else a.push('psql', '-X', '-w', '-q', '-A', '-F', '"$(printf \'\\t\')"', '-P', 'footer=off', '-v', 'ON_ERROR_STOP=1')
    if (c.host) a.push('-h', shq(c.host))
    if (c.port) a.push('-p', String(c.port))
    if (c.user) a.push('-U', shq(c.user))
    if (c.database) a.push('-d', shq(c.database))
    a.push('-f', '-')
  } else if (c.kind === 'mongo') {
    // --nodb：连接由脚本里的 new Mongo(uri) 建；脚本在 $__js（dbCommand 从 stdin 读进来），经 --eval 交给 mongosh
    a.push('mongosh', '--nodb', '--quiet', '--norc', '--eval', '"$__js"')
  } else {
    a.push('redis-cli', '--no-auth-warning')
    if (c.host) a.push('-h', shq(c.host))
    if (c.port) a.push('-p', String(c.port))
    if (c.user) a.push('--user', shq(c.user))
    if (c.database) a.push('-n', c.database)
  }
  a.push(...extra)
  if (c.via !== 'docker' || !c.container) return a.join(' ')
  // docker exec -e 变量名（不带值）= 从 docker 客户端的环境里取值，值不进命令行
  const env = PW_ENV[c.kind]
  return ['docker', 'exec', '-i', `\${${env}+-e ${env}}`, ...(c.kind === 'postgres' ? ['-e', 'PGOPTIONS', '-e', 'PGCLIENTENCODING'] : []), shq(c.container), ...a].join(' ')
}

/**
 * 在目标机上执行的完整命令：stdin 第一行是密码（可为空），其余是给客户端的输入（SQL）。
 * 输出 = 客户端 stdout + 「\n@@db:end <退出码>\n」+ 客户端 stderr（见 splitDbOutput）。
 * extra：客户端追加参数（redis-cli 的命令和参数，调用方保证是固定词）
 */
export function dbCommand(c: DbConn, extra: string[] = [], scriptMode?: { tx: boolean }, csv = false): string {
  const env = PW_ENV[c.kind]
  const script = [
    'IFS= read -r __p || true',
    `if [ -n "$__p" ]; then ${env}=$__p; export ${env}; fi; unset __p`,
    // psql 统一按 UTF-8 收发（服务器 / 系统语言不是 UTF-8 时中文不乱码）
    ...(c.kind === 'postgres' ? ['PGCLIENTENCODING=UTF8; export PGCLIENTENCODING'] : []),
    // mongosh：stdin 余下部分是脚本，读进变量
    ...(c.kind === 'mongo' ? ['__js=$(cat)'] : []),
    // PG 第二道只读闸：会话默认只读事务（写语句会被数据库拒绝）；执行脚本时不加
    ...(c.kind === 'postgres' && !scriptMode ? ["PGOPTIONS='-c default_transaction_read_only=on'; export PGOPTIONS"] : []),
    ...(scriptMode
      // 脚本输出可能很大：先落临时文件，超过 1.25MB 只留开头 256KB + 末尾 1MB（报错和最后的结果在末尾），保证结束标记不被截掉
      ? ['__o=$(mktemp) || exit 1',
        `{ __e=$( { ${clientArgv(c, extra, scriptMode)} >"$__o"; } 2>&1 ); __rc=$?; }`,
        '__n=$(wc -c <"$__o")',
        `if [ "$__n" -gt 1310720 ]; then head -c 262144 "$__o"; printf ${shq(`\\n${tr('…（中间省略 %s 字节）…')}\\n`)} $((__n - 1310720)); tail -c 1048576 "$__o"; else cat "$__o"; fi; rm -f "$__o"`,
        `printf '\\n${DB_END}%s\\n' "$__rc"; printf '%s' "$__e" | tail -c 65536`]
      // 视图 / 查询：同样先落临时文件，超过 DB_OUT_LIMIT 只留开头并打截断标记（否则被通道的输出上限截掉结束标记，整次查询报错）
      : ['__o=$(mktemp) || exit 1',
        `{ __e=$( { ${clientArgv(c, extra, undefined, csv)} >"$__o"; } 2>&1 ); __rc=$?; }`,
        '__n=$(wc -c <"$__o")',
        `if [ "$__n" -gt ${DB_OUT_LIMIT} ]; then head -c ${DB_OUT_LIMIT} "$__o"; printf '\\n${DB_TRUNC}%s\\n' "$__n"; else cat "$__o"; fi; rm -f "$__o"`,
        `printf '\\n${DB_END}%s\\n' "$__rc"; printf '%s' "$__e" | tail -c 65536`]),
  ].join('\n')
  return `sh -c ${shq(script)}`
}

/** 远端读慢日志文件末尾（权限不够时试免密 sudo）；容器里的文件经 docker exec 读 */
export function slowlogTailCommand(c: DbConn, file: string): string {
  if (!/^\/[\w./+@-]{1,500}$/.test(file)) throw new Error(tr('慢日志路径不支持：{v}', { v: file }))
  const tail = `tail -c ${DB_SLOWLOG_TAIL_BYTES} ${shq(file)}`
  const inner = c.via === 'docker' && c.container ? `docker exec ${shq(c.container)} ${tail}` : `${tail} 2>/dev/null || sudo -n ${tail}`
  return `sh -c ${shq(`{ __e=$( { ${inner}; } 2>&1 1>&3 ); __rc=$?; } 3>&1\nprintf '\\n${DB_END}%s\\n' "$__rc"; printf '%s' "$__e"`)}`
}

/** 拆分输出：客户端 stdout / 退出码 / stderr。没有结束标记（被截断 / 远端 shell 异常）时 rc = undefined */
/** truncated：输出超过 DB_OUT_LIMIT 被截断，stdout 已去掉最后不完整的一行 */
export function splitDbOutput(out: string): { stdout: string; rc?: number; err: string; truncated?: boolean } {
  const i = out.lastIndexOf(`\n${DB_END}`)
  if (i < 0) return { stdout: out, err: '' }
  const rest = out.slice(i + 1 + DB_END.length)
  const nl = rest.indexOf('\n')
  const rc = Number(rest.slice(0, nl < 0 ? undefined : nl))
  let stdout = out.slice(0, i).replace(/\n$/, '')
  const t = stdout.lastIndexOf(`\n${DB_TRUNC}`)
  const truncated = t >= 0 && /^\d+$/.test(stdout.slice(t + 1 + DB_TRUNC.length))
  if (truncated) stdout = stdout.slice(0, Math.max(0, stdout.lastIndexOf('\n', t - 1)))
  return { stdout, rc: Number.isFinite(rc) ? rc : undefined, err: nl < 0 ? '' : rest.slice(nl + 1).trim(), ...(truncated ? { truncated } : {}) }
}

/** 客户端报错 → 给人看的说明（原文附在后面） */
export function dbErrorText(c: DbConn, err: string, rc?: number): string {
  const e = err.trim()
  const client = DB_CLIENT[c.kind]
  const where = c.via === 'docker' ? tr('容器 {name} 里', { name: c.container ?? '' }) : tr('这台机器上')
  let hint = ''
  if (/docker: (command )?not found|docker: 未找到命令/.test(e)) hint = tr('这台机器上没有 docker 命令')
  else if (/No such container|is not running/i.test(e)) hint = tr('容器 {name} 不存在或没在运行', { name: c.container ?? '' })
  else if (/permission denied.*docker\.sock/i.test(e)) hint = tr('当前用户没有权限使用 docker（需要加入 docker 组）')
  // i18n-ignore-next 匹配客户端输出的正则
  else if (new RegExp(`${client.replace('-', '\\-')}: (command )?not found|executable file not found|exec: "${client}"|未找到命令`).test(e) || rc === 127) hint = tr('{where}没有 {client} 客户端', { where, client })
  // 权限不够要先判（MySQL 的权限错误也以 Access denied 开头，别误报成密码不对）
  else if (/command denied|you need \(at least one of\)|permission denied for|NOPERM|not authorized|Unauthorized/i.test(e)) hint = tr('当前数据库账号权限不够：这一项需要更高权限，可以换有权限的账号，或先看其他页签')
  // Windows 的 mysql 客户端不填用户名时默认用 ODBC 账号
  else if (/Access denied for user 'ODBC'@/i.test(e) && !c.user) hint = tr('「用户」没填：Windows 上的 mysql 客户端默认用 ODBC 账号登录，请填 root 或你的账号')
  else if (/Access denied|password authentication failed|WRONGPASS|NOAUTH|invalid username-password|no password supplied|Authentication failed/i.test(e)) hint = tr('用户名或密码不对（密码取自密钥保险箱）')
  else if (/MongoServerSelectionError|ECONNREFUSED|ENOTFOUND|connect ETIMEDOUT|Can't connect|Connection refused|could not connect|could not translate host|Unknown MySQL server host|Could not connect to Redis/i.test(e)) hint = tr('连不上数据库：地址 / 端口不对，或数据库没在运行')
  else if (/doesn't exist|does not exist/i.test(e) && /pg_stat_statements/.test(e)) hint = tr('没有安装 pg_stat_statements 扩展')
  const body = e || (rc !== undefined ? tr('退出码 {n}', { n: rc }) : tr('没有输出'))
  return hint ? `${hint}\n${body}` : body
}

// ── 输出解析 ─────────────────────────────────────────────
// mysql -B：值里的 \n \t \\ \0 被转义
const unMysql = (v: string) => v.replace(/\\(.)/g, (_m, ch: string) => (ch === 'n' ? '\n' : ch === 't' ? '\t' : ch === '0' ? '\0' : ch))

/** 批量 / 非对齐输出（首行列名，其余每行一条，制表符分隔）→ 表格 */
export function parseDbTable(stdout: string, kind: 'mysql' | 'postgres'): DbTable {
  const lines = stdout.replace(/\r/g, '').split('\n')
  while (lines.length && !lines[lines.length - 1]) lines.pop()
  if (!lines.length) return { columns: [], rows: [] }
  const cell = (v: string) => (kind === 'mysql' ? unMysql(v) : v)
  const columns = lines[0].split('\t').map(cell)
  const rows = lines.slice(1).map((l) => {
    const r = l.split('\t').map(cell)
    // PG 非对齐模式下值里的制表符没有转义：多出来的并进最后一列
    return r.length > columns.length ? [...r.slice(0, columns.length - 1), r.slice(columns.length - 1).join('\t')] : r
  })
  return { columns, rows }
}

/** 一行多列的结果（SHOW REPLICA STATUS 等）转成键值对；空结果 = undefined */
export function tableToKv(t: DbTable, row = 0): [string, string][] | undefined {
  const r = t.rows[row]
  return r ? t.columns.map((c, i) => [c, r[i] ?? '']) : undefined
}

/** redis INFO → 分节键值 */
export function parseRedisInfo(text: string): { title: string; items: [string, string][] }[] {
  const out: { title: string; items: [string, string][] }[] = []
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const l = raw.trim()
    if (!l) continue
    if (l.startsWith('#')) { out.push({ title: l.replace(/^#\s*/, ''), items: [] }); continue }
    const i = l.indexOf(':')
    if (i <= 0) continue
    if (!out.length) out.push({ title: 'Info', items: [] })
    out[out.length - 1].items.push([l.slice(0, i), l.slice(i + 1)])
  }
  return out
}

export type RedisReply = string | number | null | RedisReply[]
// redis-cli 的引号字符串：\" \\ \n \r \t \xHH
// redis-cli 把非 ASCII 字节都写成 \xHH：还原成字节后按 UTF-8 解码（中文 key / 值），不是合法 UTF-8 的保持逐字节
const utf8 = new TextDecoder('utf-8', { fatal: true })
const unRedis = (s: string) => {
  const r = s.replace(/\\(x[0-9a-fA-F]{2}|.)/g, (_m, e: string) =>
    e[0] === 'x' && e.length === 3 ? String.fromCharCode(parseInt(e.slice(1), 16)) : e === 'n' ? '\n' : e === 'r' ? '\r' : e === 't' ? '\t' : e === 'a' ? '\x07' : e === 'b' ? '\b' : e)
  // eslint-disable-next-line no-control-regex -- 按字节判断是否 UTF-8
  if (!/[\x80-\xff]/.test(r) || /[^\x00-\xff]/.test(r)) return r
  try { return utf8.decode(Uint8Array.from(r, (ch) => ch.charCodeAt(0))) } catch { return r }
}
function redisScalar(v: string): RedisReply {
  const s = v.trim()
  if (s === '(nil)') return null
  if (s === '(empty array)' || s === '(empty list or set)') return []
  const m = /^\(integer\) (-?\d+)$/.exec(s) ?? /^\(double\) (.+)$/.exec(s)
  if (m) return Number(m[1])
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) return unRedis(s.slice(1, -1))
  return s
}

/** redis-cli --no-raw 的回复（嵌套数组按「N) 」前缀的列对齐）→ 结构化 */
export function parseRedisReply(text: string): RedisReply {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim())
  if (!lines.length) return null
  if (!/^\s*\d+\) /.test(lines[0])) return lines.length === 1 ? redisScalar(lines[0]) : lines.join('\n')
  const root: RedisReply[] = []
  const stack: { col: number; arr: RedisReply[] }[] = []
  for (const line of lines) {
    // 行首若干个「N) 」：每个 ) 的列号决定层级
    const marks: number[] = []
    let p = 0
    for (let m; (m = /^(\s*)(\d+)\) /.exec(line.slice(p)));) { marks.push(p + m[0].length - 2); p += m[0].length }
    if (!marks.length) {   // 续行（值里有换行时 redis-cli 已转义，正常不会出现）：并进上一个值
      const arr = stack[stack.length - 1]?.arr
      if (arr && typeof arr[arr.length - 1] === 'string') arr[arr.length - 1] += `\n${line}`
      continue
    }
    marks.forEach((col, k) => {
      if (k === 0) {
        while (stack.length && stack[stack.length - 1].col > col) stack.pop()
        if (!stack.length) stack.push({ col, arr: root })
        else if (stack[stack.length - 1].col < col) { const a: RedisReply[] = []; stack[stack.length - 1].arr.push(a); stack.push({ col, arr: a }) }
      } else { const a: RedisReply[] = []; stack[stack.length - 1].arr.push(a); stack.push({ col, arr: a }) }
    })
    stack[stack.length - 1].arr.push(redisScalar(line.slice(p)))
  }
  return root
}

/** SLOWLOG GET 的回复 → 表格（id / 时间 / 耗时 ms / 命令 / 客户端） */
export function redisSlowlogTable(r: RedisReply): DbTable {
  const rows: string[][] = []
  for (const e of Array.isArray(r) ? r : []) {
    if (!Array.isArray(e)) continue
    const [id, ts, us, args, client, name] = e
    const cmd = Array.isArray(args) ? args.map((x) => (typeof x === 'string' && /[\s"]/.test(x) ? JSON.stringify(x) : String(x ?? ''))).join(' ') : String(args ?? '')
    rows.push([String(id ?? ''), typeof ts === 'number' ? new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 19) : String(ts ?? ''), typeof us === 'number' ? (us / 1000).toFixed(2) : String(us ?? ''), cmd, String(client ?? ''), String(name ?? '')])
  }
  return { columns: ['id', 'time', 'ms', 'command', 'client', 'name'], rows }
}

/** redis-cli --bigkeys 输出里的「每种类型最大的 key」→ 表格 */
export function parseBigkeys(text: string): DbTable {
  const rows: string[][] = []
  // 版本不同 key 的引号写法不同：'key' / "key" / '"key"'
  for (const m of text.matchAll(/^Biggest\s+(\w+)\s+found\s+(?:'(.*)'|"(.*)")\s+has\s+(\d+)\s+(\w+)/gm)) rows.push([m[1], (m[2] ?? m[3] ?? '').replace(/^"(.*)"$/, '$1'), m[4], m[5]])
  return { columns: ['type', 'key', 'size', 'unit'], rows }
}

// ── 各视图的语句 ──────────────────────────────────────────
const one = (sql: string) => sql.replace(/\s+/g, ' ').trim()
export const MYSQL_SQL = {
  version: 'SELECT VERSION() AS version',
  sessions: one(`SELECT ID, USER, HOST, DB, COMMAND, TIME, STATE, LEFT(INFO, 500) AS INFO FROM information_schema.PROCESSLIST
    WHERE ID <> CONNECTION_ID() ORDER BY (COMMAND = 'Sleep'), TIME DESC LIMIT 1000`),
  locks: one(`SELECT wait_age_secs, locked_table, locked_index, locked_type, waiting_pid, LEFT(waiting_query, 300) AS waiting_query,
    blocking_pid, LEFT(blocking_query, 300) AS blocking_query FROM sys.innodb_lock_waits ORDER BY wait_age_secs DESC LIMIT 200`),
  slowVars: 'SELECT @@global.slow_query_log AS slow_query_log, @@global.slow_query_log_file AS file, @@global.long_query_time AS long_query_time, @@global.log_output AS log_output',
  slowTable: one(`SELECT start_time, user_host, query_time, lock_time, rows_sent, rows_examined, db, LEFT(sql_text, 4000) AS sql_text
    FROM mysql.slow_log ORDER BY start_time DESC LIMIT 5000`),
  tables: (n: number) => one(`SELECT table_schema AS db, table_name AS tbl, engine, table_rows AS rows_est,
    ROUND(data_length / 1048576, 2) AS data_mb, ROUND(index_length / 1048576, 2) AS index_mb, ROUND((data_length + index_length) / 1048576, 2) AS total_mb
    FROM information_schema.TABLES WHERE table_schema NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
    ORDER BY data_length + index_length DESC LIMIT ${n}`),
  replica: 'SHOW REPLICA STATUS',
  replicaOld: 'SHOW SLAVE STATUS',
  primary: 'SHOW MASTER STATUS',
  primaryNew: 'SHOW BINARY LOG STATUS',
}
const pgQ = (col: string) => `left(regexp_replace(${col}, '\\s+', ' ', 'g'), 500)`
export const PG_SQL = {
  version: 'SELECT version()',
  sessions: one(`SELECT pid, usename AS user, datname AS db, application_name AS app, client_addr AS client, state,
    coalesce(EXTRACT(EPOCH FROM now() - query_start)::int, 0) AS query_sec, coalesce(EXTRACT(EPOCH FROM now() - xact_start)::int, 0) AS xact_sec,
    coalesce(wait_event_type, '') AS wait_type, coalesce(wait_event, '') AS wait_event, ${pgQ('query')} AS query
    FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND backend_type = 'client backend'
    ORDER BY (state = 'idle'), query_start NULLS LAST LIMIT 1000`),
  locks: one(`SELECT a.pid AS waiting_pid, a.usename AS user, coalesce(EXTRACT(EPOCH FROM now() - a.query_start)::int, 0) AS wait_sec,
    ${pgQ('a.query')} AS waiting_query, b.pid AS blocking_pid, b.state AS blocking_state, ${pgQ('b.query')} AS blocking_query
    FROM pg_stat_activity a JOIN LATERAL unnest(pg_blocking_pids(a.pid)) AS bp(pid) ON true JOIN pg_stat_activity b ON b.pid = bp.pid
    ORDER BY wait_sec DESC LIMIT 200`),
  statements: (col: 'total_exec_time' | 'total_time') => one(`SELECT calls, round(${col}::numeric, 1) AS total_ms,
    round((${col} / greatest(calls, 1))::numeric, 2) AS avg_ms, rows, ${pgQ('query')} AS query
    FROM pg_stat_statements ORDER BY ${col} DESC LIMIT 50`),
  tables: (n: number) => one(`SELECT schemaname AS schema, relname AS tbl, n_live_tup AS rows_est,
    pg_size_pretty(pg_relation_size(relid)) AS table_size, pg_size_pretty(pg_indexes_size(relid)) AS index_size,
    pg_size_pretty(pg_total_relation_size(relid)) AS total_size, pg_total_relation_size(relid) AS total_bytes
    FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT ${n}`),
  recovery: one(`SELECT pg_is_in_recovery() AS in_recovery,
    CASE WHEN pg_is_in_recovery() THEN coalesce(EXTRACT(EPOCH FROM now() - pg_last_xact_replay_timestamp())::int::text, '') ELSE '' END AS replay_delay_sec`),
  replicas: one(`SELECT application_name AS app, client_addr AS client, state, sync_state, sent_lsn, replay_lsn,
    coalesce(replay_lag::text, '') AS replay_lag FROM pg_stat_replication`),
}
export const REDIS_ARGS = {
  version: ['INFO', 'server'],
  info: ['INFO'],
  slowlog: ['--no-raw', 'SLOWLOG', 'GET', '128'],
  bigkeys: ['--bigkeys', '-i', '0.01'],
  memory: ['INFO', 'memory'],
  doctor: ['MEMORY', 'DOCTOR'],
  clients: ['CLIENT', 'LIST'],
  keyspace: ['INFO', 'keyspace'],
}

// ── 客户端（Redis CLIENT LIST）─────────────────────────────
const CLIENT_COLS = ['id', 'addr', 'name', 'user', 'db', 'age', 'idle', 'flags', 'cmd']
/** CLIENT LIST（每行 k=v 空格分隔）→ 表格；去掉本次查询自己（cmd=client|list） */
export function parseRedisClients(text: string): DbTable {
  const rows: string[][] = []
  for (const l of text.replace(/\r/g, '').split('\n')) {
    if (!l.trim()) continue
    const kv = new Map<string, string>()
    for (const m of l.matchAll(/(\w+)=(\S*)/g)) kv.set(m[1], m[2])
    if (!kv.has('id') || /^client(\|list)?$/i.test(kv.get('cmd') ?? '')) continue
    rows.push(CLIENT_COLS.map((k) => kv.get(k) ?? ''))
  }
  return { columns: CLIENT_COLS, rows }
}

// ── 切换库 / 表结构 ───────────────────────────────────────
/** 表名、库名、schema 名：不含引号 / 反引号 / 反斜杠 / 控制字符（拼进 SQL 时再加引号） */
// eslint-disable-next-line no-control-regex -- 就是要拒绝控制字符
export const isDbIdent = (v: unknown): v is string => typeof v === 'string' && /^[^\x00-\x1f\x7f`'"\\]{1,64}$/.test(v)
/** 「库」覆盖：MySQL / PG 库名、Redis 库序号；空 = 用连接里配的 */
export function withDatabase(c: DbConn, db: unknown): DbConn {
  if (db === undefined || db === null || db === '') return c
  if (typeof db !== 'string' || (c.kind === 'redis' ? !/^\d{1,2}$/.test(db) : !RE.database.test(db))) throw new Error(tr('非法的库名'))
  return { ...c, database: db }
}
export const DB_LIST_SQL = {
  mysql: 'SHOW DATABASES',
  postgres: 'SELECT datname FROM pg_database WHERE NOT datistemplate AND datallowconn ORDER BY 1',
}
/** INFO keyspace → 有数据的库：[序号, key 数] */
export function redisKeyspace(text: string): [string, number][] {
  return [...text.matchAll(/^db(\d+):keys=(\d+)/gm)].map((m) => [m[1], Number(m[2])])
}
// PG 结构查询里可能带换行 / 制表符的文本列：按 mysql -B 的规则转义，解析时统一还原（非对齐模式不转义会把一行拆乱）
const pgEsc = (x: string) => `replace(replace(replace(coalesce(${x}, ''), chr(92), chr(92) || chr(92)), chr(10), chr(92) || 'n'), chr(9), chr(92) || 't')`
const lit = (s: string) => `'${s}'`   // 已经过 isDbIdent（不含引号 / 反斜杠）
export type DbTableRef = { schema?: string; name: string }
export function schemaTablesSql(kind: 'mysql' | 'postgres', db: string): string {
  if (kind === 'mysql') {
    if (!isDbIdent(db)) throw new Error(tr('先选择一个库'))
    return one(`SELECT table_name AS name, table_type AS type, engine, table_rows AS rows_est, ROUND((data_length + index_length) / 1048576, 2) AS mb,
      table_comment AS comment FROM information_schema.TABLES WHERE table_schema = ${lit(db)} ORDER BY table_name LIMIT 5000`)
  }
  return one(`SELECT n.nspname AS schema, c.relname AS name,
    CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'matview' WHEN 'f' THEN 'foreign' ELSE 'table' END AS type,
    greatest(c.reltuples, 0)::bigint AS rows_est, round(pg_total_relation_size(c.oid) / 1048576.0, 2) AS mb, ${pgEsc("obj_description(c.oid, 'pg_class')")} AS comment
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
    ORDER BY 1, 2 LIMIT 5000`)
}
/** 一张表的字段 / 索引 / 建表语句（MySQL 用 SHOW CREATE；PG 没有，由字段 + 约束 + 索引拼出来） */
export function schemaTableSql(kind: 'mysql' | 'postgres', db: string, t: DbTableRef): { columns: string; indexes: string; ddl: string; extra?: string } {
  if (!isDbIdent(t.name) || (t.schema !== undefined && !isDbIdent(t.schema))) throw new Error(tr('非法的表名'))
  if (kind === 'mysql') {
    if (!isDbIdent(db)) throw new Error(tr('先选择一个库'))
    const where = `table_schema = ${lit(db)} AND table_name = ${lit(t.name)}`
    return {
      columns: one(`SELECT column_name AS name, column_type AS type, is_nullable AS nullable, column_key AS \`key\`, column_default AS \`default\`, extra, column_comment AS comment
        FROM information_schema.COLUMNS WHERE ${where} ORDER BY ordinal_position`),
      indexes: one(`SELECT index_name AS name, IF(non_unique = 0, 'UNIQUE', '') AS uniq, GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ', ') AS columns, index_type AS type
        FROM information_schema.STATISTICS WHERE ${where} GROUP BY index_name, non_unique, index_type ORDER BY index_name = 'PRIMARY' DESC, index_name`),
      ddl: `SHOW CREATE TABLE \`${db}\`.\`${t.name}\``,
    }
  }
  const s = t.schema ?? 'public'
  const reg = `'"${s}"."${t.name}"'::regclass`
  return {
    columns: one(`SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS nullable,
      ${pgEsc('pg_get_expr(d.adbin, d.adrelid)')} AS "default", ${pgEsc('col_description(a.attrelid, a.attnum)')} AS comment
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = ${reg} AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`),
    indexes: one(`SELECT i.indexname AS name, ${pgEsc('i.indexdef')} AS definition, CASE WHEN EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = ${reg} AND k.conname = i.indexname) THEN 'constraint' ELSE '' END AS by_constraint
      FROM pg_indexes i WHERE i.schemaname = ${lit(s)} AND i.tablename = ${lit(t.name)} ORDER BY i.indexname`),
    ddl: one(`SELECT c.relkind AS kind, ${pgEsc("CASE WHEN c.relkind IN ('v', 'm') THEN pg_get_viewdef(c.oid, true) END")} AS viewdef FROM pg_class c WHERE c.oid = ${reg}`),
    extra: one(`SELECT conname AS name, ${pgEsc('pg_get_constraintdef(oid)')} AS definition FROM pg_constraint WHERE conrelid = ${reg} AND contype IN ('p', 'u', 'f', 'c', 'x') ORDER BY contype = 'p' DESC, conname`),
  }
}
/** PG：字段 + 约束 + 索引 → 建表语句（近似，给人看；视图用 pg_get_viewdef） */
export function pgDdl(t: DbTableRef, cols: DbTable, cons: DbTable, idx: DbTable, kind: string, viewdef: string): string {
  const name = `"${t.schema ?? 'public'}"."${t.name}"`
  if (kind === 'v' || kind === 'm') return `CREATE ${kind === 'm' ? 'MATERIALIZED ' : ''}VIEW ${name} AS\n${viewdef.trim()}`
  const at = (tb: DbTable, n: string) => tb.columns.indexOf(n)
  const lines = cols.rows.map((r) => `  "${r[at(cols, 'name')]}" ${r[at(cols, 'type')]}${r[at(cols, 'nullable')] === 'NO' ? ' NOT NULL' : ''}${r[at(cols, 'default')] ? ` DEFAULT ${r[at(cols, 'default')]}` : ''}`)
  for (const r of cons.rows) lines.push(`  CONSTRAINT "${r[0]}" ${r[1]}`)
  const ix = idx.rows.filter((r) => !r[at(idx, 'by_constraint')]).map((r) => `${r[at(idx, 'definition')]};`)
  return [`CREATE TABLE ${name} (\n${lines.join(',\n')}\n);`, ...ix].join('\n')
}

// ── 即席查询（只读）─────────────────────────────────────────
/** 校验（单条只读语句）后拼出发给客户端的输入；MySQL 先把会话设成只读事务，PG 由 PGOPTIONS 只读 */
export function queryInput(kind: DbKind, sql: string, page?: DbPage): { sql: string; input: string; body: string; paged: boolean } {
  if (kind === 'redis') throw new Error(tr('Redis 请用「Key」页签'))
  if (kind === 'mongo') throw new Error('MongoDB 的查询走 mongoQuick.parseMongoQuery')   // i18n-ignore 内部错误（调用方不会走到）
  const r = checkReadonlySql(sql, kind)
  if (!r.ok) throw new Error(r.reason)
  // 分页：查询语句自己没写 LIMIT / OFFSET 时，在后面补 LIMIT (每页 + 1) OFFSET 起点；多取一条用来判断有没有下一页
  const paged = !!page && sqlPageable(r.sql, kind)
  const lim = page ? Math.max(1, Math.min(DB_PAGE_MAX, Math.floor(page.limit))) : 0
  const off = page ? Math.max(0, Math.floor(page.offset)) : 0
  const body = paged ? `${r.sql}\nLIMIT ${lim + 1}${off ? ` OFFSET ${off}` : ''}` : r.sql
  return { sql: r.sql, body, paged, input: `${kind === 'mysql' ? 'SET SESSION TRANSACTION READ ONLY;\n' : ''}${body}\n;\n` }
}
/** psql --csv 输出 → 表格（RFC 4180：双引号包裹、"" 转义、引号里可以有换行） */
export function parseCsvTable(text: string): DbTable {
  const recs: string[][] = []
  let row: string[] = [], f = '', q = false, any = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++ } else q = false } else f += ch; continue }
    if (ch === '"') { q = true; any = true } else if (ch === ',') { row.push(f); f = ''; any = true } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      if (any || f) { row.push(f); recs.push(row) }
      row = []; f = ''; any = false
    } else { f += ch; any = true }
  }
  if (any || f) { row.push(f); recs.push(row) }
  return { columns: recs[0] ?? [], rows: recs.slice(1) }
}

// ── Redis Key 浏览 ────────────────────────────────────────
export const REDIS_KEY_DEL_DECISION = 'db_key_del'
export const REDIS_PREVIEW_N = 100
/** 用户输入的 key / 匹配模式：不能有换行和 NUL，长度有上限（拼命令时再 shq） */
export const isRedisKey = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 1024 && !/[\0\r\n]/.test(v)
export const isRedisCursor = (v: unknown): v is string => typeof v === 'string' && /^\d{1,20}$/.test(v)
/** 各类型的大小命令 + 预览命令（只读，前 REDIS_PREVIEW_N 项） */
export function redisKeyCmds(type: string): { size?: string; preview?: string[] } {
  const n = String(REDIS_PREVIEW_N - 1)
  switch (type) {
    case 'string': return { size: 'STRLEN', preview: ['GETRANGE', '{k}', '0', '65535'] }
    case 'list': return { size: 'LLEN', preview: ['LRANGE', '{k}', '0', n] }
    case 'set': return { size: 'SCARD', preview: ['SSCAN', '{k}', '0', 'COUNT', String(REDIS_PREVIEW_N)] }
    case 'zset': return { size: 'ZCARD', preview: ['ZRANGE', '{k}', '0', n, 'WITHSCORES'] }
    case 'hash': return { size: 'HLEN', preview: ['HSCAN', '{k}', '0', 'COUNT', String(REDIS_PREVIEW_N)] }
    case 'stream': return { size: 'XLEN', preview: ['XRANGE', '{k}', '-', '+', 'COUNT', String(REDIS_PREVIEW_N)] }
    default: return {}
  }
}
const flat = (r: RedisReply): string => (Array.isArray(r) ? r.map(flat).join(' ') : String(r ?? ''))
/** 预览命令的回复 → 表格（hash / zset 两两成对，SSCAN / HSCAN 取第二项，stream 每条一行） */
export function redisPreviewTable(type: string, r: RedisReply): DbTable | string {
  if (type === 'string') return typeof r === 'string' ? r : flat(r)
  let a = Array.isArray(r) ? r : []
  if (type === 'set' || type === 'hash') a = Array.isArray(a[1]) ? a[1] : []
  const pairs = (cols: string[]) => {
    const rows: string[][] = []
    for (let i = 0; i + 1 < a.length; i += 2) rows.push([flat(a[i]), flat(a[i + 1])])
    return { columns: cols, rows }
  }
  if (type === 'hash') return pairs(['field', 'value'])
  if (type === 'zset') return pairs(['member', 'score'])
  if (type === 'stream') return { columns: ['id', 'fields'], rows: a.map((e) => (Array.isArray(e) ? [flat(e[0]), Array.isArray(e[1]) ? e[1].map(flat).join(' ') : ''] : [flat(e), ''])) }
  return { columns: [type === 'list' ? 'index' : '#', 'value'], rows: a.map((v, i) => [String(i), flat(v)]) }
}
// ── 结果表复制 / 导出 ─────────────────────────────────────
export type DbCopyFormat = 'csv' | 'tsv' | 'markdown' | 'insert'
const csvCell = (v: string) => (/[",\r\n]/.test(v) || /^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
// MySQL 字符串里反斜杠是转义符要双写；PG（standard_conforming_strings）不用
const sqlVal = (v: string, pg: boolean) => (v === 'NULL' ? 'NULL' : /^-?(0|[1-9]\d{0,17})(\.\d+)?$/.test(v) ? v : `'${(pg ? v : v.replace(/\\/g, '\\\\')).replace(/'/g, "''")}'`)
/** 结果表 → 文本。insert：table = 表名（不知道就用 table_name），MySQL 反引号 / PG 双引号；mysql -B 的 NULL 原样写 NULL */
export function tableToText(t: DbTable, fmt: DbCopyFormat, o: { kind?: DbKind; table?: string } = {}): string {
  if (fmt === 'csv') return [t.columns, ...t.rows].map((r) => r.map(csvCell).join(',')).join('\r\n')
  if (fmt === 'tsv') return [t.columns, ...t.rows].map((r) => r.map((v) => v.replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n')
  if (fmt === 'markdown') {
    const esc = (v: string) => v.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
    return [`| ${t.columns.map(esc).join(' | ')} |`, `|${t.columns.map(() => ' --- ').join('|')}|`, ...t.rows.map((r) => `| ${t.columns.map((_c, i) => esc(r[i] ?? '')).join(' | ')} |`)].join('\n')
  }
  const q = (n: string) => (o.kind === 'postgres' ? `"${n.replace(/"/g, '""')}"` : `\`${n.replace(/`/g, '``')}\``)
  const name = (o.table || 'table_name').split('.').map(q).join('.')
  return t.rows.map((r) => `INSERT INTO ${name} (${t.columns.map(q).join(', ')}) VALUES (${t.columns.map((_c, i) => sqlVal(r[i] ?? '', o.kind === 'postgres')).join(', ')});`).join('\n')
}
/** 即席查询里猜表名（INSERT 语句用）：第一个 FROM 后面的标识符 */
export const guessTableName = (sql: string) => /\bfrom\s+([`"]?[\w$]+[`"]?(?:\.[`"]?[\w$]+[`"]?)?)/i.exec(sql)?.[1].replace(/[`"]/g, '')

/** redis-cli --no-raw 的错误回复（退出码仍是 0） */
export const redisErrorOf = (out: string) => /^\(error\) (.*)$/m.exec(out)?.[1]
// Redis 概况页挑出来的指标（其余在「原始输出」里）
export const REDIS_SUMMARY_KEYS = [
  'redis_version', 'redis_mode', 'role', 'uptime_in_days', 'connected_clients', 'blocked_clients', 'used_memory_human', 'used_memory_peak_human',
  'maxmemory_human', 'maxmemory_policy', 'mem_fragmentation_ratio', 'instantaneous_ops_per_sec', 'keyspace_hits', 'keyspace_misses',
  'evicted_keys', 'expired_keys', 'rejected_connections', 'connected_slaves', 'master_link_status', 'master_last_io_seconds_ago', 'rdb_last_bgsave_status', 'aof_enabled',
]

/** MySQL 会话终止 / PG 终止后端：语句（id 已校验为正整数） */
export function dbKillSql(kind: DbKind, id: number): string {
  if (!isDbSessionId(id)) throw new Error(tr('非法的会话 ID'))
  if (kind === 'mysql') return `KILL ${id}`
  if (kind === 'postgres') return `SELECT pg_terminate_backend(${id}) AS terminated`
  if (kind === 'mongo') return `db.killOp(${id})`
  return `CLIENT KILL ID ${id}`
}

/** EXPLAIN：校验（只放 SELECT）后拼出发给客户端的语句；MySQL 先把会话设成只读事务 */
export function explainInput(kind: DbKind, sql: string): { sql: string; input: string } {
  if (kind === 'redis') throw new Error(tr('Redis 没有 EXPLAIN'))
  if (kind === 'mongo') throw new Error('MongoDB 的 EXPLAIN 走 mongoQuick')   // i18n-ignore 内部错误（调用方不会走到）
  const r = checkExplainSql(sql, kind)
  if (!r.ok) throw new Error(r.reason)
  return { sql: r.sql, input: `${kind === 'mysql' ? 'SET SESSION TRANSACTION READ ONLY;\n' : ''}EXPLAIN ${r.sql}\n;\n` }
}

/** EXPLAIN 结果表 → 给人 / AI 看的文本：PG 是一列 QUERY PLAN（逐行拼起来），MySQL 是多列（每行「列=值」） */
export function explainText(kind: DbKind, t: DbTable): string {
  if (kind === 'postgres' || t.columns.length === 1) return t.rows.map((r) => r[0] ?? '').join('\n')
  return t.rows.map((r, i) => `#${i + 1} ${t.columns.map((c, k) => `${c}=${r[k] ?? ''}`).filter((x) => !/=(NULL)?$/.test(x)).join('  ')}`).join('\n')
}

/** 「让 AI 解读」发到对话的消息 */
export function explainPrompt(o: { kind: DbKind; conn: string; version?: string; sql: string; plan: string }): string {
  if (o.kind === 'mongo') return [
    tr('请解读下面这条 MongoDB 查询在 {db} 上的执行计划（连接「{conn}」，用只读的 explain(\'executionStats\') 取得）：', { db: o.version ? `MongoDB ${o.version}` : 'MongoDB', conn: o.conn }),
    tr('指出全集合扫描（COLLSCAN）、扫描文档数远大于返回数、内存排序（SORT 阶段）、没用上合适索引等问题，给出可行的索引（字段顺序遵循 ESR：等值 → 排序 → 范围）或改写建议；需要看集合结构时只用只读命令。'),
    '', '```javascript', o.sql, '```', '', tr('执行计划：'), '```', o.plan || tr('（空）'), '```',
  ].join('\n')
  return [
    tr('请解读下面这条 SQL 在 {db} 上的执行计划（连接「{conn}」，应用以只读方式执行的 EXPLAIN，没有真正执行语句）：', { db: DB_KIND_LABEL[o.kind] + (o.version ? tr('（{v}）', { v: o.version }) : ''), conn: o.conn }),
    tr('指出全表扫描、没用上索引、文件排序 / 临时表、估算行数过大等问题，给出可行的索引或改写建议；需要查表结构时先说明目的，只用只读语句。'),
    '', '```sql', o.sql, '```', '', tr('执行计划：'), '```', o.plan || tr('（空）'), '```',
  ].join('\n')
}

/** 执行记录的命令文本：KILL 语句 + 连接名 + 被终止会话的摘要 */
export function dbAuditCommand(c: DbConn, sql: string, about = ''): string {
  const tail = about.replace(/\p{Cc}+/gu, ' ').trim().slice(0, 200)
  return `${sql}  # ${DB_KIND_LABEL[c.kind]}「${c.name}」${tail ? ` ${tail}` : ''}`   // i18n-ignore 执行记录（存盘）
}
