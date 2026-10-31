// 数据库快查的只读校验（纯逻辑）：判断一段 SQL 是不是单条只读语句。处理字符串 / 引号标识符 / 注释 / PG 美元引号、多语句、
// MySQL 可执行注释（/*! */）和客户端命令（\! 等反斜杠命令会在 mysql / psql 客户端里执行 shell）。
// 这是第一道闸：执行时还有第二道（MySQL 会话设为 READ ONLY，PG 用 default_transaction_read_only），两道都过才会跑。
import { tr } from '../i18n/i18n.js'

export type SqlDialect = 'mysql' | 'postgres'
export type SqlCheck = { ok: true; sql: string } | { ok: false; reason: string }

// 去掉注释、把字符串字面量换成 ''、引号标识符换成 ""，得到只剩「代码」的文本；遇到没法安全判断的写法直接给出原因
function scan(sql: string, d: SqlDialect): { code: string; semis: number[]; error?: string } {
  let code = '', i = 0
  const semis: number[] = []   // 代码里分号在原文中的位置（去掉它们 = 去掉语句结尾的分号）
  const n = sql.length
  while (i < n) {
    const c = sql[i], c2 = sql.slice(i, i + 2)
    // 注释
    if (c2 === '/*') {
      if (d === 'mysql' && sql[i + 2] === '!') return { code, semis, error: tr('不支持 MySQL 可执行注释（/*! … */）') }
      let depth = 1, j = i + 2
      while (j < n && depth > 0) {
        if (sql.startsWith('*/', j)) { depth--; j += 2 }
        else if (d === 'postgres' && sql.startsWith('/*', j)) { depth++; j += 2 }
        else j++
      }
      if (depth > 0) return { code, semis, error: tr('注释没有结束（缺少 */）') }
      code += ' '; i = j; continue
    }
    // MySQL 的 -- 注释后面必须跟空白（否则 1--1 是减负数）；PG 不要求
    if (c2 === '--' && (d === 'postgres' || i + 2 >= n || /\s/.test(sql[i + 2])) || (d === 'mysql' && c === '#')) {
      const j = sql.indexOf('\n', i)
      code += ' '; i = j < 0 ? n : j; continue
    }
    // 字符串：MySQL 认反斜杠转义；PG 只有 E'' 里认
    if (c === "'") {
      const bs = d === 'mysql' || /[eE]$/.test(sql.slice(Math.max(0, i - 1), i)) && !/[\w$]/.test(sql[i - 2] ?? '')
      let j = i + 1
      for (;;) {
        if (j >= n) return { code, semis, error: tr('字符串没有结束（缺少引号）') }
        if (bs && sql[j] === '\\') { j += 2; continue }
        if (sql[j] === "'") { if (sql[j + 1] === "'") { j += 2; continue } break }
        j++
      }
      code += "''"; i = j + 1; continue
    }
    // 引号标识符（MySQL 默认模式下双引号也是字符串，一样当字面量处理）
    if (c === '"' || (d === 'mysql' && c === '`')) {
      let j = i + 1
      for (;;) {
        if (j >= n) return { code, semis, error: tr('引号没有结束') }
        if (d === 'mysql' && c === '"' && sql[j] === '\\') { j += 2; continue }
        if (sql[j] === c) { if (sql[j + 1] === c) { j += 2; continue } break }
        j++
      }
      code += '""'; i = j + 1; continue
    }
    // PG 美元引号 $tag$…$tag$
    if (d === 'postgres' && c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))
      if (m && !/[\w$]/.test(sql[i - 1] ?? '')) {
        const end = sql.indexOf(m[0], i + m[0].length)
        if (end < 0) return { code, semis, error: tr('美元引号字符串没有结束') }
        code += "''"; i = end + m[0].length; continue
      }
    }
    if (c === '\\') return { code, semis, error: tr('不支持反斜杠命令（客户端命令可能执行 shell）') }
    if (c === ';') semis.push(i)
    code += c; i++
  }
  return { code, semis }
}

