// MongoDB 快查（纯逻辑）：在目标机上调用 mongosh（或 docker exec 进容器）。和 MySQL / PG / Redis 同一套通道（见 dbQuick.dbCommand）：
// stdin 第一行是密码（读进环境变量 MONGO_PWD），其余是我们生成的 mongosh 脚本（经 --eval 交给 mongosh）。
// 脚本开头用 process.env.MONGO_PWD 拼连接串 new Mongo(uri)，密码不进命令行 / 进程列表 / 日志。
// 只读：「查询」页签里用户写的是 shell 语法（db.c.find({...}).sort(...)），这里自己解析成 EJSON 再拼进脚本，不把用户文本当 JS 执行；
// 只放 find / findOne / aggregate / countDocuments / distinct 等读操作，拒绝 $where / $function / $accumulator / $out / $merge。
import type { DbConn, DbTable, DbViewResult } from './dbQuick.js'
import { tr } from '../i18n/i18n.js'

export const MONGO_DEFAULT_LIMIT = 1000
export const MONGO_SCRIPT_MAX = 100 * 1024   // 脚本经 --eval 放在命令行参数里，单个参数有长度上限（Linux 128KB）

// ── 连接与输出 ───────────────────────────────────────────
/** 脚本开头：连库（密码取自环境变量）+ 输出函数。文档逐行输出（@@doc），输出被截断时只丢最后几条，不会整段 JSON 解析失败 */
export function mongoPrelude(c: DbConn): string {
  const host = c.host || '127.0.0.1'
  const hp = `${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${c.port || 27017}`
  return [
    `var __hp = ${JSON.stringify(hp)}, __user = ${JSON.stringify(c.user ?? '')};`,
    `var __auth = __user ? encodeURIComponent(__user) + ':' + encodeURIComponent(process.env.MONGO_PWD || '') + '@' : '';`,
    `var __conn = new Mongo('mongodb://' + __auth + __hp + '/?directConnection=true' + (__user ? '&authSource=admin' : ''));`,
    `db = __conn.getDB(${JSON.stringify(c.database || 'test')});`,
    `function __out(x) { print('@@json ' + EJSON.stringify(x)); }`,
    `function __docs(a) { a.forEach(function (d) { print('@@doc ' + EJSON.stringify(d)); }); }`,
  ].join('\n')
}
export const mongoJs = (c: DbConn, body: string) => `${mongoPrelude(c)}\n${body}\n`

/** mongosh 输出 → @@json 的值 / @@doc 的文档列表（其余行忽略：警告、提示） */
export function mongoParseOut(stdout: string): { json?: unknown; docs: unknown[] } {
  const docs: unknown[] = []
  let json: unknown
  for (const l of stdout.replace(/\r/g, '').split('\n')) {
    if (l.startsWith('@@doc ')) { try { docs.push(JSON.parse(l.slice(6))) } catch { /* 被截断的最后一行 */ } }
    else if (l.startsWith('@@json ')) { try { json = JSON.parse(l.slice(7)) } catch { /* 同上 */ } }
  }
  return { json, docs }
}

// ── EJSON → 显示 ─────────────────────────────────────────
type J = null | boolean | number | string | J[] | { [k: string]: J }
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
/** EJSON 包装（$oid / $date / $numberLong …）→ 给人看的值；普通对象 / 数组递归简化 */
export function ejsonPlain(v: unknown): J {
  if (Array.isArray(v)) return v.map(ejsonPlain)
  if (!isObj(v)) return (v ?? null) as J
  const k = Object.keys(v)
  if (k.length === 1) {
    const x = v[k[0]]
    if (k[0] === '$oid') return `ObjectId("${String(x)}")`
    if (k[0] === '$date') return isObj(x) && '$numberLong' in x ? new Date(Number(x.$numberLong)).toISOString() : String(x)
    if (['$numberLong', '$numberDecimal', '$numberDouble', '$numberInt'].includes(k[0])) return String(x)
    if (k[0] === '$regularExpression' && isObj(x)) return `/${String(x.pattern)}/${String(x.options ?? '')}`
    if (k[0] === '$timestamp' && isObj(x)) return `Timestamp(${String(x.t)}, ${String(x.i)})`
    if (k[0] === '$binary') return 'Binary(…)'
    if (k[0] === '$uuid') return `UUID("${String(x)}")`
  }
  return Object.fromEntries(k.map((key) => [key, ejsonPlain(v[key])]))
}
export const ejsonCell = (v: unknown): string => { const p = ejsonPlain(v); return p === null ? 'null' : typeof p === 'object' ? JSON.stringify(p) : String(p) }
/** 文档列表 → 表格：列 = 所有文档顶层字段的并集（_id 在前，按出现顺序），嵌套对象 / 数组显示成紧凑 JSON */
export function docsToTable(docs: unknown[], maxCols = 200): DbTable {
  const cols: string[] = []
  const seen = new Set<string>()
  for (const d of docs) for (const k of isObj(d) ? Object.keys(d) : ['value']) if (!seen.has(k) && cols.length < maxCols) { seen.add(k); cols.push(k) }
  const i = cols.indexOf('_id')
  if (i > 0) { cols.splice(i, 1); cols.unshift('_id') }
  return { columns: cols, rows: docs.map((d) => cols.map((c) => (isObj(d) ? (c in d ? ejsonCell(d[c]) : '') : c === 'value' ? ejsonCell(d) : ''))) }
}

