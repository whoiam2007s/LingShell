// 终端关键字高亮（Xshell「高亮集」）：只改喂给 xterm 显示的数据流；录屏/AI 捕获读主进程原始输出，不受影响。
// 做法：解析转义序列跟踪 SGR/备用屏状态，只在「普通文本段 + 当前无任何 SGR 属性 + 不在备用屏」时
// 给匹配包上着色序列，并用 39/49/22 精确还原回默认（因为之前就是默认）。转义序列本身原样透传。

export type HighlightColor = 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white'
  | 'brightRed' | 'brightGreen' | 'brightYellow' | 'brightBlue' | 'brightMagenta' | 'brightCyan' | 'brightWhite'

export interface HighlightRule {
  id: string
  pattern: string
  isRegex: boolean
  caseSensitive: boolean
  color: HighlightColor     // 前景色（取终端调色板，随配色主题变化）
  bg?: HighlightColor       // 可选背景色
  bold?: boolean
  enabled: boolean
  notify?: boolean          // 告警：输出命中时标签角标 / 系统通知（每条规则每终端 30 秒最多一次）
}

// 调色板名 → SGR 前景色码（背景 +10）
export const HIGHLIGHT_COLORS: Record<HighlightColor, number> = {
  red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, white: 37,
  brightRed: 91, brightGreen: 92, brightYellow: 93, brightBlue: 94, brightMagenta: 95, brightCyan: 96, brightWhite: 97,
}

export const DEFAULT_HIGHLIGHT_RULES: HighlightRule[] = [
  { id: 'error', pattern: '\\b(?:error|fatal|failed|denied)\\b|\\b\\w*exception\\b', isRegex: true, caseSensitive: false, color: 'red', enabled: true },
  { id: 'warn', pattern: '\\bwarn(?:ing)?\\b', isRegex: true, caseSensitive: false, color: 'yellow', enabled: true },
  { id: 'ok', pattern: '\\b(?:ok|success(?:ful)?)\\b|\\bactive \\(running\\)', isRegex: true, caseSensitive: false, color: 'green', enabled: true },
  { id: 'ipv4', pattern: '\\b(?:(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\b', isRegex: true, caseSensitive: true, color: 'cyan', enabled: true },
]

type Group = { idx: number; order: number; open: string; close: string }
// 按大小写敏感分两桶，每桶一个合并正则（规则各占一个捕获组）
export interface CompiledHighlight { buckets: { re: RegExp; groups: Group[] }[] }

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// 编译启用的规则；非法正则/可匹配空串的规则忽略。无可用规则返回 null
export function compileHighlight(rules: HighlightRule[]): CompiledHighlight | null {
  const buckets: CompiledHighlight['buckets'] = []
  for (const flags of ['g', 'gi']) {
    const srcs: string[] = [], groups: Group[] = []
    let next = 1
    rules.forEach((r, order) => {
      if (!r.enabled || !r.pattern || r.caseSensitive !== (flags === 'g')) return
      const src = r.isRegex ? r.pattern : escapeRe(r.pattern)
      try {
        if (new RegExp(src, flags).test('')) return
        const n = new RegExp(`${src}|`).exec('')!.length - 1   // 规则自带的捕获组数
        new RegExp([...srcs, `(${src})`].join('|'), flags)       // 与已收规则合并仍合法（命名组重名等）
        srcs.push(`(${src})`)
        const fg = HIGHLIGHT_COLORS[r.color] ?? 31
        const bg = r.bg ? HIGHLIGHT_COLORS[r.bg] : undefined
        groups.push({
          idx: next, order,
          open: `\x1b[${[fg, ...(bg ? [bg + 10] : []), ...(r.bold ? [1] : [])].join(';')}m`,
          close: `\x1b[${[39, ...(bg ? [49] : []), ...(r.bold ? [22] : [])].join(';')}m`,
        })
        next += 1 + n
      } catch { /* 非法正则忽略 */ }
    })
    if (srcs.length) buckets.push({ re: new RegExp(srcs.join('|'), flags), groups })
  }
  return buckets.length ? { buckets } : null
}

