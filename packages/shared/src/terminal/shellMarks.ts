// Shell integration 标记（OSC 133，VS Code / Warp 同款）→ 一条条「用户命令」：退出码、耗时、cwd、各段在屏幕上的位置。
// 标记由 terminal-core/promptNewline.ts 注入的 bash 钩子打出，顺序：D;<码>（上条结束）→ 633;P;Cwd → A（提示符）→ B（输入）→ C（执行）。
// 字节流里的拆包（序列跨 chunk）交给 xterm 解析器：onShellMarks 挂 registerOscHandler，回调里同步读光标，位置才准。
// AI 哨兵命令：捕获期原始输出不转发 UI，C 被吞，只剩结束后的孤立 D → 不成命令；另外 AI 锁定时 reset 丢掉进行中的状态。
// 非 bash / bash <4.4（无 PS0 即无 C）：没有完整的 C…D，什么都不产出。

export type ShellMark =
  | { kind: 'A' | 'B' | 'C' }
  | { kind: 'D'; exitCode?: number }
  | { kind: 'cwd'; cwd: string }

/** OSC 133 载荷（ESC]133; 之后、BEL 之前的部分）→ 标记；不认识的返回 null */
export function parseOsc133(data: string): ShellMark | null {
  const [k, code] = data.split(';')
  if (k === 'A' || k === 'B' || k === 'C') return { kind: k }
  if (k !== 'D') return null
  const n = code !== undefined && /^-?\d+$/.test(code) ? parseInt(code, 10) : undefined
  return n === undefined ? { kind: 'D' } : { kind: 'D', exitCode: n }
}

/** OSC 633 载荷：只认 P;Cwd=<目录> */
export function parseOsc633(data: string): ShellMark | null {
  const m = /^P;Cwd=([\s\S]*)$/.exec(data)
  return m ? { kind: 'cwd', cwd: m[1] } : null
}

export interface ShellCommand<P> {
  prompt?: P       // A：提示符开始（命令跳转用）
  input?: P        // B：用户输入开始（标记点、读命令行）
  output: P        // C：输出开始
  end: P           // D：输出结束
  exitCode?: number
  durationMs: number
  cwd?: string     // 执行时（C 那刻）的目录
}

// 状态机：A→(B)→C→D 凑成一条命令。位置 P 由调用方给（UI 里是 xterm marker），
// 惰性取（pos()），被忽略的标记不白建 marker；作废的位置经 onDrop 交还调用方释放。
export class ShellMarkTracker<P> {
  private prompt?: P
  private input?: P
  private run?: { prompt?: P; input?: P; output: P; start: number; cwd?: string }
  private cwd?: string

  constructor(private h: { onCommand: (c: ShellCommand<P>) => void; onDrop?: (p: P) => void; now?: () => number }) {}

  feed(m: ShellMark, pos: () => P): void {
    const drop = (p?: P) => { if (p !== undefined) this.h.onDrop?.(p) }
    switch (m.kind) {
      case 'cwd': this.cwd = m.cwd; return
      case 'A':
        drop(this.prompt); drop(this.input); this.input = undefined
        this.prompt = pos()
        return
      case 'B':
        drop(this.input)
        this.input = pos()
        return
      case 'C':
        if (this.prompt === undefined && this.input === undefined) return   // 没见过提示符：不知道是谁的命令，不标
        if (this.run) this.dropRun()   // 上一条的 D 丢了（被静默探测吞掉等）：作废
        this.run = { prompt: this.prompt, input: this.input, output: pos(), start: this.now(), cwd: this.cwd }
        this.prompt = this.input = undefined
        return
      case 'D': {
        const r = this.run
        if (!r) return   // 孤立 D：空行 / 注释行 / AI 哨兵命令结束
        this.run = undefined
        this.h.onCommand({ prompt: r.prompt, input: r.input, output: r.output, end: pos(), exitCode: m.exitCode, durationMs: this.now() - r.start, cwd: r.cwd })
      }
    }
  }

  /** 当前是否停在提示符：idle = 见过 A/B 且还没 C（input = B 的位置，可据此判断输入行是否为空）；
   *  busy = 有命令在跑；unknown = 没有可依的标记（非 bash / 刚被 reset），由调用方放宽处理 */
  promptState(): { kind: 'idle'; input?: P } | { kind: 'busy' } | { kind: 'unknown' } {
    if (this.run) return { kind: 'busy' }
    if (this.prompt !== undefined || this.input !== undefined) return { kind: 'idle', input: this.input }
    return { kind: 'unknown' }
  }

  /** AI 开始执行（终端锁定）：丢掉进行中的状态，免得把 AI 命令的 D 算到用户命令头上 */
  reset(): void {
    this.dropRun()
    for (const p of [this.prompt, this.input]) if (p !== undefined) this.h.onDrop?.(p)
    this.prompt = this.input = undefined
  }