const ALLOWED_FIRST = new Set(['select', 'show', 'explain', 'describe', 'desc', 'with', 'table', 'values'])
// 出现即拒：查询语句里能夹带写操作的关键字（PG 的 WITH … INSERT / UPDATE / DELETE、SELECT … INTO 建表 / 写文件）及结构 / 权限变更。
// 只看代码部分（字符串和引号标识符已经去掉）；常见列名（如 load、comment）和 replace() 等函数名不在内，免得误拒
const WRITE_WORDS = ['insert', 'update', 'delete', 'merge', 'upsert', 'into', 'drop', 'alter', 'create', 'truncate', 'grant', 'revoke']
// 有副作用 / 读服务器文件 / 取锁的函数
const BAD_FUNCS = /\b(pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_switch_wal|pg_switch_xlog|pg_promote|pg_create_restore_point|pg_start_backup|pg_stop_backup|pg_backup_start|pg_backup_stop|pg_create_\w*replication_slot|pg_drop_replication_slot|pg_advisory\w*|pg_try_advisory\w*|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_reset\w*|pg_stat_statements_reset|set_config|nextval|setval|lo_import|lo_export|lo_unlink|lo_create|lo_from_bytea|lo_put|dblink\w*|get_lock|release_lock|release_all_locks|load_file|benchmark|sys_exec|sys_eval)\s*\(/i
const LOCK_CLAUSE = /\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b|\block\s+in\s+share\s+mode\b/i

/**
 * 只读校验：单条语句、首个关键字在白名单里、不含写类关键字 / 有副作用的函数 / FOR UPDATE 等取锁子句。
 * selectOnly：只放 SELECT / WITH … SELECT / TABLE / VALUES（EXPLAIN 用）。通过时 sql = 去掉结尾分号的原文
 */
export function checkReadonlySql(sql: string, dialect: SqlDialect, o: { selectOnly?: boolean } = {}): SqlCheck {
  const src = String(sql ?? '')
  if (!src.trim()) return { ok: false, reason: tr('没有 SQL') }
  if (src.length > 20_000) return { ok: false, reason: tr('SQL 太长（上限 20000 字）') }
  const { code, semis, error } = scan(src, dialect)
  if (error) return { ok: false, reason: error }
  const parts = code.split(';').map((s) => s.trim()).filter(Boolean)
  if (!parts.length) return { ok: false, reason: tr('没有 SQL（只有注释）') }
  if (parts.length > 1) return { ok: false, reason: tr('一次只能执行一条语句（发现多个分号分隔的语句）') }
  const body = parts[0].replace(/^\(+\s*/, '')
  const first = /^[A-Za-z]+/.exec(body)?.[0].toLowerCase() ?? ''
  if (o.selectOnly ? !['select', 'with', 'table', 'values'].includes(first) : !ALLOWED_FIRST.has(first)) {
    const what = first.toUpperCase() || tr('sql|无法识别的语句')
    return { ok: false, reason: o.selectOnly ? tr('只能 EXPLAIN 查询语句（SELECT / WITH … SELECT），这条是 {what}', { what }) : tr('只读模式只放行 SELECT / SHOW / EXPLAIN / DESCRIBE，这条是 {what}', { what }) }
  }
  if (first === 'explain' && /\banaly[sz]e\b/i.test(body)) return { ok: false, reason: tr('EXPLAIN ANALYZE 会真的执行语句，只读模式不放行') }
  if (LOCK_CLAUSE.test(code)) return { ok: false, reason: tr('含 FOR UPDATE / FOR SHARE 等取锁子句，只读模式不放行') }
  const words = new Set((code.toLowerCase().match(/[a-z_][a-z0-9_$]*/g) ?? []))
  const bad = WRITE_WORDS.find((w) => words.has(w))
  if (bad) return { ok: false, reason: tr('含写操作关键字 {word}，只读模式不放行', { word: bad.toUpperCase() }) }
  const f = BAD_FUNCS.exec(code)
  if (f) return { ok: false, reason: tr('含有副作用的函数 {fn}()，只读模式不放行', { fn: f[1] }) }
  // 单条语句里的分号只可能是结尾符：去掉，执行时由调用方统一补
  return { ok: true, sql: src.split('').map((ch, k) => (semis.includes(k) ? ' ' : ch)).join('').trim() }
}

/**
 * 能不能由我们分页：SELECT / WITH / TABLE / VALUES，且最外层没有自己写 LIMIT / OFFSET / FETCH（括号里的子查询不算）。
 * 能的话在末尾补 LIMIT n OFFSET m；用户自己写了 LIMIT 就照用户的来
 */
export function sqlPageable(sql: string, dialect: SqlDialect): boolean {
  const { code, error } = scan(String(sql ?? ''), dialect)
  if (error) return false
  const body = code.replace(/;\s*$/, '').trim().replace(/^\(+\s*/, '')
  if (!/^(select|with|table|values)\b/i.test(body)) return false
  let depth = 0, top = ''
  for (const ch of body) { if (ch === '(') depth++; else if (ch === ')') depth--; else if (depth === 0) top += ch }
  return !/\b(limit|offset|fetch)\b/i.test(top)
}

/** EXPLAIN 用：用户贴的 SQL 如已带 EXPLAIN 先去掉前缀（PG 的选项括号 / MySQL 的 FORMAT=），带 ANALYZE 的拒绝；再按「只放查询语句」校验 */
export function checkExplainSql(sql: string, dialect: SqlDialect): SqlCheck {
  let s = String(sql ?? '').trim()
  if (!/^explain\b/i.test(s)) return checkReadonlySql(s, dialect, { selectOnly: true })
  s = s.slice(7).trimStart()
  for (let m; (m = /^(\([^)]*\)|format\s*=\s*\w+|analy[sz]e|verbose|extended|partitions)\s*/i.exec(s)) && m[0];) {
    if (/analy[sz]e/i.test(m[0])) return { ok: false, reason: tr('EXPLAIN ANALYZE 会真的执行语句，这里只做 EXPLAIN') }
    s = s.slice(m[0].length)
  }
  return checkReadonlySql(s, dialect, { selectOnly: true })
}