// 给一段纯文本里的匹配着色（重叠时先开始者优先，同起点按规则顺序）
export function markText(text: string, c: CompiledHighlight): string {
  const hits: { s: number; e: number; g: Group }[] = []
  for (const b of c.buckets) {
    b.re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = b.re.exec(text))) {
      if (!m[0]) { b.re.lastIndex++; continue }
      const g = b.groups.find((x) => m![x.idx] !== undefined)
      if (g) hits.push({ s: m.index, e: m.index + m[0].length, g })
    }
  }
  if (!hits.length) return text
  if (c.buckets.length > 1) hits.sort((a, b) => a.s - b.s || a.g.order - b.g.order)
  let out = '', pos = 0
  for (const h of hits) {
    if (h.s < pos) continue
    out += text.slice(pos, h.s) + h.g.open + text.slice(h.s, h.e) + h.g.close
    pos = h.e
  }
  return out + text.slice(pos)
}

// eslint-disable-next-line no-control-regex
const CTRL = /[\x00-\x08\x0a-\x1f\x7f]/g
const LINE_MAX = 4096          // 超长文本段不高亮（防用户正则回溯爆炸）
const CHUNK_BUDGET = 256 * 1024 // 每块最多高亮这么多字符，其余原样透传（cat 大文件不卡）
const HOLD_MAX = 256           // 块尾未完的行最多扣留这么长，等下一块拼上再匹配
// SGR 22–29 各自清除的属性位
const SGR_CLEAR: Record<number, number> = { 22: 0b110, 23: 1 << 3, 24: 1 << 4 | 1 << 21, 25: 1 << 5 | 1 << 6, 27: 1 << 7, 28: 1 << 8, 29: 1 << 9 }

// 每个终端一个流：push 返回可写给 xterm 的数据。
// 块尾若是未完的一行（且本块有换行，即批量输出而非键入回显）会扣留到 pending，下一块拼上再处理；
// 调用方在 pending 非空时定时 flush，避免提示符等迟迟不显示。
export function createHighlightStream() {
  let st = 0                 // 0 普通 1 ESC 2 ESC 中间字节 3 CSI 4 OSC/DCS 等字符串
  let csi = ''
  let fg = false, bg = false, attrs = 0, alt = false
  let pending = ''

  const sgr = (p: string) => {
    const ps = p ? p.split(';') : ['0']
    for (let k = 0; k < ps.length; k++) {
      const n = parseInt(ps[k], 10) || 0
      if (n === 0) { fg = bg = false; attrs = 0 }
      else if (n < 10 || n === 21) attrs |= 1 << n
      else if (SGR_CLEAR[n]) attrs &= ~SGR_CLEAR[n]
      else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) fg = true
      else if (n === 39) fg = false
      else if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) bg = true
      else if (n === 49) bg = false
      else if (n === 38 || n === 48) {
        if (n === 38) fg = true; else bg = true
        if (!ps[k].includes(':')) k += ps[k + 1] === '5' ? 2 : ps[k + 1] === '2' ? 4 : 0
      }
    }
  }
  const onCsi = (p: string, f: string) => {
    if (f === 'm' && !/^[<=>?]/.test(p)) sgr(p)
    else if ((f === 'h' || f === 'l') && p[0] === '?' && p.slice(1).split(';').some((x) => x === '1049' || x === '47' || x === '1047')) alt = f === 'h'
  }

  function push(chunk: string, c: CompiledHighlight | null, hold = true): string {
    const s = pending + chunk
    pending = ''
    let out = '', i = 0, budget = CHUNK_BUDGET
    const plain = (t: string) => {
      if (!c || alt || fg || bg || attrs || budget <= 0 || t.length > LINE_MAX) return t
      budget -= t.length
      return markText(t, c)
    }
    while (i < s.length) {
      if (st === 0) {
        CTRL.lastIndex = i
        const m = CTRL.exec(s)
        const j = m ? m.index : s.length
        if (j > i) {
          const t = s.slice(i, j)
          if (!m && hold && c && !alt && t.length <= HOLD_MAX && s.includes('\n')) { pending = t; break }
          out += plain(t)
        }
        if (!m) break
        out += m[0]; i = j + 1
        if (m[0] === '\x1b') st = 1
        continue
      }
      const ch = s[i++]
      out += ch
      const code = ch.charCodeAt(0)
      if (ch === '\x1b') { st = 1; continue }
      if (st === 4) { if (ch === '\x07') st = 0; continue }
      if (code < 0x20) continue   // 序列中的 C0 控制字符由终端执行，不改变序列状态
      if (st === 1) {
        if (ch === '[') { st = 3; csi = '' }
        else if (ch === ']' || ch === 'P' || ch === 'X' || ch === '^' || ch === '_') st = 4
        else if (code <= 0x2f) st = 2
        else { if (ch === 'c') { fg = bg = alt = false; attrs = 0 } st = 0 }   // ESC c 整体复位
      } else if (st === 2) { if (code >= 0x30 && code <= 0x7e) st = 0 }
      else if (code >= 0x40 && code <= 0x7e) { st = 0; onCsi(csi, ch) }
      else if (csi.length < 64) csi += ch
    }
    return out
  }

  return {
    push,
    flush: (c: CompiledHighlight | null) => push('', c, false),
    get pending() { return pending },
  }
}

