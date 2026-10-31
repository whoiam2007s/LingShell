// 帮助全文搜索：运行时从 HELP_SECTIONS 建索引（帮助内容会随功能增删改小节，不能硬编码）。
// 纯函数，命令面板「帮助」分组与帮助弹窗搜索框共用。不做拼音（不引依赖）。
import type { HelpBlock } from './helpContent.js'

type Sec = { id: string; title: string; blocks: HelpBlock[] }
/** 一条索引：block = -1 表示章节本身（只按章节标题匹配），否则是该章第 block 个块 */
export interface HelpDoc { section: string; block: number; sectionTitle: string; h?: string; body: string }
export interface HelpHit { doc: HelpDoc; score: number; snippet: string }
/** 打开帮助并定位：章节 + 块下标（-1/缺省 = 章节顶部）+ 要高亮的搜索词 */
export interface HelpTarget { section: string; block?: number; q?: string }

// 去掉代码样式的反引号、折叠空白，片段和高亮都基于这份纯文本
const plain = (s: string) => s.replace(/`/g, '').replace(/\s+/g, ' ').trim()
const bodyOf = (b: HelpBlock) => plain([b.p, ...(b.steps ?? []), ...(b.tips ?? []), ...(b.keys ?? []).map(([k, d]) => `${k} ${d}`)].filter(Boolean).join(' '))

export function buildHelpIndex(sections: Sec[]): HelpDoc[] {
  const out: HelpDoc[] = []
  for (const s of sections) {
    out.push({ section: s.id, block: -1, sectionTitle: s.title, body: '' })
    s.blocks.forEach((b, i) => out.push({ section: s.id, block: i, sectionTitle: s.title, h: b.h ? plain(b.h) : undefined, body: bodyOf(b) }))
  }
  return out
}

export const helpTokens = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean)

const field = (text: string | undefined, t: string, w: number) => {
  const i = text ? text.toLowerCase().indexOf(t) : -1
  return i < 0 ? 0 : w + (i === 0 ? 10 : 0)   // 字段以它开头略加分
}
// 单个词：章节标题 100 > 小节标题 60 > 正文 30。块条目里章节标题只算上下文分 15（「终端 广播」这类组合也能中）；
// own = 落在块自己的小节标题或正文里——至少一个词要 own，免得一个「终端」把整章所有块都列出来
function tokenScore(d: HelpDoc, t: string): { s: number; own: boolean } {
  if (d.block < 0) { const s = field(d.sectionTitle, t, 100); return { s, own: s > 0 } }
  const own = Math.max(field(d.h, t, 60), field(d.body, t, 30))
  return { s: Math.max(own, field(d.sectionTitle, t, 15)), own: own > 0 }
}

const CJK = /[\u3400-\u9fff\uff00-\uffef\u3000-\u303f]/
/** 片段：从最早命中处往前留 before 字，总长约 max 字，两端截断加省略号；正文没命中（只中了标题）取开头。
 *  不含中文的文本（英文帮助）：一个字母信息量远小于一个汉字，窗口放大 2.5 倍，两端截在词边界，不切半个单词 */
export function helpSnippet(text: string, tokens: string[], before = 12, max = 64): string {
  const latin = !CJK.test(text)
  if (latin) { before = Math.round(before * 2.5); max = Math.round(max * 2.5) }
  const x = text.toLowerCase()
  let pos = -1
  for (const t of tokens) { const i = x.indexOf(t); if (i >= 0 && (pos < 0 || i < pos)) pos = i }
  let start = Math.max(0, Math.min(pos - before, text.length - max))
  let end = Math.min(text.length, start + max)
  if (latin) {
    // 起点前移到词首（不越过命中处），终点回退到词尾；只在离边界不远（≤ 15 字）时调整，超长「单词」照原样截
    if (start > 0 && /\w/.test(text[start - 1]) && /\w/.test(text[start])) {
      const s = text.slice(Math.max(0, start - 15), start).search(/\w+$/)
      if (s >= 0) start = Math.max(0, start - 15) + s
    }
    if (end < text.length && /\w/.test(text[end - 1]) && /\w/.test(text[end])) {
      const m = /\W\w*$/.exec(text.slice(Math.max(start, end - 15), end))
      if (m) end = Math.max(start, end - 15) + m.index + 1
    }
    const head = start > 0 ? '…' : '', tail = end < text.length ? '…' : ''
    return head + text.slice(start, end).trim() + tail
  }
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '')
}

/** 多词 AND（不区分大小写的子串），按平均分降序，同分保持帮助里的先后 */
export function searchHelp(index: HelpDoc[], q: string, limit = Infinity): HelpHit[] {
  const tokens = helpTokens(q)
  if (!tokens.length) return []
  const hits: HelpHit[] = []
  for (const doc of index) {
    let sum = 0, own = false
    for (const t of tokens) {
      const r = tokenScore(doc, t)
      if (!r.s) { sum = 0; break }
      sum += r.s; own ||= r.own
    }
    if (sum && own) hits.push({ doc, score: sum / tokens.length, snippet: doc.body ? helpSnippet(doc.body, tokens) : '' })
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit)   // sort 稳定
}

/** 每章最好的命中：章节 id → { score, block }（帮助弹窗给章节列表排序、选中章节后滚到哪一块） */
export function helpSectionHits(index: HelpDoc[], q: string): Map<string, { score: number; block: number }> {
  const m = new Map<string, { score: number; block: number }>()
  for (const h of searchHelp(index, q)) if (!m.has(h.doc.section)) m.set(h.doc.section, { score: h.score, block: h.doc.block })
  return m
}

/** 把文本切成普通段和命中段（所有词的所有出现位置，重叠合并），用于 <mark> 高亮 */
export function splitHighlight(text: string, tokens: string[]): { text: string; hit: boolean }[] {
  if (!text) return []
  const x = text.toLowerCase()
  const on = new Array<boolean>(text.length).fill(false)
  for (const t of tokens) for (let i = t ? x.indexOf(t) : -1; i >= 0; i = x.indexOf(t, i + 1)) on.fill(true, i, i + t.length)
  const out: { text: string; hit: boolean }[] = []
  for (let i = 0; i < text.length; i++) {
    const last = out[out.length - 1]
    if (last && last.hit === on[i]) last.text += text[i]
    else out.push({ text: text[i], hit: on[i] })
  }
  return out
}