// ── shell 语法的值 → EJSON（不执行，自己解析）───────────────────
const FORBIDDEN = new Set(['$where', '$function', '$accumulator', '$out', '$merge'])
class P {
  i = 0
  constructor(readonly s: string) {}
  err(m: string): never { throw new Error(tr('{msg}（第 {n} 个字符附近）', { msg: m, n: this.i + 1 })) }
  ws() {
    for (;;) {
      while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++
      if (this.s.startsWith('//', this.i)) { const j = this.s.indexOf('\n', this.i); this.i = j < 0 ? this.s.length : j; continue }
      if (this.s.startsWith('/*', this.i)) { const j = this.s.indexOf('*/', this.i + 2); if (j < 0) this.err(tr('注释没有结束')); this.i = j + 2; continue }
      return
    }
  }
  peek() { this.ws(); return this.s[this.i] ?? '' }
  eat(ch: string) { if (this.peek() !== ch) this.err(tr('缺少「{ch}」', { ch })); this.i++ }
  ident(): string { this.ws(); const m = /^[A-Za-z_$][\w$]*/.exec(this.s.slice(this.i)); if (!m) this.err(tr('看不懂的写法')); this.i += m[0].length; return m[0] }
  str(): string {
    const q = this.s[this.i++]
    let out = ''
    for (;;) {
      if (this.i >= this.s.length) this.err(tr('字符串没有结束'))
      const ch = this.s[this.i++]
      if (ch === q) return out
      if (ch !== '\\') { out += ch; continue }
      const e = this.s[this.i++]
      if (e === 'u') { out += String.fromCharCode(parseInt(this.s.slice(this.i, this.i + 4), 16)); this.i += 4 } else out += ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '0': '\0' } as Record<string, string>)[e] ?? e
    }
  }
  num(): number {
    const m = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(this.s.slice(this.i))
    if (!m) this.err(tr('看不懂的数字'))
    this.i += m[0].length
    return Number(m[0])
  }
  args(): J[] {
    this.eat('(')
    const a: J[] = []
    while (this.peek() !== ')') { a.push(this.value()); if (this.peek() === ',') this.i++; else break }
    this.eat(')')
    return a
  }
  value(): J {
    const ch = this.peek()
    if (ch === '{') return this.obj()
    if (ch === '[') { this.i++; const a: J[] = []; while (this.peek() !== ']') { a.push(this.value()); if (this.peek() === ',') this.i++; else break } this.eat(']'); return a }
    if (ch === '"' || ch === "'") return this.str()
    if (ch === '/') {   // 正则字面量
      let j = this.i + 1, cls = false
      for (; j < this.s.length; j++) { const c = this.s[j]; if (c === '\\') { j++; continue } if (c === '[') cls = true; else if (c === ']') cls = false; else if (c === '/' && !cls) break }
      if (j >= this.s.length) this.err(tr('正则没有结束'))
      const pattern = this.s.slice(this.i + 1, j)
      const flags = /^[a-z]*/.exec(this.s.slice(j + 1))![0]
      this.i = j + 1 + flags.length
      return { $regularExpression: { pattern, options: flags.split('').sort().join('') } }
    }
    if (/[-\d.]/.test(ch)) return this.num()
    let id = this.ident()
    if (id === 'new') id = this.ident()
    if (id === 'true') return true
    if (id === 'false') return false
    if (id === 'null' || id === 'undefined') return null
    const a = this.peek() === '(' ? this.args() : this.err(tr('不支持的写法：{id}', { id }))
    const s0 = a[0]
    switch (id) {
      case 'ObjectId': case 'ObjectID':
        if (typeof s0 !== 'string' || !/^[0-9a-fA-F]{24}$/.test(s0)) this.err(tr('ObjectId 要 24 位十六进制字符串'))
        return { $oid: s0.toLowerCase() }
      case 'ISODate': case 'Date': {
        const d = s0 === undefined ? new Date() : new Date(s0 as string | number)
        if (Number.isNaN(d.getTime())) this.err(tr('日期看不懂：{v}', { v: String(s0) }))
        return { $date: d.toISOString() }
      }
      case 'NumberLong': return { $numberLong: String(s0 ?? 0) }
      case 'NumberInt': case 'NumberDouble': case 'Number': return Number(s0 ?? 0)
      case 'NumberDecimal': case 'Decimal128': return { $numberDecimal: String(s0 ?? 0) }
      case 'Timestamp': return { $timestamp: { t: Number(s0 ?? 0), i: Number(a[1] ?? 0) } }
      case 'UUID': if (typeof s0 !== 'string') this.err(tr('UUID 要字符串')); return { $uuid: s0 }
      default: return this.err(tr('不支持的函数：{id}()', { id }))
    }
  }
  obj(): { [k: string]: J } {
    this.eat('{')
    const o: { [k: string]: J } = {}
    while (this.peek() !== '}') {
      const ch = this.peek()
      const k = ch === '"' || ch === "'" ? this.str() : /[\d-]/.test(ch) ? String(this.num()) : this.ident()
      if (FORBIDDEN.has(k)) this.err(tr('只读查询不支持 {op}', { op: k }))
      this.eat(':')
      o[k] = this.value()
      if (this.peek() === ',') this.i++; else break
    }
    this.eat('}')
    return o
  }
}
/** 单个值（过滤条件 / 管道 …）：shell 语法 → EJSON；拒绝会执行 JS 或写数据的操作符 */
export function parseMongoValue(src: string): J {
  const p = new P(src)
  const v = p.value()
  if (p.peek()) p.err(tr('后面还有多余的内容'))
  return v
}

