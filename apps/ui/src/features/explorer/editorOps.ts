// 文件编辑器的纯逻辑：可疑字符检查 / 清理、查找、缩进、注释、行操作、语法检查、行列位置。
// 编辑类函数都输入 (text, 选区) 返回新的 (text, 选区)，由编辑器按差异写回 textarea（保留撤销）。
import { tk, tr, type SyntaxLang } from '@lingshell/shared'

export interface Sel { start: number; end: number }
export interface EditResult { text: string; sel: Sel }

// ── 可疑 / 不可见字符 ──
export type SuspectKind = 'bom' | 'zw' | 'nbsp' | 'wide' | 'ctrl'
export const SUSPECT_LABEL: Record<SuspectKind, string> = { bom: 'BOM', zw: tk('零宽字符'), nbsp: tk('不换行空格'), wide: tk('全角空格'), ctrl: tk('控制字符') }
// eslint-disable-next-line no-control-regex -- \u5C31\u662F\u8981\u627E\u63A7\u5236\u5B57\u7B26
const SUSPECT = /[\uFEFF\u200B-\u200D\u2060\u00A0\u3000\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g
export function suspectKind(ch: string, at: number): SuspectKind {
  if (ch === '\uFEFF') return at === 0 ? 'bom' : 'zw'
  if (ch === '\u00A0') return 'nbsp'
  if (ch === '\u3000') return 'wide'   // i18n-ignore 全角空格字符，不是文案
  if (/[\u200B-\u200D\u2060]/.test(ch)) return 'zw'
  return 'ctrl'
}
export interface Suspect { at: number; kind: SuspectKind; code: string }
export function findSuspects(text: string): Suspect[] {
  const out: Suspect[] = []
  for (const m of text.matchAll(SUSPECT)) out.push({ at: m.index!, kind: suspectKind(m[0], m.index!), code: `U+${m[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}` })
  return out
}
/** 行尾空白：[开始, 结束) 位置 */
export function trailingSpaces(text: string): Sel[] {
  const out: Sel[] = []
  for (const m of text.matchAll(/[ \t]+$/gm)) out.push({ start: m.index!, end: m.index! + m[0].length })
  return out
}
/** 缩进：Tab 缩进的行、空格缩进的行；unit = 推测的一级缩进 */
export function indentInfo(text: string): { tabs: number; spaces: number; unit: string; tabLines: number[]; spaceLines: number[] } {
  const tabLines: number[] = [], spaceLines: number[] = []
  const widths: number[] = []
  text.split('\n').forEach((l, i) => {
    if (l.startsWith('\t')) tabLines.push(i)
    else if (/^ +\S/.test(l)) { spaceLines.push(i); widths.push(/^ +/.exec(l)![0].length) }
  })
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)
  const g = widths.reduce((a, b) => gcd(a, b), 0)
  const unit = tabLines.length > spaceLines.length ? '\t' : ' '.repeat(g === 2 || g === 4 || g === 8 ? g : spaceLines.length ? (g === 1 || g === 3 ? 2 : 4) : 2)
  return { tabs: tabLines.length, spaces: spaceLines.length, unit, tabLines, spaceLines }
}
/** 换行符：原文里 CRLF / 单独 LF 各多少行（textarea 里都已是 LF，所以看磁盘原文） */
export function eolInfo(raw: string): { crlf: number; lf: number; cr: number } {
  const crlf = (raw.match(/\r\n/g) ?? []).length
  const lf = (raw.match(/\n/g) ?? []).length - crlf
  const cr = (raw.match(/\r(?!\n)/g) ?? []).length
  return { crlf, lf, cr }
}
/** 一键清理：去掉 BOM / 零宽 / 控制字符，不换行空格和全角空格换成普通空格，去掉行尾空白 */
export function cleanText(text: string): string {
  return text.replace(SUSPECT, (ch) => (ch === '\u00A0' || ch === '\u3000' ? ' ' : ch === '\t' ? ch : '')).replace(/[ \t]+$/gm, '')   // i18n-ignore 全角空格字符，不是文案
}

