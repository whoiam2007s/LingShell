// ── 命令面板（Ctrl+K / Ctrl+Shift+P）──────────────────────
// 纯逻辑：查询前缀、模糊打分、分组、最近使用。条目数据与动作由 UI 侧拼。
// help = 使用帮助的全文搜索结果：不参与 paletteSections 打分，由 UI 用帮助索引单独搜、作为最后一组追加
export type PaletteKind = 'action' | 'host' | 'session' | 'runbook' | 'quick' | 'template' | 'settings' | 'workspace' | 'help'
// id 全局唯一且稳定（如 host:<id>），最近使用按它记；common = 空查询时展示的常用条目
export interface PaletteItem { id: string; kind: PaletteKind; title: string; subtitle?: string; keywords?: string; common?: boolean }
export interface PaletteSection<T> { label: string; items: T[] }

import { tk } from '../i18n/i18n.js'

export const PALETTE_LIMIT = 12
export const PALETTE_RECENT_MAX = 20
export const PALETTE_KIND_LABEL: Record<PaletteKind, string> = {
  action: tk('动作'), host: tk('主机'), session: tk('历史会话'), runbook: tk('运维手册'), quick: tk('快速命令'), template: tk('常用模板'), settings: tk('设置'), workspace: tk('工作区'), help: tk('帮助'),
}
// 前缀过滤：> 动作 / @ 主机 / # 会话 / ? 帮助（全角？也认，另外「帮助 xxx」带空格也算只搜帮助）
// 中文输入法全角标点也认（＞ ＠ ＃ ?/？），否则全角模式打前缀只会得到「没有匹配项」
export const PALETTE_PREFIX: Record<string, PaletteKind> = {
  '>': 'action', '＞': 'action', '@': 'host', '＠': 'host', '#': 'session', '＃': 'session', '?': 'help', '？': 'help',   // i18n-ignore 全角前缀字符
}

export function parsePaletteQuery(raw: string): { kind?: PaletteKind; text: string } {
  const s = raw.trimStart()
  const m = /^帮助\s+/.exec(s)   // 只打「帮助」两个字仍搜全部（能搜到「使用帮助」动作）
  if (m) return { kind: 'help', text: s.slice(m[0].length).trim() }
  const kind = PALETTE_PREFIX[s[0]]
  return kind ? { kind, text: s.slice(1).trim() } : { text: s.trim() }
}

const SEP = /[\s\-_./\\:@()（）[\]【】,，、|+#]/
const CJK = /[㐀-鿿]/
// 词首：前一个字符是分隔符，或中英文交界（「重启nginx」里的 n）
const wordStart = (t: string, i: number) => SEP.test(t[i - 1]) || CJK.test(t[i - 1]) !== CJK.test(t[i])

/** 单个词在一段文本里的匹配档：前缀 100 > 词首 70 > 子串 40 > 子序列 10（仅 subseq 时）；不中 0。q 须已小写 */
export function matchTier(text: string, q: string, subseq = true): number {
  const t = text.toLowerCase()
  if (!q || !t) return 0
  if (t.startsWith(q)) return 100
  let i = t.indexOf(q)
  if (i < 0) {
    if (!subseq) return 0
    let k = 0
    for (const c of t) if (c === q[k] && ++k === q.length) return 10
    return 0
  }
  for (; i >= 0; i = t.indexOf(q, i + 1)) if (wordStart(t, i)) return 70
  return 40
}

// 多词：每个词都要中（标题优先；副标题 / 关键词折半且不算子序列，免得长命令什么都能中），取平均
function score(it: PaletteItem, tokens: string[]): number {
  let sum = 0
  for (const q of tokens) {
    const s = Math.max(matchTier(it.title, q), matchTier(it.subtitle ?? '', q, false) / 2, matchTier(it.keywords ?? '', q, false) / 2)
    if (!s) return 0
    sum += s
  }
  return sum / tokens.length
}

/** 排序 + 分段。空查询：最近使用 + 常用（有前缀则为该类全部）；有查询：按分数排，再按类分组（组序 = 该组最高分出现的先后）。
 *  最近使用加分（最多 20，越近越多）：主要在同档内靠前，不会越过高一档的匹配 */
export function paletteSections<T extends PaletteItem>(raw: string, items: T[], recent: string[], limit = PALETTE_LIMIT): PaletteSection<T>[] {
  const { kind, text } = parsePaletteQuery(raw)
  const pool = kind ? items.filter((it) => it.kind === kind) : items
  const tokens = text.toLowerCase().split(/\s+/).filter(Boolean)
  const rIdx = new Map(recent.map((id, i) => [id, i]))
  if (!tokens.length) {
    const rec = recent.map((id) => pool.find((it) => it.id === id)).filter((x): x is T => !!x).slice(0, limit)
    const rest = pool.filter((it) => !rIdx.has(it.id) && (kind || it.common)).slice(0, limit - rec.length)
    return [
      { label: tk('最近使用'), items: rec },   // 分组名保持中文（UI 按它比较），显示处 tr(label)
      { label: kind ? PALETTE_KIND_LABEL[kind] : tk('常用'), items: rest },
    ].filter((s) => s.items.length)
  }
  const ranked = pool
    .map((it, i) => {
      const s = score(it, tokens)
      const r = rIdx.get(it.id)
      return { it, i, s: s && s + (r === undefined ? 0 : 20 * (1 - r / PALETTE_RECENT_MAX)) }
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.it.title.length - b.it.title.length || a.i - b.i)
    .slice(0, limit)
  const groups = new Map<PaletteKind, T[]>()
  for (const { it } of ranked) groups.set(it.kind, [...(groups.get(it.kind) ?? []), it])
  return [...groups].map(([k, list]) => ({ label: PALETTE_KIND_LABEL[k], items: list }))
}

/** 记一次使用：提到最前、去重、最多 PALETTE_RECENT_MAX 条 */
export const pushRecent = (recent: string[], id: string) => [id, ...recent.filter((x) => x !== id)].slice(0, PALETTE_RECENT_MAX)
