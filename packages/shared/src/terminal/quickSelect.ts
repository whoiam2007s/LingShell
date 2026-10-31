// 快速选择（同 WezTerm Quick Select）：终端可见区域里的 IP / URL / 路径 / 哈希 / 端口 / 数字列标上字母提示，按字母复制。
// 纯逻辑：按行找候选（规则有先后，重叠时先到的规则赢）+ 分配提示字母（前缀互斥：要么全是一个字母，要么全是两个字母）。

export type QsKind = 'url' | 'ipv4' | 'ipv6' | 'path' | 'hash' | 'port' | 'number'
/** row = 第几行（从 0 起），start / end = 行内字符下标（半开区间）；text = 复制的内容（端口不含冒号） */
export interface QsMatch { row: number; start: number; end: number; text: string; kind: QsKind }

const RULES: { kind: QsKind; re: RegExp; text?: (m: RegExpExecArray) => string; ok?: (s: string) => boolean }[] = [
  // URL：去掉句尾标点与不成对的右括号
  { kind: 'url', re: /\b(?:https?|ftp|file|ssh):\/\/[^\s<>"'`]+/g },
  { kind: 'ipv4', re: /(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\/\d{1,2})?(?![\w.]*\d)/g },
  // IPv6：带 :: 的缩写形式，或完整 8 段（不认 12:34:56 这类时间）
  { kind: 'ipv6', re: /(?<![\w:.])(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}(?![\w:])|(?<![\w:.])(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?(?:%\w+)?(?![\w:])/gi, ok: (s) => /[0-9a-f]/i.test(s) },
  // 绝对路径：/x、~/x、Windows C:\x；不吃行尾标点
  { kind: 'path', re: /(?<![\w./~-])(?:~?\/[\w.@%+~-][\w.@%+~/-]*|[A-Za-z]:\\[^\s"'<>|]*)/g },
  // git 哈希 / 容器 ID：7–64 位十六进制，须同时有字母和数字（排除 defaced 这类单词和纯数字）
  { kind: 'hash', re: /(?<![\w-])[0-9a-f]{7,64}(?![\w-])/g, ok: (s) => /[a-f]/.test(s) && /\d/.test(s) },
  // 端口：「:8080」（复制数字）。冒号前须是主机名 / IP / [::] / * / 空白，排除 10:20 这类时间
  { kind: 'port', re: /(?<=[A-Za-z\])*]|\.\d{1,3}|^|\s):(\d{2,5})(?![\w:.])/g, text: (m) => m[1] },
  // PID 样的数字列：独立的 3–10 位整数
  { kind: 'number', re: /(?<![\w.:/-])\d{3,10}(?![\w.:/-])/g },
]

const trimUrl = (s: string) => {
  let t = s.replace(/[.,;:!?]+$/, '')
  // 结尾的 ) ] 只在没有对应左括号时去掉（Markdown / 句子里包着的链接）
  while (/[)\]]$/.test(t)) {
    const close = t.at(-1)!, open = close === ')' ? '(' : '['
    if (t.split(open).length >= t.split(close).length) break
    t = t.slice(0, -1).replace(/[.,;:!?]+$/, '')
  }
  return t
}

/** 找出各行的候选；同一行内重叠的只留先到的规则（URL 里的路径 / IP 不重复标） */
export function findQuickSelect(lines: string[]): QsMatch[] {
  const out: QsMatch[] = []
  lines.forEach((line, row) => {
    const taken: [number, number][] = []
    const free = (a: number, b: number) => taken.every(([x, y]) => b <= x || a >= y)
    for (const r of RULES) {
      r.re.lastIndex = 0
      for (let m = r.re.exec(line); m; m = r.re.exec(line)) {
        let s = m[0]
        if (r.kind === 'url') s = trimUrl(s)
        if (r.kind === 'path') s = s.replace(/[.,;:!?)\]]+$/, '')
        if (!s || (r.ok && !r.ok(s))) continue
        if (r.kind === 'path' && (s === '/' || s === '~/' || s.length < 2)) continue
        const start = m.index, end = start + s.length
        if (!free(start, end)) continue
        taken.push([start, end])
        out.push({ row, start, end, text: r.text ? r.text(m) : s, kind: r.kind })
      }
    }
  })
  return out.sort((a, b) => a.row - b.row || a.start - b.start)
}

// 提示字母：左手主键区优先（同 WezTerm），去掉了 Esc 附近容易误按的；全小写，大写 = 复制并粘贴
export const QS_ALPHABET = 'asdfqwerzxcvjklmiuopghtybn'
export const QS_MAX = QS_ALPHABET.length * QS_ALPHABET.length

/** 给 n 个候选分配提示：n ≤ 26 用单字母，否则全用两个字母（前缀互斥，按完即确定）。超过 QS_MAX 的不分配 */
export function assignHints(n: number, alphabet = QS_ALPHABET): string[] {
  const a = [...alphabet]
  if (n <= a.length) return a.slice(0, n)
  const r: string[] = []
  for (const x of a) for (const y of a) { if (r.length >= n) return r; r.push(x + y) }
  return r
}

/** 键入的字母（已转小写）→ 命中的提示下标；还可能是某提示的前缀返回 'more'，都不是返回 null */
export function matchHint(typed: string, hints: string[]): number | 'more' | null {
  const i = hints.indexOf(typed)
  if (i >= 0) return i
  return hints.some((h) => h.startsWith(typed)) ? 'more' : null
}

/** 提示从离光标最近（最下面）的候选开始分配：最常用的那个拿到最顺手的字母 */
export function hintOrder(matches: QsMatch[]): number[] {
  return matches.map((_, i) => i).sort((i, j) => matches[j].row - matches[i].row || matches[j].start - matches[i].start)
}