  private dropRun(): void {
    const r = this.run
    this.run = undefined
    if (r) for (const p of [r.prompt, r.input, r.output]) if (p !== undefined) this.h.onDrop?.(p)
  }
  private now(): number { return this.h.now?.() ?? Date.now() }
}

// 结构化的最小 xterm 接口：UI 的 @xterm/xterm 与测试里的 @xterm/headless 都满足
interface OscHost { parser: { registerOscHandler(ident: number, cb: (data: string) => boolean): { dispose(): void } } }

/** 在 xterm 上挂 OSC 133/633 处理器（返回 true = 吞掉，不再交给默认处理）。回调在解析到序列时同步触发 */
export function onShellMarks(term: OscHost, cb: (m: ShellMark) => void): () => void {
  const hs = [
    term.parser.registerOscHandler(133, (d) => { const m = parseOsc133(d); if (m) cb(m); return true }),
    term.parser.registerOscHandler(633, (d) => { const m = parseOsc633(d); if (m) cb(m); return true }),
  ]
  return () => hs.forEach((h) => h.dispose())
}

interface BufLine { isWrapped: boolean; translateToString(trimRight?: boolean, start?: number, end?: number): string }
interface Buf { getLine(y: number): BufLine | undefined }

/** 读缓冲里 [from, to) 区间的纯文本（行内列号精确；软折行拼回一行）。最多读 maxRows 行，超出只留末尾（报错通常在最后） */
/**
 * AI 命令的隐藏结束标记（Windows 本地 Git Bash，隐藏属性的文字，见 terminal-core/sentinel.ts 的 OscSentinelParser）：
 * 屏幕上看不见，但在 xterm 缓冲里是文字，读缓冲做命令块 / 导出 / 快速选择时去掉。blank=true 换成等长空格（保持列位置）
 */
export function stripEndMarks(s: string, blank = false): string {
  return s.replace(/__CW_END_[0-9a-f]+_\d+__/g, (m) => (blank ? ' '.repeat(m.length) : ''))
}

export function readBufferRange(buf: Buf, from: { line: number; col: number }, to: { line: number; col: number }, maxRows = 2000): string {
  const start = Math.max(from.line, to.line - maxRows)
  let out = ''
  for (let y = start; y <= to.line; y++) {
    const l = buf.getLine(y)
    if (!l) break
    const trim = y !== to.line && !buf.getLine(y + 1)?.isWrapped   // 折行处的空格是内容，不能剪
    const s = l.translateToString(trim, y === from.line ? from.col : 0, y === to.line ? to.col : undefined)
    out += (y > start && !l.isWrapped ? '\n' : '') + s
  }
  return stripEndMarks(out)
}

/** 耗时显示：850ms / 1.2s / 2m05s */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

/** Ctrl+Shift+↑/↓ 命令跳转：从当前视口顶行 cur 出发，找上一个 / 下一个命令起始行；没有返回 undefined */
export function adjacentLine(lines: number[], cur: number, dir: -1 | 1): number | undefined {
  let best: number | undefined
  for (const l of lines) {
    if (l < 0) continue   // marker 已随 scrollback 裁掉
    if (dir < 0 ? l < cur && (best === undefined || l > best) : l > cur && (best === undefined || l < best)) best = l
  }
  return best
}

export const FAILED_OUTPUT_MAX = 4000

/** 失败命令「问 AI」的引用文本：命令、退出码、目录、输出（超长留末尾） */
type QuoteInput = { title: string; command: string; exitCode?: number; cwd?: string; output: string }
const quoteBody = (o: QuoteInput) => {
  const out = o.output.replace(/\s+$/, '')
  const body = out.length > FAILED_OUTPUT_MAX ? `…（前面省略 ${out.length - FAILED_OUTPUT_MAX} 字）\n${out.slice(-FAILED_OUTPUT_MAX)}` : out   // i18n-ignore 发给 AI 的话
  const fence = '```'
  return `${fence}\n$ ${o.command || '（未取到命令行）'}\n${body || '（无输出）'}\n${fence}\n`   // i18n-ignore 发给 AI 的话
}

export function failedCommandQuote(o: QuoteInput): string {
  return `终端「${o.title}」里这条命令失败了（退出码 ${o.exitCode ?? '未知'}${o.cwd ? `，目录 ${o.cwd}` : ''}），帮我看看原因：\n` + quoteBody(o)   // i18n-ignore 发给 AI 的话
}

/** 命令点菜单「问 AI」：失败的问原因（同 failedCommandQuote），成功 / 无退出码的请 AI 看结果 */
export function commandQuote(o: QuoteInput): string {
  if (o.exitCode !== undefined && o.exitCode !== 0) return failedCommandQuote(o)
  return `终端「${o.title}」里这条命令的执行结果（退出码 ${o.exitCode ?? '未知'}${o.cwd ? `，目录 ${o.cwd}` : ''}），帮我看看：\n` + quoteBody(o)   // i18n-ignore 发给 AI 的话
}
