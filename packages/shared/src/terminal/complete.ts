// 终端命令自动补全（FinalShell / WindTerm / Warp 风格，系统设置里默认关）：纯逻辑，UI 胶水见 TerminalPane.tsx / CompletionPopup.tsx。
// 候选来源 = 该主机命令历史（按频次 + 近期打分）+ 快速命令 + 少量内置常用片段；前缀 / 子串匹配，前缀优先。
// 接受：候选以输入开头 → 只写剩余部分；否则（子串 / 大小写不同）→ 退格删掉已输入的再写整条。
import { readBufferRange } from './shellMarks.js'

export type CompletionKind = 'history' | 'quick' | 'snippet'
export interface CompletionItem {
  text: string
  kind: CompletionKind   // 有历史就算 history（可 Shift+Delete 删）；否则快速命令；否则内置片段
  label?: string         // 快速命令的名称
  score: number          // 频次 + 近期 + 来源加权，越大越靠前
}
export interface CompletionMatch {
  item: CompletionItem
  start: number          // 匹配部分在 text 里的区间 [start, end)，高亮用
  end: number
}

// 内置常用片段（末尾带空格的 = 接受后接着填参数）
export const COMPLETION_SNIPPETS = [
  'systemctl status ', 'systemctl restart ', 'systemctl list-units --failed', 'journalctl -u ', 'journalctl -f',
  'docker ps', 'docker ps -a', 'docker logs -f --tail 200 ', 'docker compose ps', 'docker compose logs -f',
  'tail -f ', 'tail -n 200 ', 'ps aux | grep ', 'ss -lntp', 'df -h', 'du -sh * | sort -h', 'free -h',
  'kubectl get pods -A', 'kubectl logs -f ', 'git status', 'git log --oneline -20',
]

const MAX_LEN = 500   // 太长的命令（多半是粘贴的脚本）不作候选
const DAY = 86_400_000

/** 汇总候选池：同一条命令多个来源合并（分数相加）；多行 / 超长 / 空的丢掉。now 便于测试 */
export function buildCompletionPool(src: {
  history?: { command: string; at: string }[]
  quick?: { command: string; label?: string }[]
  snippets?: string[]
}, now = Date.now()): CompletionItem[] {
  const map = new Map<string, { item: CompletionItem; count: number; last: number }>()
  const get = (text: string, kind: CompletionKind) => {
    let e = map.get(text)
    if (!e) map.set(text, e = { item: { text, kind, score: 0 }, count: 0, last: 0 })
    return e
  }
  const ok = (t: string) => !!t.trim() && t.length <= MAX_LEN && !/[\r\n]/.test(t)
  for (const h of src.history ?? []) {
    const t = h.command.trim()
    if (!ok(t)) continue
    const e = get(t, 'history')
    e.item.kind = 'history'
    e.count++
    const at = Date.parse(h.at)
    if (Number.isFinite(at) && at > e.last) e.last = at
  }
  for (const q of src.quick ?? []) {
    const t = q.command.trim()
    if (!ok(t)) continue
    const e = get(t, 'quick')
    e.item.label ??= q.label
    e.item.score += 3   // 用户自己整理的：比偶尔敲过一次的历史靠前
  }
  for (const s of src.snippets ?? []) {
    if (!ok(s)) continue
    get(s, 'snippet').item.score += 0.5
  }
  for (const e of map.values()) {
    if (!e.count) continue
    // 频次取对数（敲过 100 次不至于永远压住别的）+ 近期加成（3 天减半）
    const age = Math.max(0, now - e.last) / DAY
    e.item.score += 2 * Math.log2(1 + e.count) + (e.last ? 3 * Math.pow(0.5, age / 3) : 0)
  }
  return [...map.values()].map((e) => e.item)
}

/** 输入（提示符后已敲的字）是否值得弹：空 / 只有空格不弹 */
export const shouldComplete = (input: string | undefined): input is string => !!input && !!input.trim() && !/[\r\n]/.test(input)

const wordStart = (s: string, i: number) => i === 0 || /[\s/|;&=-]/.test(s[i - 1])

/** 按输入过滤 + 排序，最多 limit 条。顺序：大小写一致的前缀 > 忽略大小写的前缀 > 词首子串 > 其它子串，同级按分数、再按短的 */
export function matchCompletions(pool: CompletionItem[], input: string, limit = 8): CompletionMatch[] {
  const q = input.trimStart()
  if (!q.trim()) return []
  const ql = q.toLowerCase()
  const hits: { m: CompletionMatch; rank: number }[] = []
  for (const item of pool) {
    const t = item.text
    if (t === q || t.trimEnd() === q.trimEnd()) continue   // 已经敲完整了，没什么可补
    let rank: number, start: number
    if (t.startsWith(q)) { rank = 3; start = 0 }
    else {
      const tl = t.toLowerCase()
      if (tl.startsWith(ql)) { rank = 2; start = 0 }
      else {
        start = tl.indexOf(ql)
        if (start < 0) continue
        rank = 0
        // 优先找落在词首的那一处（如 "log" 命中 "docker logs" 而不是 "blog"）
        for (let i = start; i >= 0; i = tl.indexOf(ql, i + 1)) if (wordStart(tl, i)) { rank = 1; start = i; break }
      }
    }
    hits.push({ m: { item, start, end: start + q.length }, rank })
  }
  hits.sort((a, b) => b.rank - a.rank || b.m.item.score - a.m.item.score || a.m.item.text.length - b.m.item.text.length || (a.m.item.text < b.m.item.text ? -1 : 1))
  return hits.slice(0, limit).map((h) => h.m)
}

/** 接受候选要写进终端的字节：以输入开头 → 只补剩余部分；否则退格删掉已输入的（按字符数，readline 一个 DEL 删一个字符）再写整条 */
export function completionInsert(input: string, candidate: string): string {
  const q = input.trimStart()
  if (candidate.startsWith(q)) return candidate.slice(q.length)
  return '\x7f'.repeat([...q].length) + candidate
}

type Buf = Parameters<typeof readBufferRange>[0]
type At = { line: number; col: number }
/** 提示符后已敲的字：从输入起点（OSC 133;B）读到光标。光标不在输入末尾（← 移回去编辑中间）或在起点之前 → undefined（不弹） */
export function typedBeforeCursor(buf: Buf, input: At, cursor: At, cols: number): string | undefined {
  if (cursor.line < input.line || (cursor.line === input.line && cursor.col < input.col)) return undefined
  if (readBufferRange(buf, cursor, { line: cursor.line, col: cols }).trim() || buf.getLine(cursor.line + 1)?.isWrapped) return undefined
  return readBufferRange(buf, input, cursor)
}

/** 光标所在行（光标前的文字）像不像密码 / 口令 / 验证码提示：sudo、ssh、su、mysql -p、私钥口令等。
 *  这时键入不回显，不能弹补全，也不能把敲的东西当命令记进历史 */
export function isSecretPrompt(lineBeforeCursor: string): boolean {
  const s = lineBeforeCursor.replace(/\s+$/, '')
  if (!s || s.length > 200) return false
  return /(\bpass(word|phrase|code)?\b|\bpass phrase\b|密码|口令|\bPIN\b|verification code|验证码|\botp\b|one-time)[^\n]{0,100}[:：]$/i.test(s)
}
