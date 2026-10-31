// i18n-ignore-file 这里的文案都是给模型的上下文（终端块 / @ 引用 / 检索片段 / 工具结果），termBlock 等还按中文格式解析
// 左侧对话增强的纯逻辑：AI 提问卡（ask_user）的数据形状、`!命令` 终端块、@ 引用的上下文文字、跨会话全文检索。

// ── AI 提问卡（ask_user）──────────────────────────────
export interface AskOption { label: string; description?: string }
/** 用户的回答：选中的选项 label（多选可多个）+ 「其他」里填的话 */
export interface AskAnswer { selected: string[]; other?: string }
export interface AskRequest { sessionId: string; question: string; options: AskOption[]; multiSelect: boolean; allowOther: boolean }
export const ASK_MAX_OPTIONS = 8

/** 清洗模型给的选项：去空、去重、截断，最多 8 个 */
export function sanitizeAskOptions(raw: unknown): AskOption[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: AskOption[] = []
  for (const o of raw as unknown[]) {
    const label = String((typeof o === 'string' ? o : (o as { label?: unknown })?.label) ?? '').trim().slice(0, 80)
    if (!label || seen.has(label)) continue
    seen.add(label)
    const d = typeof o === 'object' && o ? String((o as { description?: unknown }).description ?? '').trim().slice(0, 300) : ''
    out.push(d ? { label, description: d } : { label })
    if (out.length >= ASK_MAX_OPTIONS) break
  }
  return out
}

/** 渲染层传回的回答 → 只认原选项里的 label；单选只留第一个；「其他」只在允许时收。全空 = 视为没回答（null） */
export function normalizeAskAnswer(req: Pick<AskRequest, 'options' | 'multiSelect' | 'allowOther'>, raw: unknown): AskAnswer | null {
  if (!raw || typeof raw !== 'object') return null
  const labels = new Set(req.options.map((o) => o.label))
  const sel = Array.isArray((raw as AskAnswer).selected) ? (raw as AskAnswer).selected.filter((s) => typeof s === 'string' && labels.has(s)) : []
  const selected = [...new Set(sel)].slice(0, req.multiSelect ? ASK_MAX_OPTIONS : 1)
  const other = req.allowOther && typeof (raw as AskAnswer).other === 'string' ? (raw as AskAnswer).other!.trim().slice(0, 2000) : ''
  if (!selected.length && !other) return null
  return { selected, ...(other ? { other } : {}) }
}

/** 给模型的工具结果 */
export function askResultText(a: AskAnswer | null): string {
  if (!a) return JSON.stringify({ answered: false, note: '用户没有回答（点了跳过、超时或停止了本轮）。不要替用户做决定，也不要执行任何命令（包括只读检查）：用一两句话说明还需要用户决定什么，然后结束本轮。' })
  return JSON.stringify({ answered: true, selected: a.selected, ...(a.other ? { other: a.other } : {}) })
}

// ── `!命令` 终端块 ────────────────────────────────────
export const SHELL_BLOCK_MAX_BYTES = 4096

/** 取末尾不超过 max 字节（UTF-8）的部分，截掉了返回 truncated */
export function tailBytes(text: string, max = SHELL_BLOCK_MAX_BYTES): { text: string; truncated: boolean } {
  const enc = new TextEncoder()
  if (enc.encode(text).length <= max) return { text, truncated: false }
  let lo = 0, hi = text.length
  // 二分找最短的后缀起点，使后缀字节数 ≤ max
  while (lo < hi) { const mid = (lo + hi) >> 1; if (enc.encode(text.slice(mid)).length <= max) hi = mid; else lo = mid + 1 }
  let s = text.slice(lo)
  const nl = s.indexOf('\n')
  if (nl >= 0 && nl < 200) s = s.slice(nl + 1)   // 从完整的一行开始
  return { text: s, truncated: true }
}

/** 终端块的上下文文字（放进消息末尾的 <context type="shell">） */
export function shellBlockText(o: { terminal: string; command: string; exitCode: number; output: string; truncated?: boolean }): string {
  return `用户在终端「${o.terminal}」手动执行了：\n$ ${o.command}\n退出码：${o.exitCode}\n输出${o.truncated ? '（只保留末尾 4KB）' : ''}：\n\`\`\`\n${o.output.replace(/\s+$/, '') || '（无输出）'}\n\`\`\``
}

/** `!命令` 模式：去掉开头的 ! 和空白；不是 ! 开头返回 null */
export function bangCommand(input: string): string | null {
  const m = /^\s*!([\s\S]*)$/.exec(input)
  return m ? m[1].trim() : null
}

// ── @ 引用 ───────────────────────────────────────────
/** 光标前正在输入的 @ 引用：@ 在行首或空白后，到光标之间没有空白。返回 @ 的下标与过滤词 */
export function atQueryAt(text: string, caret: number): { start: number; q: string } | null {
  const before = text.slice(0, caret)
  const m = /(^|\s)@([^\s@]*)$/.exec(before)
  if (!m) return null
  return { start: before.length - m[2].length - 1, q: m[2] }
}