// ── 查找 ──
export interface FindOpts { caseSensitive?: boolean; wholeWord?: boolean }
export function findAll(text: string, q: string, o: FindOpts = {}, max = 10000): Sel[] {
  if (!q) return []
  const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(o.wholeWord ? `(?<![\\p{L}\\p{N}_])${esc}(?![\\p{L}\\p{N}_])` : esc, `gu${o.caseSensitive ? '' : 'i'}`)
  const out: Sel[] = []
  for (const m of text.matchAll(re)) { out.push({ start: m.index!, end: m.index! + m[0].length }); if (out.length >= max) break }
  return out
}
export function replaceAll(text: string, matches: Sel[], rep: string): string {
  let out = '', last = 0
  for (const m of matches) { out += text.slice(last, m.start) + rep; last = m.end }
  return out + text.slice(last)
}

// ── 位置 ──
export function lineCol(text: string, pos: number): { line: number; col: number } {
  const before = text.slice(0, pos)
  const line = before.split('\n').length
  return { line, col: pos - before.lastIndexOf('\n') }
}
export function lineStart(text: string, line: number): number {
  let pos = 0
  for (let i = 1; i < line; i++) { const n = text.indexOf('\n', pos); if (n < 0) return pos; pos = n + 1 }
  return pos
}
/** 选区覆盖的整行范围 [行首, 行尾（不含换行）]；选区结束在下一行行首时不算那一行 */
function lineRange(text: string, sel: Sel): Sel {
  const start = text.lastIndexOf('\n', sel.start - 1) + 1
  let endPos = sel.end > sel.start && text[sel.end - 1] === '\n' ? sel.end - 1 : sel.end
  const n = text.indexOf('\n', endPos)
  endPos = n < 0 ? text.length : n
  return { start, end: endPos }
}

