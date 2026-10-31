// 数据库脚本（纯逻辑）：按语句拆分（处理字符串 / 引号标识符 / 注释 / PG 美元引号 / MySQL DELIMITER）、用户点「智能检测」时的规则检查、
// 执行时给客户端的输入（整体事务包装）和执行记录摘要。检测只是提示，不拦执行；执行前的确认框里会再列一次高危项。
import type { DbConn, DbKind } from './dbQuick.js'
import { DB_KIND_LABEL } from './dbQuick.js'
import { checkReadonlySql } from './sqlReadonly.js'
import { checkMongoScript } from './mongoQuick.js'
import { tk, tr } from '../i18n/i18n.js'

export const DB_SCRIPT_MAX = 5 * 1024 * 1024          // 编辑区 / 导入文件上限
export const DB_SCRIPT_TIMEOUT_MS = 30 * 60_000
export const DB_SCRIPT_DECISION = 'db_script'

export interface SqlStmt { text: string; code: string; line: number; verb: string }
export type FindingLevel = 'danger' | 'warn' | 'info'
export interface ScriptFinding { level: FindingLevel; line: number; msg: string }
export interface ScriptCheck { stmts: number; counts: [string, number][]; findings: ScriptFinding[] }
export interface DbScriptResult { ok: boolean; rc?: number; output: string; error: string; ms: number }

const lineAt = (s: string, i: number) => { let n = 1; for (let k = 0; k < i; k++) if (s.charCodeAt(k) === 10) n++; return n }

/**
 * 拆语句：code = 去掉注释、字面量换成 '' 后的文本（规则只看它，免得字符串里的 DROP 误报）。
 * 语法问题（引号 / 注释没结束）放进 errors，已拆出的语句照常返回
 */
export function splitSql(src: string, kind: 'mysql' | 'postgres'): { stmts: SqlStmt[]; errors: ScriptFinding[]; tail?: string } {
  const stmts: SqlStmt[] = [], errors: ScriptFinding[] = []
  let delim = ';', first = 0, text = '', code = '', i = 0
  const n = src.length
  const push = () => {
    const t = text.trim()
    if (code.trim()) stmts.push({ text: t, code: code.trim(), line: lineAt(src, first), verb: verbOf(code) })
    text = ''; code = ''
  }
  while (i < n) {
    // MySQL 客户端的 DELIMITER 命令：行首、独占一行
    if (kind === 'mysql' && (i === 0 || src[i - 1] === '\n') && !code.trim()) {
      const m = /^[ \t]*delimiter[ \t]+(\S+)[ \t]*(\r?\n|$)/i.exec(src.slice(i))
      if (m) { delim = m[1]; i += m[0].length; text = ''; code = ''; continue }
    }
    if (!code.trim() && !/\s/.test(src[i])) first = i   // 语句的行号 = 第一个代码字符（前面的注释不算）
    const c = src[i], c2 = src.slice(i, i + 2)
    if (c2 === '/*' && !(kind === 'mysql' && src[i + 2] === '!')) {
      const j = src.indexOf('*/', i + 2)
      if (j < 0) { errors.push({ level: 'danger', line: lineAt(src, i), msg: tr('注释没有结束（缺少 */）') }); text += src.slice(i); break }
      text += src.slice(i, j + 2); code += ' '; i = j + 2; continue
    }
    if ((c2 === '--' && (kind === 'postgres' || /\s/.test(src[i + 2] ?? ' '))) || (kind === 'mysql' && c === '#')) {
      const j = src.indexOf('\n', i), e = j < 0 ? n : j
      text += src.slice(i, e); code += ' '; i = e; continue
    }
    const q = c === "'" || c === '"' || (kind === 'mysql' && c === '`') ? c : ''
    if (q) {
      const bs = kind === 'mysql' ? q !== '`' : q === "'" && /[eE]/.test(src[i - 1] ?? '')
      let j = i + 1
      for (;;) {
        if (j >= n) { j = -1; break }
        if (bs && src[j] === '\\') { j += 2; continue }
        if (src[j] === q) { if (src[j + 1] === q) { j += 2; continue } break }
        j++
      }
      if (j < 0) { errors.push({ level: 'danger', line: lineAt(src, i), msg: q === "'" ? tr('字符串没有结束（缺少 {q}）', { q }) : tr('引号没有结束（缺少 {q}）', { q }) }); text += src.slice(i); code += q + q; break }
      text += src.slice(i, j + 1); code += q === "'" ? "''" : '""'; i = j + 1; continue
    }
    if (kind === 'postgres' && c === '$') {
      const m = /^\$([A-Za-z_]\w*)?\$/.exec(src.slice(i))
      if (m && !/[\w$]/.test(src[i - 1] ?? '')) {
        const e = src.indexOf(m[0], i + m[0].length)
        if (e < 0) { errors.push({ level: 'danger', line: lineAt(src, i), msg: tr('美元引号 {q} 没有结束', { q: m[0] }) }); text += src.slice(i); code += "''"; break }
        text += src.slice(i, e + m[0].length); code += "''"; i = e + m[0].length; continue
      }
    }
    if (src.startsWith(delim, i)) { i += delim.length; push(); continue }
    text += c; code += c; i++
  }
  const tail = code.trim() ? delim : undefined   // 最后一条没写结束符：执行时补上（不能无条件补，MySQL 的空语句会报错）
  push()
  return { stmts, errors, tail }
}