// ── 关键字告警（iTerm2 Triggers / Xshell 触发器）：勾了「告警」的启用规则命中输出时提醒 ──
// 与着色分开匹配：已带颜色的输出（如程序自己标红的 ERROR）也要能告警。只按完整行匹配，未完的行留到下一块。
export const ALERT_INTERVAL_MS = 30_000
const ALERT_LINE_MAX = 4096
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[PX^_][^\x1b]*(?:\x1b\\)?|[ -/]*[0-~])/g

export interface CompiledAlert { rules: { id: string; pattern: string; re: RegExp }[] }
export interface AlertHit { id: string; pattern: string; line: string }

export function compileAlerts(rules: HighlightRule[]): CompiledAlert | null {
  const out: CompiledAlert['rules'] = []
  for (const r of rules) {
    if (!r.enabled || !r.notify || !r.pattern) continue
    try {
      const re = new RegExp(r.isRegex ? r.pattern : escapeRe(r.pattern), r.caseSensitive ? '' : 'i')
      if (!re.test('')) out.push({ id: r.id, pattern: r.pattern, re })
    } catch { /* 非法正则忽略 */ }
  }
  return out.length ? { rules: out } : null
}

// 每个终端一个：scan 返回本块里新命中且已过冷却期的规则（每条规则一次，带命中的那行）
export function createAlertScanner(intervalMs = ALERT_INTERVAL_MS) {
  let carry = ''
  const last = new Map<string, number>()
  return {
    scan(chunk: string, c: CompiledAlert | null, now = Date.now()): AlertHit[] {
      if (!c) { carry = ''; return [] }
      const lines = (carry + chunk).split(/\r?\n|\r/)
      carry = lines.pop() ?? ''
      if (carry.length > ALERT_LINE_MAX) carry = ''
      const hits: AlertHit[] = []
      for (const raw of lines) {
        if (!raw) continue
        const line = raw.replace(ANSI, '')
        if (!line.trim() || line.length > ALERT_LINE_MAX) continue
        for (const r of c.rules) {
          if (now - (last.get(r.id) ?? -Infinity) < intervalMs || !r.re.test(line)) continue
          last.set(r.id, now)
          hits.push({ id: r.id, pattern: r.pattern, line: line.trim() })
        }
      }
      return hits
    },
    reset() { carry = '' },
  }
}