// ── 缩进 / 注释 / 行操作 ──
export function indentLines(text: string, sel: Sel, unit: string): EditResult {
  const r = lineRange(text, sel)
  const lines = text.slice(r.start, r.end).split('\n')
  const out = lines.map((l) => (l ? unit + l : l)).join('\n')
  const first = lines[0] ? unit.length : 0
  return { text: text.slice(0, r.start) + out + text.slice(r.end), sel: { start: sel.start + first, end: sel.end + (out.length - (r.end - r.start)) } }
}
export function outdentLines(text: string, sel: Sel, unit: string): EditResult {
  const r = lineRange(text, sel)
  const lines = text.slice(r.start, r.end).split('\n')
  const cut = (l: string) => (l.startsWith('\t') ? 1 : Math.min(/^ */.exec(l)![0].length, unit === '\t' ? 4 : unit.length))
  const firstCut = cut(lines[0])
  const out = lines.map((l) => l.slice(cut(l))).join('\n')
  return { text: text.slice(0, r.start) + out + text.slice(r.end), sel: { start: Math.max(r.start, sel.start - firstCut), end: sel.end + (out.length - (r.end - r.start)) } }
}
/** 回车：新行带上当前行的缩进 */
export function newlineKeepIndent(text: string, sel: Sel): EditResult {
  const ls = text.lastIndexOf('\n', sel.start - 1) + 1
  const indent = /^[ \t]*/.exec(text.slice(ls, sel.start))![0]
  const ins = '\n' + indent
  return { text: text.slice(0, sel.start) + ins + text.slice(sel.end), sel: { start: sel.start + ins.length, end: sel.start + ins.length } }
}
export const commentToken = (lang: SyntaxLang): string => (lang === 'code' || lang === 'json' ? '//' : lang === 'sql' ? '--' : '#')
/** 注释切换：选中的非空行都已注释 → 去掉；否则在最小缩进处加上 */
export function toggleComment(text: string, sel: Sel, token: string): EditResult {
  const r = lineRange(text, sel)
  const lines = text.slice(r.start, r.end).split('\n')
  const body = lines.filter((l) => l.trim())
  if (!body.length) return { text, sel }
  const commented = body.every((l) => l.trimStart().startsWith(token))
  const minIndent = Math.min(...body.map((l) => /^[ \t]*/.exec(l)![0].length))
  const out = lines.map((l) => {
    if (!l.trim()) return l
    if (commented) { const i = l.indexOf(token); return l.slice(0, i) + l.slice(i + token.length).replace(/^ /, '') }
    return l.slice(0, minIndent) + token + ' ' + l.slice(minIndent)
  }).join('\n')
  const d = out.length - (r.end - r.start)
  return { text: text.slice(0, r.start) + out + text.slice(r.end), sel: { start: Math.max(r.start, sel.start + (commented ? Math.max(d, -(token.length + 1)) : token.length + 1)), end: sel.end + d } }
}
export function moveLines(text: string, sel: Sel, dir: -1 | 1): EditResult {
  const r = lineRange(text, sel)
  const block = text.slice(r.start, r.end)
  if (dir < 0) {
    if (r.start === 0) return { text, sel }
    const ps = text.lastIndexOf('\n', r.start - 2) + 1
    const prev = text.slice(ps, r.start - 1)
    return { text: text.slice(0, ps) + block + '\n' + prev + text.slice(r.end), sel: { start: sel.start - prev.length - 1, end: sel.end - prev.length - 1 } }
  }
  if (r.end >= text.length) return { text, sel }
  const ne = text.indexOf('\n', r.end + 1)
  const nextEnd = ne < 0 ? text.length : ne
  const next = text.slice(r.end + 1, nextEnd)
  return { text: text.slice(0, r.start) + next + '\n' + block + text.slice(nextEnd), sel: { start: sel.start + next.length + 1, end: sel.end + next.length + 1 } }
}
export function duplicateLines(text: string, sel: Sel): EditResult {
  const r = lineRange(text, sel)
  const block = text.slice(r.start, r.end)
  const add = block.length + 1
  return { text: text.slice(0, r.end) + '\n' + block + text.slice(r.end), sel: { start: sel.start + add, end: sel.end + add } }
}
export function deleteLines(text: string, sel: Sel): EditResult {
  const r = lineRange(text, sel)
  const from = r.end < text.length ? r.start : Math.max(0, r.start - 1)
  const to = r.end < text.length ? r.end + 1 : r.end
  const next = text.slice(0, from) + text.slice(to)
  const at = Math.min(from === r.start ? r.start : from + 1, next.length)
  return { text: next, sel: { start: Math.min(at, next.length), end: Math.min(at, next.length) } }
}

// ── 保存前语法检查 ──
export interface SyntaxProblem { line: number; message: string }
export function checkSyntax(text: string, path: string): SyntaxProblem | undefined {
  const ext = path.toLowerCase().replace(/^.*\./, '')
  if (ext === 'json') {
    try { JSON.parse(text.replace(/^\uFEFF/, '')); return undefined } catch (e) {
      const msg = (e as Error).message
      const pos = /position (\d+)/.exec(msg)?.[1]
      const lc = /line (\d+)/.exec(msg)?.[1]
      return { line: pos ? lineCol(text, Number(pos)).line : lc ? Number(lc) : 1, message: tr('JSON 格式不对：{msg}', { msg: msg.replace(/^JSON\.parse: /, '') }) }
    }
  }
  if (ext === 'yml' || ext === 'yaml') {
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]
      if (/^ *\t/.test(l)) return { line: i + 1, message: tr('YAML 不能用 Tab 缩进') }
      const body = l.replace(/^\s*-?\s*/, '')
      if (body.startsWith('#')) continue
      const dq = (body.replace(/\\"/g, '').match(/"/g) ?? []).length, sq = (body.match(/'/g) ?? []).length
      if (/^["']/.test(body) && (dq % 2 === 1 || (body.startsWith("'") && sq % 2 === 1))) return { line: i + 1, message: tr('引号没有闭合') }
    }
  }
  return undefined
}