const MODS = new Set(['or', 'replace', 'unique', 'temporary', 'temp', 'global', 'local', 'unlogged', 'materialized', 'online', 'offline', 'ignore', 'definer', 'algorithm', 'sql', 'security'])
function verbOf(code: string): string {
  const w = code.toLowerCase().match(/[a-z]+/g) ?? []
  const a = w[0] ?? '?'
  if (['create', 'drop', 'alter'].includes(a)) return `${a} ${w.slice(1).find((x) => !MODS.has(x)) ?? ''}`.trim()
  if (a === 'start' && w[1] === 'transaction') return 'begin'
  return a
}

const UP = (s: string) => s.toUpperCase()
const DDL = /^(create|drop|alter|rename|truncate)\b/

/** 「智能检测」：SQL 脚本按语句检查；Redis 按行检查。tx = 是否整体事务执行（影响几条提示） */
export function checkScript(kind: DbKind, src: string, tx: boolean): ScriptCheck {
  if (kind === 'redis') return checkRedis(src)
  if (kind === 'mongo') return checkMongoScript(src)
  const { stmts, errors } = splitSql(src, kind)
  const f: ScriptFinding[] = [...errors]
  const counts = new Map<string, number>()
  const add = (level: FindingLevel, line: number, msg: string) => f.push({ level, line, msg })
  for (const s of stmts) {
    const v = s.verb, lc = s.code.toLowerCase()
    counts.set(UP(v), (counts.get(UP(v)) ?? 0) + 1)
    let depth = 0, bad = false
    for (const ch of s.code) { if (ch === '(') depth++; else if (ch === ')' && --depth < 0) bad = true }
    if (bad || depth !== 0) add('danger', s.line, depth > 0 ? tr('括号不配对（少 {n} 个 )）', { n: depth }) : tr('括号不配对（多了 )）'))
    if (/^\s*\\/.test(s.code) || /(^|\n)\s*\\[!o]/.test(s.text) || (kind === 'mysql' && /^\s*system\s/i.test(s.code))) add('danger', s.line, tr('含客户端命令（\\! 等会在数据库主机上执行 shell），请删除'))
    if (/^drop (database|schema)\b/.test(v)) add('danger', s.line, tr('{stmt}：删除整个库，数据无法找回', { stmt: UP(v) }))
    else if (v.startsWith('drop')) add('danger', s.line, tr('{stmt}：删除对象，数据无法找回', { stmt: UP(v) }))
    if (v === 'truncate') add('danger', s.line, tr('TRUNCATE：清空整张表，不能按条件恢复（MySQL 下还不能回滚）'))
    if (v === 'delete' || v === 'update') {
      const where = /\bwhere\b([\s\S]*)$/.exec(lc)
      if (!where) add('danger', s.line, tr('{stmt} 没有 WHERE：会作用于整张表', { stmt: UP(v) }))
      else if (/^\s*(1|true|1\s*=\s*1|''\s*=\s*'')\s*(limit\b|order\b|returning\b|$)/.test(where[1])) add('danger', s.line, tr('{stmt} 的 WHERE 恒为真：等于作用于整张表', { stmt: UP(v) }))
    }
    if (v === 'alter table') add('warn', s.line, kind === 'mysql' ? tr('ALTER TABLE：大表上可能长时间锁表 / 重建表，建议低峰执行或用 ALGORITHM=INPLACE, LOCK=NONE') : tr('ALTER TABLE：多数改动要拿排它锁，加列带默认值 / 改类型可能重写整表'))
    if (v === 'create index' && kind === 'postgres' && !/\bconcurrently\b/.test(lc)) add('warn', s.line, tr('CREATE INDEX 期间会阻塞写入，线上大表建议 CREATE INDEX CONCURRENTLY'))
    if (kind === 'postgres' && tx && (/\bconcurrently\b/.test(lc) || /^(vacuum|create database|drop database|alter system|reindex .*concurrently)\b/.test(lc))) add('danger', s.line, tr('{stmt} 不能在事务里执行：请取消勾选「整体事务」或单独执行', { stmt: UP(v) }))
    if (/^(grant|revoke)$/.test(v) || /^(create|drop|alter) (user|role)$/.test(v)) add('warn', s.line, tr('{stmt}：权限 / 账号变更', { stmt: UP(v) }))
    if (/^set\s+(global|persist)\b/.test(lc) || /^alter system\b/.test(lc)) add('warn', s.line, tr('修改全局配置：影响整个实例上的所有连接'))
    if (/^(begin|commit|rollback|savepoint|release)$/.test(v) && tx) add('warn', s.line, tr('脚本里自带 {stmt}：会打断「整体事务」，出错后前面的改动可能已经提交', { stmt: UP(v) }))
    if (kind === 'mysql' && tx && DDL.test(lc)) add('warn', s.line, tr('{stmt} 会隐式提交：MySQL 里 DDL 不能回滚，出错时它之前的改动已经生效', { stmt: UP(v) }))
    if (v === 'use') add('info', s.line, tr('切换到库 {db}：后面的语句都在这个库上执行', { db: s.code.slice(3).trim() }))
    if (v === 'insert' && /^insert\s+(ignore\s+)?into\s+[\w."`]+\s+(values|select)\b/.test(lc)) add('info', s.line, tr('INSERT 没写列名：表结构变了容易错位，建议写明列名'))
    if (v === 'select' && !/\blimit\b|\bcount\s*\(|\bwhere\b/.test(lc) && /\bfrom\b/.test(lc)) add('info', s.line, tr('SELECT 没有 WHERE / LIMIT：大表会返回很多行'))
  }
  if (!stmts.length && !errors.length) add('info', 1, tr('没有可执行的语句'))
  return { stmts: stmts.length, counts: [...counts], findings: f.sort((a, b) => a.line - b.line) }
}

const REDIS_RULES: [RegExp, FindingLevel, string][] = [
  [/^(flushall|flushdb)\b/i, 'danger', tk('清空数据：库里所有 key 都会被删除')],
  [/^(shutdown|debug|script\s+flush|function\s+flush|cluster\s+reset|replicaof|slaveof)\b/i, 'danger', tk('影响整个实例（停机 / 清脚本 / 改主从）')],
  [/^keys\s/i, 'warn', tk('KEYS 会阻塞实例，key 多时线上请改用 SCAN')],
  [/^(del|unlink)\s/i, 'warn', tk('删除 key')],
  [/^config\s+(set|rewrite|resetstat)\b/i, 'warn', tk('修改实例配置')],
  [/^(rename|renamenx|move|migrate)\s/i, 'warn', tk('改名 / 迁移 key')],
]
function checkRedis(src: string): ScriptCheck {
  const f: ScriptFinding[] = [], counts = new Map<string, number>()
  let n = 0
  src.split('\n').forEach((raw, i) => {
    const l = raw.trim()
    if (!l || l.startsWith('#')) return
    n++
    const verb = UP(l.split(/\s+/)[0])
    counts.set(verb, (counts.get(verb) ?? 0) + 1)
    for (const [re, level, msg] of REDIS_RULES) if (re.test(l)) f.push({ level, line: i + 1, msg: tr('{verb}：{msg}', { verb, msg: tr(msg) }) })
    if ((l.match(/"/g) ?? []).length % 2) f.push({ level: 'danger', line: i + 1, msg: tr('引号没有配对') })
  })
  if (!n) f.push({ level: 'info', line: 1, msg: tr('没有可执行的命令') })
  return { stmts: n, counts: [...counts], findings: f }
}

/**
 * 给客户端的输入：最后一条没写结束符时补上（不能无条件补：MySQL 的空语句会报错）。MySQL 整体事务 = 首行 START TRANSACTION、末尾 COMMIT
 * （客户端遇错即退出、连接断开即回滚；报错行号因此多 1，见 fixScriptLines）；PG 整体事务用 psql -1，不改输入
 */
// ── 脚本输出 → 分段（语句 + 表格 + 提示）────────────────────
export interface ScriptSection { stmt?: string; tables: { columns: string[]; rows: string[][] }[]; text: string }
// 一行按 | 切；切出的格数不对（值里有 |）时按边框线里 + 的位置切
function cellsOf(line: string, cols: number, cuts: number[]): string[] {
  const inner = line.replace(/^\s*\|?/, '').replace(/\|?\s*$/, '')
  const parts = inner.split('|')
  if (parts.length === cols) return parts.map((s) => s.trim())
  return cuts.slice(0, -1).map((p, i) => line.slice(p + 1, cuts[i + 1]).trim())
}
const plusAt = (s: string) => [...s].flatMap((ch, i) => (ch === '+' ? [i] : []))
/**
 * 脚本执行输出（mysql -t -vvv / psql 对齐输出）→ 分段：MySQL 每条语句一段（-vvv 回显的语句夹在两条 ---- 之间），PG 没有回显按出现顺序分段。
 * 认不出的内容都留在 text 里；Redis 不解析（返回 []）
 */
export function parseScriptOutput(kind: DbKind, out: string): ScriptSection[] {
  if (kind === 'redis' || kind === 'mongo') return []
  const lines = out.replace(/\r/g, '').split('\n')
  const secs: ScriptSection[] = []
  let cur: ScriptSection = { tables: [], text: '' }
  const flush = () => { cur.text = cur.text.replace(/^\n+|\n+$/g, ''); if (cur.stmt !== undefined || cur.tables.length || cur.text) secs.push(cur); cur = { tables: [], text: '' } }
  const say = (l: string) => { cur.text += `${l}\n` }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    // MySQL -vvv：---- / 语句 / ----
    if (kind === 'mysql' && /^-{5,}$/.test(l)) {
      const end = lines.indexOf(l, i + 1)
      if (end > i) { flush(); cur.stmt = lines.slice(i + 1, end).join('\n').trim(); i = end; continue }
    }
    // MySQL 表格：+---+ / | 列 | / +---+ / | 值 | … / +---+
    if (kind === 'mysql' && /^\+[-+]+\+$/.test(l) && /^\|.*\|$/.test(lines[i + 1] ?? '') && lines[i + 2] === l) {
      const cuts = plusAt(l), n = cuts.length - 1
      const t = { columns: cellsOf(lines[i + 1], n, cuts), rows: [] as string[][] }
      let j = i + 3
      for (; j < lines.length && /^\|.*\|$/.test(lines[j]); j++) t.rows.push(cellsOf(lines[j], n, cuts))
      if (lines[j] === l) j++
      cur.tables.push(t); i = j - 1; continue
    }
    // psql 对齐：列名行 / ----+---- / 值 … / (N rows)
    if (kind === 'postgres' && /^-+(\+-+)*$/.test(lines[i + 1] ?? '') && l.trim()) {
      const sep = lines[i + 1], cuts = [-1, ...plusAt(sep), sep.length]
      const n = cuts.length - 1
      const t = { columns: cellsOf(l, n, cuts), rows: [] as string[][] }
      let j = i + 2
      for (; j < lines.length && !/^\(\d+ rows?\)$/.test(lines[j]) && lines[j] !== ''; j++) t.rows.push(cellsOf(lines[j], n, cuts))
      if (/^\(\d+ rows?\)$/.test(lines[j] ?? '')) { flush(); cur.tables.push(t); say(lines[j]); flush(); i = j; continue }
    }
    if (l === 'Bye') continue
    say(l)
  }
  flush()
  return secs
}

/** 脚本里每条都是只读语句（逐条过「查询」页签同一套只读校验）→ 执行时不用当写操作确认 */
export function scriptIsReadonly(kind: DbKind, src: string): boolean {
  if (kind === 'redis' || kind === 'mongo') return false
  const { stmts, errors } = splitSql(src.replace(/\r/g, ''), kind)
  return !errors.length && stmts.length > 0 && stmts.every((s) => checkReadonlySql(s.text, kind).ok)
}

export function scriptInput(kind: DbKind, src: string, tx: boolean): string {
  const body = src.replace(/\r/g, '')
  if (kind === 'redis' || kind === 'mongo') return `${body}\n`   // mongo 的连接开头由 dbIpc 拼（要连接参数）
  const { tail } = splitSql(body, kind)
  const s = tail ? `${body}\n${tail}\n` : `${body}\n`
  return kind === 'mysql' && tx ? `START TRANSACTION;\n${s}DELIMITER ;\nCOMMIT;\n` : s
}
/** MySQL 整体事务时报错里的行号减去开头那一行 */
export const fixScriptLines = (kind: DbKind, tx: boolean, err: string) => (kind === 'mysql' && tx ? err.replace(/\bat line (\d+)/g, (_m, n: string) => `at line ${Math.max(1, Number(n) - 1)}`) : err)

/** 执行记录：语句数和种类 + 第一条的开头（存进执行记录，保持中文） */
export function scriptAuditCommand(c: DbConn, chk: ScriptCheck, src: string, tx: boolean): string {
  const head = src.replace(/(--|#)[^\n]*|\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)
  const kinds = chk.counts.map(([k, v]) => `${k} ${v}`).join('、')   // i18n-ignore 执行记录内容，保持中文
  return `[脚本 ${chk.stmts} 条${kinds ? `：${kinds}` : ''}${tx && c.kind !== 'redis' ? '，整体事务' : ''}] ${head}${src.length > 160 ? '…' : ''}  # ${DB_KIND_LABEL[c.kind]}「${c.name}」${c.database ? ` 库 ${c.database}` : ''}`   // i18n-ignore 执行记录内容，保持中文
}

/** 「让 AI 审查」发到对话的消息（脚本过长截断；发给 AI 的话，保持中文） */
export function scriptReviewPrompt(o: { kind: DbKind; conn: string; version?: string; script: string; check: ScriptCheck }): string {
  const s = o.script.length > 20_000 ? `${o.script.slice(0, 20_000)}\n…（后面还有 ${o.script.length - 20_000} 字，已省略）` : o.script   // i18n-ignore 发给 AI 的话
  const local = o.check.findings.map((x) => `- 第 ${x.line} 行 [${x.level === 'danger' ? '高危' : x.level === 'warn' ? '注意' : '提示'}] ${x.msg}`).join('\n') || '- （规则检查没有发现问题）'   // i18n-ignore 发给 AI 的话
  return [
    `请审查下面这份准备在 ${DB_KIND_LABEL[o.kind]}${o.version ? `（${o.version}）` : ''} 上执行的${o.kind === 'redis' ? '命令' : o.kind === 'mongo' ? ' mongosh（JavaScript）' : ' SQL '}脚本（连接「${o.conn}」，还没有执行）：`,   // i18n-ignore 发给 AI 的话
    '检查语法错误、会误伤数据的语句（缺 WHERE、条件写错、误删）、锁表 / 长事务风险、执行顺序和依赖问题、不可回滚的操作，给出修改建议和执行前该做的备份。只审查，不要执行任何语句。',   // i18n-ignore 发给 AI 的话
    '', '```' + (o.kind === 'redis' ? '' : o.kind === 'mongo' ? 'javascript' : 'sql'), s, '```', '', `规则检查结果（${o.check.stmts} 条）：`, local,   // i18n-ignore 发给 AI 的话
  ].join('\n')
}