// ── 只读查询：解析 db.c.method(...).chain(...) ─────────────────
export type MongoQuery =
  | { kind: 'show'; what: 'collections' | 'dbs' }
  | { kind: 'db'; method: 'stats' | 'getCollectionNames' }
  | { kind: 'coll'; coll: string; method: string; args: J[]; chain: { name: string; args: J[] }[] }
const COLL_METHODS = new Set(['find', 'findOne', 'aggregate', 'countDocuments', 'count', 'distinct', 'estimatedDocumentCount', 'getIndexes', 'stats'])
const FIND_CHAIN = new Set(['sort', 'limit', 'skip', 'projection', 'hint', 'maxTimeMS', 'count', 'toArray', 'pretty', 'explain'])
const COLL_RE = /^[A-Za-z0-9_-][\w.-]{0,119}$/   // 集合名：不收 $ 开头 / 系统集合以外的怪名字
export function parseMongoQuery(text: string): MongoQuery {
  const s = String(text ?? '').trim().replace(/;\s*$/, '').trim()
  if (!s) throw new Error(tr('没有查询语句'))
  if (s.length > 20_000) throw new Error(tr('查询太长（上限 20000 字）'))
  const show = /^show\s+(\w+)$/i.exec(s)
  if (show) {
    const w = show[1].toLowerCase()
    if (w === 'collections' || w === 'tables') return { kind: 'show', what: 'collections' }
    if (w === 'dbs' || w === 'databases') return { kind: 'show', what: 'dbs' }
    throw new Error(tr('不支持 show {what}', { what: show[1] }))
  }
  if (/^db\.(stats|getCollectionNames)\s*\(\s*\)$/.test(s)) return { kind: 'db', method: s.slice(3, s.indexOf('(')).trim() as 'stats' | 'getCollectionNames' }
  if (!s.startsWith('db.')) throw new Error(tr('只读查询要以 db. 开头，例如 db.orders.find({ status: "paid" })；也支持 show collections / show dbs'))
  let coll: string, rest: string
  const gc = /^db\.getCollection\(\s*(["'])(.+?)\1\s*\)\s*\./.exec(s)
  if (gc) { coll = gc[2]; rest = s.slice(gc[0].length) } else {
    const m = new RegExp(`^db\\.(.+?)\\.(${[...COLL_METHODS].join('|')})\\s*\\(`).exec(s)
    if (!m) throw new Error(tr('只读查询只支持 {list}', { list: [...COLL_METHODS].join(' / ') }))
    coll = m[1]; rest = s.slice(3 + m[1].length + 1)
  }
  if (!COLL_RE.test(coll) || coll.startsWith('system.')) throw new Error(tr('集合名不支持：{name}', { name: coll }))
  const p = new P(rest)
  const method = p.ident()
  if (!COLL_METHODS.has(method)) p.err(tr('只读查询不支持 {op}()', { op: method }))
  const args = p.args()
  const chain: { name: string; args: J[] }[] = []
  while (p.peek() === '.') {
    p.i++
    const name = p.ident()
    if (method !== 'find' || !FIND_CHAIN.has(name)) p.err(tr('不支持 .{name}()', { name }))
    chain.push({ name, args: p.args() })
  }
  if (p.peek()) p.err(tr('后面还有多余的内容'))
  if (method === 'aggregate') for (const st of Array.isArray(args[0]) ? args[0] : []) if (isObj(st) && Object.keys(st).some((k) => FORBIDDEN.has(k))) throw new Error(tr('只读查询不支持 $out / $merge'))
  return { kind: 'coll', coll, method, args, chain }
}

const ej = (v: J | undefined) => `EJSON.parse(${JSON.stringify(JSON.stringify(v ?? {}))})`
const num = (v: J | undefined, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : d)
/** 能不能由我们分页：find 自己没写 limit / skip / count，aggregate 管道里没有 $limit / $skip */
export function mongoPageable(q: MongoQuery): boolean {
  if (q.kind !== 'coll') return false
  if (q.method === 'find') return !q.chain.some((x) => ['limit', 'skip', 'count'].includes(x.name))
  if (q.method === 'aggregate') return !(Array.isArray(q.args[0]) ? q.args[0] : []).some((st) => isObj(st) && ('$limit' in st || '$skip' in st))
  return false
}
/** 查询 → mongosh 脚本主体（结果逐条 @@doc 输出）；explain = 看执行计划（只支持 find / aggregate）；page = 分页（多取一条判断有没有下一页） */
export function mongoQueryBody(q: MongoQuery, explain = false, page?: { offset: number; limit: number }): string {
  if (q.kind === 'show') {
    if (explain) throw new Error(tr('只能 EXPLAIN find / aggregate'))
    return q.what === 'dbs'
      ? '/*ls:show-dbs*/ __docs(db.adminCommand({ listDatabases: 1 }).databases.map(function (d) { return { name: d.name, sizeOnDisk_mb: Math.round(d.sizeOnDisk / 1048576 * 100) / 100, empty: !!d.empty }; }));'
      : '/*ls:show-collections*/ __docs(db.getCollectionInfos().map(function (c) { return { name: c.name, type: c.type }; }));'
  }
  if (q.kind === 'db') {
    if (explain) throw new Error(tr('只能 EXPLAIN find / aggregate'))
    return q.method === 'stats'
      ? '/*ls:db-stats*/ var __s = db.stats(); __docs(Object.keys(__s).map(function (k) { return { key: k, value: __s[k] }; }));'
      : '/*ls:collection-names*/ __docs(db.getCollectionNames().map(function (n) { return { name: n }; }));'
  }
  const c = `db.getCollection(${JSON.stringify(q.coll)})`
  const a = q.args
  const tag = `/*ls:${q.method}*/ `
  if (q.method === 'find') {
    const chain = q.chain.filter((x) => !['toArray', 'pretty', 'explain'].includes(x.name))
    const asCount = chain.some((x) => x.name === 'count')
    let cur = `${c}.find(${ej(a[0])}${a[1] !== undefined ? `, ${ej(a[1])}` : ''})`
    for (const x of chain) {
      if (x.name === 'sort' || x.name === 'projection' || x.name === 'hint') cur += `.${x.name}(${ej(x.args[0])})`
      else if (x.name === 'limit' || x.name === 'skip' || x.name === 'maxTimeMS') cur += `.${x.name}(${num(x.args[0], 0)})`
    }
    if (explain) return `${tag}__out(${cur}.explain('executionStats'));`
    if (asCount) return `${tag}__docs([{ count: ${c}.countDocuments(${ej(a[0])}) }]);`
    if (page && mongoPageable(q)) { if (page.offset > 0) cur += `.skip(${Math.floor(page.offset)})`; cur += `.limit(${Math.floor(page.limit) + 1})` }
    else if (!chain.some((x) => x.name === 'limit' && num(x.args[0], 0) > 0)) cur += `.limit(${MONGO_DEFAULT_LIMIT})`
    return `${tag}__docs(${cur}.toArray());`
  }
  if (q.method === 'aggregate') {
    const pipe = Array.isArray(a[0]) ? a[0] : []
    if (explain) return `${tag}__out(${c}.explain('executionStats').aggregate(${ej(pipe)}));`
    const tail: J[] = page && mongoPageable(q)
      ? [...(page.offset > 0 ? [{ $skip: Math.floor(page.offset) } as J] : []), { $limit: Math.floor(page.limit) + 1 }]
      : [{ $limit: MONGO_DEFAULT_LIMIT }]   // 不分页时最多取 1000 条
    return `${tag}__docs(${c}.aggregate(${ej([...pipe, ...tail])}${a[1] !== undefined ? `, ${ej(a[1])}` : ''}).toArray());`
  }
  if (explain) throw new Error(tr('只能 EXPLAIN find / aggregate'))
  if (q.method === 'findOne') return `${tag}var __d = ${c}.findOne(${ej(a[0])}${a[1] !== undefined ? `, ${ej(a[1])}` : ''}); __docs(__d === null ? [] : [__d]);`
  if (q.method === 'countDocuments' || q.method === 'count') return `${tag}__docs([{ count: ${c}.countDocuments(${ej(a[0])}) }]);`
  if (q.method === 'estimatedDocumentCount') return `${tag}__docs([{ count: ${c}.estimatedDocumentCount() }]);`
  if (q.method === 'distinct') {
    if (typeof a[0] !== 'string') throw new Error(tr('distinct 的第一个参数是字段名（字符串）'))
    return `${tag}__docs(${c}.distinct(${JSON.stringify(a[0])}, ${ej(a[1])}).slice(0, ${MONGO_DEFAULT_LIMIT}).map(function (v) { return { value: v }; }));`
  }
  if (q.method === 'getIndexes') return `${tag}__docs(${c}.getIndexes());`
  return `${tag}var __s = ${c}.stats(); __docs(Object.keys(__s).filter(function (k) { return k !== 'indexDetails' && k !== 'wiredTiger'; }).map(function (k) { return { key: k, value: __s[k] }; }));`
}
/** 规范化的查询文本（执行记录 / 结果标题用）：去掉结尾分号和多余空白 */
export const mongoQueryText = (t: string) => t.trim().replace(/;\s*$/, '').replace(/\s+/g, ' ')

/** explain('executionStats') → 摘要文本（执行计划阶段链 + 扫描行数）+ 关键数字表 */
export function mongoExplain(plan: unknown): { text: string; table: DbTable } {
  const p = isObj(plan) ? plan : {}
  const qp = (isObj(p.queryPlanner) ? p.queryPlanner : isObj(p.stages) ? {} : p.queryPlanner) as Record<string, unknown> | undefined
  // aggregate 的 explain 可能包一层 stages[0].$cursor
  const cur = Array.isArray(p.stages) && isObj(p.stages[0]) && isObj((p.stages[0] as Record<string, unknown>).$cursor) ? (p.stages[0] as Record<string, Record<string, unknown>>).$cursor : undefined
  const planner = (qp && isObj(qp) && Object.keys(qp).length ? qp : (cur?.queryPlanner as Record<string, unknown> | undefined)) ?? {}
  const es = (isObj(p.executionStats) ? p.executionStats : isObj(cur?.executionStats) ? cur?.executionStats : {}) as Record<string, unknown>
  const chainOf = (st: unknown): string[] => { if (!isObj(st)) return []; const name = `${String(st.stage ?? '?')}${st.indexName ? `(${String(st.indexName)})` : ''}`; return [name, ...chainOf(st.inputStage ?? (Array.isArray(st.inputStages) ? st.inputStages[0] : undefined))] }
  const stages = chainOf(planner.winningPlan && isObj(planner.winningPlan) && isObj((planner.winningPlan as Record<string, unknown>).queryPlan) ? (planner.winningPlan as Record<string, unknown>).queryPlan : planner.winningPlan)
  const items: [string, string][] = [
    [tr('执行计划'), stages.join(' ← ') || tr('（无）')],
    [tr('返回文档'), ejsonCell(es.nReturned ?? '')],
    [tr('扫描文档'), ejsonCell(es.totalDocsExamined ?? '')],
    [tr('扫描索引键'), ejsonCell(es.totalKeysExamined ?? '')],
    [tr('耗时 ms'), ejsonCell(es.executionTimeMillis ?? '')],
    [tr('mongo|集合'), ejsonCell(planner.namespace ?? '')],
  ]
  const text = [
    ...items.map(([k, v]) => tr('{k}：{v}', { k, v })),
    stages.includes('COLLSCAN') ? tr('⚠ 有全集合扫描（COLLSCAN）：没用上索引') : '',
    '', JSON.stringify(ejsonPlain(planner.winningPlan ?? {}), null, 2),
  ].filter((x, i, a) => x || a[i - 1]).join('\n')
  return { text, table: { columns: [tr('项'), tr('值')], rows: items.map(([k, v]) => [k, v]) } }
}

// ── 视图 ────────────────────────────────────────────────
export const MONGO_VIEW_JS = {
  version: '/*ls:version*/ __out(db.version());',
  databases: '/*ls:databases*/ __out(db.adminCommand({ listDatabases: 1, nameOnly: true }).databases.map(function (d) { return d.name; }));',
  info: `/*ls:info*/ var s = db.adminCommand({ serverStatus: 1 }), h = db.adminCommand({ hello: 1 }), wt = s.wiredTiger && s.wiredTiger.cache;
__out({ version: s.version, host: s.host, uptime_days: Math.round(s.uptime / 864) / 100, role: h.isWritablePrimary ? (h.setName ? 'primary' : 'standalone') : h.secondary ? 'secondary' : 'other', replset: h.setName || '',
  connections_current: s.connections.current, connections_available: s.connections.available, mem_resident_mb: s.mem.resident,
  cache_used_mb: wt ? Math.round(wt['bytes currently in the cache'] / 1048576) : null, cache_max_mb: wt ? Math.round(wt['maximum bytes configured'] / 1048576) : null,
  op_insert: s.opcounters.insert, op_query: s.opcounters.query, op_update: s.opcounters.update, op_delete: s.opcounters.delete, op_getmore: s.opcounters.getmore, op_command: s.opcounters.command,
  storage_engine: s.storageEngine ? s.storageEngine.name : '' });`,
  // 当前在跑的操作（去掉本次查询自己）；按运行时长倒序
  sessions: `/*ls:currentop*/ var ops = db.getSiblingDB('admin').currentOp({ active: true }).inprog.filter(function (o) { return !(o.command && (o.command.currentOp || o.command.$currentOp)); });
ops.sort(function (a, b) { return (b.secs_running || 0) - (a.secs_running || 0); });
__docs(ops.slice(0, 1000).map(function (o) { return { opid: o.opid, secs: o.secs_running || 0, op: o.op, ns: o.ns || '', client: o.client || o.client_s || '', appName: o.appName || '', desc: o.desc || '', waitingForLock: !!o.waitingForLock, planSummary: o.planSummary || '', command: JSON.stringify(o.command || {}).slice(0, 500) }; }));`,
  // 慢查询：当前库的 profiler（system.profile），按耗时倒序 200 条
  slow: `/*ls:profile*/ var st = db.getProfilingStatus(), n = db.system.profile.countDocuments({});
__out({ was: st.was, slowms: st.slowms, count: n });
__docs(db.system.profile.find({}).sort({ millis: -1 }).limit(200).toArray().map(function (p) { return { millis: p.millis, ts: p.ts, op: p.op, ns: p.ns, docsExamined: p.docsExamined, keysExamined: p.keysExamined, nreturned: p.nreturned, planSummary: p.planSummary || '', command: JSON.stringify(p.command || {}).slice(0, 500), client: p.client || '' }; }));`,
  tables: (n: number) => `/*ls:collstats*/ function __cs(name) { try { var s = db.runCommand({ collStats: name }); if (s.ok) return s; } catch (e) {} var a = db.getCollection(name).aggregate([{ $collStats: { storageStats: {} } }]).toArray()[0]; return a ? a.storageStats : {}; }
var mb = function (x) { return Math.round((x || 0) / 1048576 * 100) / 100; };
var rows = db.getCollectionInfos({ type: 'collection' }).slice(0, 500).map(function (c) { var s = __cs(c.name); return { coll: c.name, count: s.count || 0, size_mb: mb(s.size), storage_mb: mb(s.storageSize), index_mb: mb(s.totalIndexSize), nindexes: s.nindexes || 0, avg_obj_bytes: Math.round(s.avgObjSize || 0) }; });
rows.sort(function (a, b) { return (b.storage_mb + b.index_mb) - (a.storage_mb + a.index_mb); });
__docs(rows.slice(0, ${Math.max(1, Math.min(500, Math.floor(n)))}));`,
  repl: `/*ls:replstatus*/ var r; try { r = db.adminCommand({ replSetGetStatus: 1 }); } catch (e) { r = { ok: 0, errmsg: String(e.message || e) }; }
if (!r.ok) __out({ error: r.errmsg || '' }); else {
  var p = r.members.filter(function (m) { return m.stateStr === 'PRIMARY'; })[0];
  __out({ set: r.set, primary: p ? p.name : '' });
  __docs(r.members.map(function (m) { return { name: m.name, state: m.stateStr, health: m.health, optime: m.optimeDate, lag_sec: p && m.optimeDate && p.optimeDate ? Math.round((p.optimeDate - m.optimeDate) / 1000) : null, syncSource: m.syncSourceHost || '', self: !!m.self }; }));
}`,
  dataSize: '/*ls:datasize*/ __out(db.stats().dataSize);',
  kill: (id: number) => `/*ls:killop*/ __out(db.getSiblingDB('admin').killOp(${Math.floor(id)}));`,
  schemaTables: `/*ls:collections*/ __docs(db.getCollectionInfos().filter(function (c) { return !/^system\\./.test(c.name); }).sort(function (a, b) { return a.name < b.name ? -1 : 1; }).slice(0, 5000).map(function (c) {
  return { name: c.name, type: c.type === 'view' ? 'view' : 'collection', rows_est: c.type === 'view' ? null : db.getCollection(c.name).estimatedDocumentCount(), mb: null, comment: c.options && c.options.viewOn ? 'view on ' + c.options.viewOn : '' }; }));`,
  // 一个集合：字段（抽样 200 条推断，最多两层）、索引、集合定义
  schemaTable: (coll: string) => `/*ls:collschema*/ var N = ${JSON.stringify(coll)}, c = db.getCollection(N), info = db.getCollectionInfos({ name: N })[0] || {};
var view = info.type === 'view', idx = view ? [] : c.getIndexes(), sample = c.aggregate([{ $sample: { size: 200 } }]).toArray(), f = {};
function tp(v) { return v === null ? 'null' : Array.isArray(v) ? 'array' : v instanceof Date ? 'date' : v && v._bsontype ? v._bsontype : typeof v; }
function walk(o, pre, d) { Object.keys(o).forEach(function (k) { var v = o[k], key = pre ? pre + '.' + k : k, t = tp(v); f[key] = f[key] || { n: 0, t: {} }; f[key].n++; f[key].t[t] = 1; if (t === 'object' && d < 1) walk(v, key, d + 1); }); }
sample.forEach(function (d) { walk(d, '', 0); });
__out({ type: info.type || 'collection', options: info.options || {}, indexes: idx, sampled: sample.length, fields: Object.keys(f).map(function (k) { return { field: k, types: Object.keys(f[k].t).join(' | '), seen: Math.round(f[k].n * 100 / Math.max(1, sample.length)) + '%' }; }) });`,
}

/** 视图输出 → DbViewResult */
export function mongoViewResult(view: string, out: { json?: unknown; docs: unknown[] }, o: { db: string } = { db: '' }): DbViewResult {
  const j = isObj(out.json) ? out.json : {}
  if (view === 'info') return { kv: [{ title: tr('概况'), items: Object.entries(j).map(([k, v]): [string, string] => [k, ejsonCell(v)]) }] }
  if (view === 'sessions') return { tables: [{ table: docsToTable(out.docs) }] }
  if (view === 'slow') {
    const off = j.was === 0
    return {
      kv: [{ title: tr('Profiler（当前库 {db}）', { db: o.db || 'test' }), items: [['level', ejsonCell(j.was)], ['slowms', ejsonCell(j.slowms)], [tr('system.profile 记录数'), ejsonCell(j.count)]] }],
      tables: out.docs.length ? [{ title: tr('按耗时排序（最慢的 200 条）'), table: docsToTable(out.docs) }] : undefined,
      note: off ? tr('这个库没开 profiler（level 0），{state}开启要执行 db.setProfilingLevel(1, { slowms: 100 })（写操作，这里不做，可以在「脚本」页签执行；profiler 按库开）。', { state: out.docs.length ? tr('下面是以前留下的记录。') : tr('没有慢查询记录。') }) : !out.docs.length ? tr('没有慢查询记录。') : undefined,
      source: tr('system.profile（库 {db}）', { db: o.db || 'test' }),
    }
  }
  if (view === 'tables') return { tables: [{ title: tr('库 {db} 的集合（按存储 + 索引大小排序）', { db: o.db || 'test' }), table: docsToTable(out.docs) }] }
  if (view === 'repl') {
    if (typeof j.error === 'string') {
      if (/not running with --replSet|NoReplicationEnabled|not.*replica set/i.test(j.error)) return { note: tr('这个实例不是副本集（单机运行）。') }
      throw new Error(j.error)
    }
    return { kv: [{ title: tr('副本集'), items: [['set', ejsonCell(j.set)], ['primary', ejsonCell(j.primary)]] }], tables: [{ title: tr('成员（lag_sec = 落后主节点的秒数）'), table: docsToTable(out.docs) }] }
  }
  throw new Error(tr('非法的视图'))
}

/** 集合结构输出 → 字段表 / 索引表 / 集合定义（createCollection / createView + createIndex 语句） */
export function mongoSchemaDetail(coll: string, json: unknown): { columns: DbTable; indexes: DbTable; ddl: string } {
  const j = isObj(json) ? json : {}
  const fields = Array.isArray(j.fields) ? j.fields : []
  const idx = (Array.isArray(j.indexes) ? j.indexes : []).filter(isObj)
  const opts = isObj(j.options) ? j.options : {}
  const name = JSON.stringify(coll)
  const extra = (x: Record<string, unknown>) => Object.fromEntries(Object.entries(x).filter(([k]) => !['v', 'key', 'name', 'ns'].includes(k)))
  let ddl: string
  if (j.type === 'view') {
    const { viewOn, pipeline, ...rest } = opts as { viewOn?: unknown; pipeline?: unknown }
    ddl = `db.createView(${name}, ${JSON.stringify(viewOn ?? '')}, ${JSON.stringify(ejsonPlain(pipeline ?? []), null, 2)}${Object.keys(rest).length ? `, ${JSON.stringify(ejsonPlain(rest))}` : ''})`
  } else {
    ddl = [
      `db.createCollection(${name}${Object.keys(opts).length ? `, ${JSON.stringify(ejsonPlain(opts), null, 2)}` : ''})`,
      ...idx.filter((x) => x.name !== '_id_').map((x) => `db.getCollection(${name}).createIndex(${JSON.stringify(ejsonPlain(x.key))}, ${JSON.stringify({ name: x.name, ...(ejsonPlain(extra(x)) as object) })})`),
    ].join('\n')
  }
  return {
    columns: { columns: ['field', 'types', 'seen'], rows: fields.filter(isObj).map((f) => [String(f.field ?? ''), String(f.types ?? ''), String(f.seen ?? '')]) },
    indexes: { columns: ['name', 'key', 'options'], rows: idx.map((x) => [String(x.name ?? ''), JSON.stringify(ejsonPlain(x.key)), Object.keys(extra(x)).length ? JSON.stringify(ejsonPlain(extra(x))) : '']) },
    ddl,
  }
}

// ── 脚本页签：规则检测（写操作 / 高危）───────────────────────
export function checkMongoScript(src: string): { stmts: number; counts: [string, number][]; findings: { level: 'danger' | 'warn' | 'info'; line: number; msg: string }[] } {
  const findings: { level: 'danger' | 'warn' | 'info'; line: number; msg: string }[] = []
  const counts = new Map<string, number>()
  const lines = src.replace(/\r/g, '').split('\n')
  lines.forEach((l, i) => {
    const code = l.replace(/\/\/.*$/, '')
    for (const m of code.matchAll(/\.(\w+)\s*\(/g)) {
      const fn = m[1]
      if (!/^(find|findOne|aggregate|countDocuments|insertOne|insertMany|updateOne|updateMany|replaceOne|deleteOne|deleteMany|remove|drop|dropDatabase|createIndex|dropIndex|dropIndexes|renameCollection|bulkWrite|findOneAndUpdate|findOneAndDelete|findOneAndReplace)$/.test(fn)) continue
      counts.set(fn, (counts.get(fn) ?? 0) + 1)
      const rest = code.slice((m.index ?? 0) + m[0].length)
      if (fn === 'dropDatabase') findings.push({ level: 'danger', line: i + 1, msg: tr('dropDatabase：删除整个库') })
      else if (fn === 'drop') findings.push({ level: 'danger', line: i + 1, msg: tr('drop()：删除整个集合') })
      else if (/^(deleteMany|remove)$/.test(fn) && /^\s*(\{\s*\})?\s*\)/.test(rest)) findings.push({ level: 'danger', line: i + 1, msg: tr('{fn} 没有过滤条件：会删除集合里的全部文档', { fn }) })
      else if (fn === 'updateMany' && /^\s*\{\s*\}\s*,/.test(rest)) findings.push({ level: 'danger', line: i + 1, msg: tr('updateMany 没有过滤条件：会改全部文档') })
      else if (/^(dropIndex|dropIndexes|renameCollection)$/.test(fn)) findings.push({ level: 'warn', line: i + 1, msg: tr('{fn}：结构变更，可能影响查询性能或应用', { fn }) })
      else if (fn === 'createIndex') findings.push({ level: 'warn', line: i + 1, msg: tr('createIndex：大集合上建索引耗时长、占资源，建议低峰期做') })
    }
  })
  if (!lines.some((l) => /print|printjson|console\.log/.test(l)) && [...counts.keys()].some((k) => /^(find|findOne|aggregate|countDocuments)$/.test(k))) {
    findings.push({ level: 'info', line: 1, msg: tr('mongosh 脚本里查询的结果只有最后一个表达式会显示，要看中间的结果用 printjson(...)') })
  }
  return { stmts: [...counts.values()].reduce((a, b) => a + b, 0), counts: [...counts], findings }
}