export const terminalRefText = (title: string, id: string) => `用户指定在终端「${title}」（terminal_id: ${id}）上操作。`
export const hostRefText = (label: string, id: string, group?: string) =>
  `用户指定在已保存主机「${label}」（host_id: ${id}${group ? `，分组：${group}` : ''}）上操作；如果还没有它的终端，先用 create_terminal（type=ssh，hostId=${id}）打开。`
export const sessionRefText = (title: string, when: string, digest: string) =>
  `用户引用了历史会话「${title}」（${when}）的内容摘要，供参考：\n${digest || '（这个会话还没有内容）'}`

// ── 跨会话全文检索 ───────────────────────────────────
/** 一条可检索的文本：会话里的用户提问 / AI 回复 / 执行过的命令。itemId = 对话里对应条目的 id（点击跳过去用） */
export interface ChatSearchDoc { sessionId: string; kind: 'user' | 'ai' | 'cmd'; text: string; itemId?: string; at?: number }
export interface ChatSearchHit { sessionId: string; kind: ChatSearchDoc['kind']; itemId?: string; at?: number; snippet: string; context: string; score: number }

const CJK = /[㐀-鿿豈-﫿]/
/**
 * 检索词：按空白切；每段里中文连续片段切成二元组（「磁盘满了」→ 磁盘 / 盘满 / 满了），其它（英文、数字、路径、命令）整段作一个词。
 * 不加依赖、不做词典分词：二元组对中文召回够用，排序再看覆盖率和整句命中。
 */
export function searchTokens(q: string): string[] {
  const out: string[] = []
  for (const seg of q.toLowerCase().split(/\s+/).filter(Boolean)) {
    let buf = '', cjk = false
    const flush = () => {
      const s = cjk ? buf : buf.replace(/^[^\p{L}\p{N}/._~-]+|[^\p{L}\p{N}/._~-]+$/gu, '')
      if (cjk && s.length > 2) for (let i = 0; i + 1 < s.length; i++) out.push(s.slice(i, i + 2))
      else if (s) out.push(s)
      buf = ''
    }
    for (const ch of seg) {
      const c = CJK.test(ch)
      if (buf && c !== cjk) flush()
      cjk = c; buf += ch
    }
    if (buf) flush()
  }
  return [...new Set(out)]
}

const window1 = (text: string, at: number, len: number, before: number, max: number) => {
  const start = Math.max(0, Math.min(at - before, text.length - max))
  const end = Math.min(text.length, Math.max(start + max, at + len))
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '')
}

/** 一条文本对检索词的得分：覆盖率（按词长加权）+ 整句命中加分；不够格返回 0 */
export function scoreText(text: string, q: string, tokens = searchTokens(q)): { score: number; at: number; len: number } {
  if (!tokens.length || !text) return { score: 0, at: -1, len: 0 }
  const x = text.toLowerCase()
  const phrase = q.trim().toLowerCase()
  let total = 0, got = 0, at = -1, len = 0
  for (const t of tokens) {
    total += t.length
    const i = x.indexOf(t)
    if (i < 0) continue
    got += t.length
    if (t.length > len || at < 0) { at = i; len = t.length }   // 片段围绕最长的命中词
  }
  const cover = got / total
  // 词少时要求全中（1–2 个词漏一个就是另一回事了），词多时 ≥ 60%
  if (!got || (tokens.length <= 2 ? cover < 1 : cover < 0.6)) return { score: 0, at: -1, len: 0 }
  const p = phrase ? x.indexOf(phrase) : -1
  if (p >= 0) { at = p; len = phrase.length }
  return { score: cover + (p >= 0 ? 0.5 : 0), at, len }
}

/** 检索：按得分、再按时间新旧排序；每个会话最多 perSession 条 */
export function searchChats(docs: ChatSearchDoc[], q: string, opts: { limit?: number; perSession?: number } = {}): ChatSearchHit[] {
  const tokens = searchTokens(q)
  if (!tokens.length) return []
  const hits: ChatSearchHit[] = []
  for (const d of docs) {
    const s = scoreText(d.text, q, tokens)
    if (!s.score) continue
    hits.push({ sessionId: d.sessionId, kind: d.kind, ...(d.itemId ? { itemId: d.itemId } : {}), ...(d.at ? { at: d.at } : {}),
      snippet: window1(d.text, s.at, s.len, 24, 90), context: window1(d.text, s.at, s.len, 200, 600), score: s.score })
  }
  hits.sort((a, b) => b.score - a.score || (b.at ?? 0) - (a.at ?? 0))
  const per = new Map<string, number>()
  const out: ChatSearchHit[] = []
  for (const h of hits) {
    const n = per.get(h.sessionId) ?? 0
    if (n >= (opts.perSession ?? 3)) continue
    per.set(h.sessionId, n + 1)
    out.push(h)
    if (out.length >= (opts.limit ?? 60)) break
  }
  return out
}

/** 「问 AI：上次怎么解决…」：把前几条命中拼成给 AI 的上下文 */
export function searchContextText(q: string, hits: (ChatSearchHit & { title: string; when?: string })[]): string {
  const kind = { user: '用户提问', ai: 'AI 回复', cmd: '执行过的命令' }
  return `从历史会话里检索「${q}」得到的相关片段：\n${hits.map((h, i) => `${i + 1}. 会话「${h.title}」${h.when ? `（${h.when}）` : ''} · ${kind[h.kind]}：\n${h.context}`).join('\n\n')}`
}
