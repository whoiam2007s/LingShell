import { randomBytes } from 'node:crypto'

// 剥控制序列：CSI（含 ? > = ! 等私有前缀/中间字节）、OSC（BEL 或 ESC \ 结尾）、字符集切换 ESC ( B、单字符 ESC 7/8/=/>/M 等。
// 不只是 bash 的输出：在 tmux 里（保持会话）看到的是 tmux 重绘出来的字节流，常夹着 ESC(B ESC[m ESC[K ESC[?25l 光标定位等
// eslint-disable-next-line no-control-regex -- 剥 ANSI 必须匹配 ESC(\x1b)/BEL(\x07) 控制字符
const ANSI = /\x1b\[[0-9;?<=>! ]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()*+][0-9A-Za-z]|\x1b[78=>DEHMc]/g
export function stripAnsi(s: string): string { return s.replace(ANSI, '') }

export interface Sentinel {
  id: string
  startMarker: string   // __CW_START_<id>__
  endMarker: string     // __CW_END_<id>__   (后跟 <exitCode>__)
  wrapped: string       // 实际写入终端的命令行
}

export function makeSentinel(command: string): Sentinel {
  // 真随机：可预测的 id 能被命令输出伪造结束标记
  const id = randomBytes(8).toString('hex')
  const startMarker = `__CW_START_${id}__`
  const endMarker = `__CW_END_${id}__`
  // 命令单引号包起来交给 eval：原样拼接时 `#` 会注释掉结束标记、`cmd &` 拼成 `&;` 语法错、
  // 多行/heredoc 收不了尾。整条仍是一行，bash 先解析完再执行，回显不会混进捕获。
  // 行首空格 → 利用 HISTCONTROL=ignorespace 抑制 history
  // eval 前缀 PAGER/GIT_PAGER=cat：只对本次 eval 生效且导出给子进程，git log 等不会卡进分页器
  const quoted = `'${command.replace(/'/g, `'\\''`)}'`
  const wrapped = ` printf '%s\\n' '${startMarker}'; PAGER=cat GIT_PAGER=cat eval ${quoted}; printf '${endMarker}%d__\\n' $?`
  return { id, startMarker, endMarker, wrapped }
}

export interface SentinelResult { output: string; exitCode: number; truncated?: boolean }

export class SentinelParser {
  private buf = ''
  private started = false
  private done: SentinelResult | null = null
  private rest = ''   // 结束标记行之后的剩余文本（已剥 ANSI），原始 chunk 定位不到标记时兜底
  private startRe: RegExp
  private endRe: RegExp

  constructor(private s: Sentinel) {
    // startMarker 后紧跟换行（printf '%s\n' 打印的那个），借此跳过命令回显行里的字面量 startMarker
    this.startRe = new RegExp(`${escapeRe(s.startMarker)}\\r?\\n`)
    this.endRe = new RegExp(`${escapeRe(s.endMarker)}(\\d+)__`)
  }

  feed(chunk: string): void {
    if (this.done) return
    this.buf += stripAnsi(chunk)
    if (!this.started) {
      // 关键：startMarker 会出现两次——① 命令回显行（bash 把整条 wrapped 命令回显，
      // 内含 `'__CW_START__'` 字面量）② printf 真正打印的、独占一行的 startMarker。
      // 必须锚定 ②：要求 startMarker 紧跟换行（printf '%s\n' 打印后是换行）。
      // 用 startRe 匹配 "startMarker + 换行"，从其后开始截取，跳过回显行的污染。
      const sm = this.startRe.exec(this.buf)
      if (!sm) return
      this.buf = this.buf.slice(sm.index + sm[0].length)
      this.started = true
    }
    const m = this.endRe.exec(this.buf)
    if (m) {
      const output = this.buf.slice(0, m.index)
      this.done = { output: stripTrailingNewline(stripLeadingNewline(output)), exitCode: parseInt(m[1], 10) }
      this.rest = stripLeadingNewline(this.buf.slice(m.index + m[0].length))
    }
  }

  result(): SentinelResult | null { return this.done }

  // 超时时取已捕获的部分输出（startMarker 之后，结束标记未到）
  partial(): string { return this.started ? stripLeadingNewline(this.buf) : '' }

  // 结束标记所在 chunk 里标记行之后的文本（通常是 shell 提示符），需转发给 UI。
  // 优先在原始 chunk 里定位以保留颜色；标记跨 chunk 时退回剥过 ANSI 的剩余文本。
  tail(rawChunk: string): string {
    const m = new RegExp(`${escapeRe(this.s.endMarker)}\\d+__(\\r?\\n)?`).exec(rawChunk)
    return m ? rawChunk.slice(m.index + m[0].length) : this.rest
  }
}

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
function stripLeadingNewline(s: string): string { return s.replace(/^\r?\n/, '') }
function stripTrailingNewline(s: string): string { return s.replace(/\r?\n$/, '') }

// ── 不可见标记（OSC 6973）：Windows 本地 Git Bash 用 ──
// ConPTY 自己维护一份屏幕，终端尺寸一变就整屏重画：哨兵包装行和 __CW_ 文字标记即使当时没转给 UI，事后也会被重画出来。
// 所以那边改成：终端里只敲 ` AI`（启动终端时经环境变量导入的 bash 函数，见 LocalTerminal.ts），函数把它换成青色的命令文字，
// 真正要执行的命令（含保险箱明文）和随机 id 写在临时文件里由函数读出。输出原样显示给用户（和 ConPTY 屏幕一致，重画不出怪东西）。
// 标记：ConPTY 只保证「屏幕上的文字」之间的先后，OSC 是立即转发、文字要等下一帧才发（实测短输出 20 次全部是 OSC 先到）。所以
//   开始 = OSC 6973;S;<id>（命令输出一定在它之后产生，不会跑到它前面）；
//   结束 = 隐藏属性（SGR 8）的文字 __CW_END_<id>_<码>__ 独占一行：和输出同为文字、顺序可靠，重画时也保持隐藏（看起来是一行空白）
export const OSC_MARK = 6973

/** 和 SentinelParser 同样的用法：feed 原始数据，result / partial / tail */
export interface CaptureParser { feed(chunk: string): void; result(): SentinelResult | null; partial(): string; tail(rawChunk: string): string }

export class OscSentinelParser implements CaptureParser {
  private buf = ''
  private started = false
  private done: SentinelResult | null = null
  private rest = ''
  private start: string
  private endRe: RegExp
  /** display：函数在开始标记前写回提示符那行的命令文字。ConPTY 可能让它晚于开始标记到达，混进输出开头，要去掉 */
  constructor(private id: string, private display = '') {
    this.start = `\x1b]${OSC_MARK};S;${id}`
    this.endRe = new RegExp(`__CW_END_${id}_(\\d+)__`)
  }
  private dropDisplay(out: string): string {
    const d = this.display.split('\n').map((l) => l.trimEnd())
    const lines = out.split('\n')
    while (lines.length && !lines[0].trim()) lines.shift()   // 回提示符那行的 \r 剥完是空行
    // 第一行前面可能带着重画出来的提示符（"$ echo hi"），只比结尾；其余行逐行相等
    if (d[0] && lines.length >= d.length && lines[0].trimEnd().endsWith(d[0]) && d.slice(1).every((l, k) => lines[k + 1].trimEnd() === l)) lines.splice(0, d.length)
    return lines.join('\n')
  }
  feed(chunk: string): void {
    if (this.done) return
    this.buf += chunk
    if (!this.started) {
      const i = this.buf.indexOf(this.start)
      if (i < 0) { this.buf = this.buf.slice(-64); return }   // 标记前是回显行，只留尾巴防标记跨 chunk
      const j = this.buf.slice(i).search(/\x07|\x1b\\/)   // eslint-disable-line no-control-regex
      if (j < 0) return
      this.buf = this.buf.slice(i + j + (this.buf[i + j] === '\x07' ? 1 : 2))
      this.started = true
    }
    // 结束标记是文字：剥掉控制序列再找（ConPTY 可能在中间插光标 / 颜色序列）
    const plain = stripAnsi(this.buf)
    const m = this.endRe.exec(plain)
    if (m) {
      const out = this.dropDisplay(plain.slice(0, m.index).replace(/\r\n?/g, '\n'))
      this.done = { output: out.replace(/\n+$/, ''), exitCode: parseInt(m[1], 10) }
      this.rest = plain.slice(m.index + m[0].length).replace(/^\r?\n/, '')
    }
  }
  result(): SentinelResult | null { return this.done }
  partial(): string { return this.started ? stripAnsi(this.buf).replace(/\r\n?/g, '\n') : '' }
  // 原样显示模式下 tail 不会再转发（输出已经原样到了 UI），这里只给接口兜底
  tail(rawChunk: string): string {
    const m = this.endRe.exec(stripAnsi(rawChunk))
    return m ? this.rest : ''
  }
}
