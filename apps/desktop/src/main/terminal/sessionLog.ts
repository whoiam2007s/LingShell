import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import xtermHeadless from '@xterm/headless'
import type { Terminal as HTerm, IMarker } from '@xterm/headless'
import { makeStartedAtLabel } from '@lingshell/platform'
import { pruneRecordings } from './recorder.js'

// 会话日志（Xshell「会话日志」）：每个终端的输出存成纯文本 <dir>/<YYYY-MM-DD>/<主机名|本地>_<HHmmss>_<短id>.log。
// 记的是 onData（UI 上看到的输出，含回显）：AI execCapture 期间原始输出不走 onData，哨兵包装天然不进日志。
// 只记输出不记键入：密码提示下不回显，日志里没有密码（录像不同，录像记键入）。
// 输出先过虚拟屏幕（ScreenLines），记的是屏幕上最终的样子；缓冲 1 秒批量追加，不阻塞终端。

// headless 是 CJS 包，Node ESM 下只有 default 导出
const { Terminal } = xtermHeadless

const MAX_LINE = 16_384   // 一直不换行（如 cat 二进制）时强制断行，防内存涨

/** 终端输出 → 完整文本行（按字符流，不认光标定位）。自动应答取光标所在行用。状态跨 chunk 保留（转义序列/CRLF 被切开也对） */
export class LineFilter {
  private line: string[] = []
  private cur = 0
  private state: 'text' | 'esc' | 'inter' | 'csi' | 'osc' | 'oscEsc' = 'text'
  private params = ''

  feed(s: string): string[] {
    const out: string[] = []
    for (const ch of s) {
      const c = ch.codePointAt(0)!
      switch (this.state) {
        case 'esc':
          if (ch === '[') { this.state = 'csi'; this.params = '' }
          else if (ch === ']' || ch === 'P' || ch === 'X' || ch === '^' || ch === '_') this.state = 'osc'   // OSC/DCS/SOS/PM/APC：吃到 BEL 或 ST
          else this.state = c >= 0x20 && c <= 0x2f ? 'inter' : 'text'
          continue
        case 'inter':   // ESC ( B 之类：中间字节后跟一个终止字节
          if (c < 0x20 || c > 0x2f) this.state = 'text'
          continue
        case 'csi':
          if (c >= 0x40 && c <= 0x7e) { this.state = 'text'; this.csi(ch) } else this.params += ch
          continue
        case 'osc':
          if (ch === '\x07') this.state = 'text'
          else if (ch === '\x1b') this.state = 'oscEsc'
          continue
        case 'oscEsc':
          this.state = ch === '\\' ? 'text' : 'osc'
          continue
      }
      if (ch === '\x1b') this.state = 'esc'
      else if (ch === '\r') this.cur = 0
      else if (ch === '\n') out.push(this.commit())
      else if (ch === '\b') this.cur = Math.max(0, this.cur - 1)
      else if (ch === '\t' || (c >= 0x20 && c !== 0x7f && (c < 0x80 || c > 0x9f))) {
        while (this.line.length < this.cur) this.line.push(' ')
        this.line[this.cur++] = ch
        if (this.line.length >= MAX_LINE) out.push(this.commit())
      }
    }
    return out
  }

  /** 当前未换行的行（光标所在行，已去转义），不清空。自动应答匹配提示符用 */
  peek(): string { return this.line.join('').trimEnd() }

  /** 关闭时：未换行的最后一行（如提示符）也交出去 */
  end(): string[] {
    const l = this.commit()
    return l ? [l] : []
  }

  // 只处理行内光标/擦除，其余 CSI（颜色、清屏、光标上下移动）丢弃
  private csi(f: string): void {
    const n = parseInt(this.params, 10)
    if (f === 'K') {
      if (this.params === '2') this.line = []
      else if (this.params === '' || this.params === '0') this.line.length = Math.min(this.line.length, this.cur)
    } else if (f === 'D') this.cur = Math.max(0, this.cur - (n || 1))
    else if (f === 'C') this.cur += n || 1
    else if (f === 'G') this.cur = Math.max(0, (n || 1) - 1)
  }

  private commit(): string {
    const l = this.line.join('').trimEnd()
    this.line = []; this.cur = 0
    return l
  }
}

/** <root>/<YYYY-MM-DD>/<label>_<HHmmss>_<短id>.log；label 去掉 Windows 文件名非法字符 */
export function sessionLogPath(root: string, label: string, terminalId: string, at: Date): string {
  const [day, time] = makeStartedAtLabel(at).split('_')
  const safe = label.replace(/[\\/:*?"<>|\p{Cc}\s]+/gu, '_').replace(/^[._]+|[._]+$/g, '').slice(0, 60) || '终端'   // i18n-ignore 文件名要稳定
  const short = terminalId.replace(/^term_/, '').replace(/[^\w-]/g, '').slice(0, 8)
  return join(root, day, `${safe}_${time.replace(/-/g, '')}_${short}.log`)
}

/** 删早于 days 天的日期目录（同录像的清理规则） */
export const pruneSessionLogs = pruneRecordings

export const ALT_SCREEN_MARK = '[全屏程序输出未记录]'   // i18n-ignore 会话日志文件里的固定标记（测试按它断言）

/**
 * 虚拟屏幕：输出喂进 headless xterm，按屏幕内容记行（ConPTY 用光标定位重绘也不会重复/错位）。
 * 行滚出屏幕顶部进入回滚区才算定稿交出；备用屏（vim/top/less）不记，每次进入记一行标记。
 * 用视口顶行上的 marker 判断哪些行新滚出：区域滚动不进回滚、回滚满了裁掉旧行时 baseY 不变，只看 baseY 分不清
 */
export class ScreenLines {
  private t: HTerm
  private mark?: IMarker
  private partial = ''   // 软换行的前半截（后半截还在屏上）

  constructor(cols: number, rows: number, private emit: (lines: string[]) => void) {
    // scrollOnEraseInDisplay：清屏(ED2)把屏上内容推进回滚，clear 前的输出也能记下
    this.t = new Terminal({ cols, rows, scrollback: 200, allowProposedApi: true, scrollOnEraseInDisplay: true })
    this.remark()
    this.t.onScroll(() => this.drain())
    this.t.onWriteParsed(() => this.drain())
    // 切备用屏前（仍在主屏）：光标上方的行（含刚敲的 vim 命令）先定稿，再记标记，顺序才对
    this.t.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (ps) => {
      if (this.t.buffer.active.type === 'normal' && ps.some((p) => p === 47 || p === 1047 || p === 1049)) {
        this.drain()
        const b = this.t.buffer.normal
        this.emit([...this.take(Math.max(b.baseY, this.mark?.line ?? 0), b.baseY + b.cursorY), ALT_SCREEN_MARK])
        this.remark(0)
      }
      return false   // 交给默认处理真正切屏
    })
  }

  write(s: string): void { this.t.write(s) }
  resize(cols: number, rows: number): void { this.t.resize(cols, rows); this.drain() }
  /** 等已写入的数据解析完（headless 写入是异步分片的） */
  settle(): Promise<void> { return new Promise((r) => this.t.write('', r)) }

  /** 关闭：先等解析完，再把屏上剩下的内容（到最后一个非空行）交出 */
  async end(): Promise<void> {
    await this.settle()
    this.drain()
    const b = this.t.buffer.normal
    let last = b.length - 1
    while (last >= b.baseY && !b.getLine(last)?.translateToString(true)) last--
    this.emit(this.take(Math.max(b.baseY, this.mark?.line ?? 0), last + 1))
    if (this.partial) this.emit([this.partial.trimEnd()])
    this.t.dispose()
  }

  // marker = 第一条未记的行，默认视口顶行；切备用屏时设在光标行（上方已记）
  private remark(offset = -this.t.buffer.normal.cursorY): void {
    this.mark?.dispose()
    this.mark = this.t.registerMarker(offset)
  }

  private drain(): void {
    if (this.t.buffer.active.type !== 'normal') return
    const b = this.t.buffer.normal
    const start = this.mark && !this.mark.isDisposed ? this.mark.line : 0   // 清回滚(ESC[3J)后 marker 失效，回滚里全是新的
    if (start >= b.baseY) return
    this.emit(this.take(start, b.baseY))
    this.remark()
  }

  // [from, to) 行转文本，软换行拼回一行
  private take(from: number, to: number): string[] {
    const b = this.t.buffer.normal
    const out: string[] = []
    for (let i = from; i < to; i++) {
      const wrapped = !!b.getLine(i + 1)?.isWrapped
      this.partial += b.getLine(i)?.translateToString(!wrapped) ?? ''
      if (!wrapped || this.partial.length >= MAX_LINE) { out.push(this.partial.trimEnd()); this.partial = '' }
    }
    return out
  }
}

interface Log { label: string; screen: ScreenLines; day: string; file: string; buf: string[]; chain: Promise<void>; failed: boolean }

export interface SessionLoggerOpts {
  dir: () => string                 // 每次新开文件时取（设置可改）
  timestamps: () => boolean         // 每行加 [HH:mm:ss]
  onError?: (msg: string, data?: unknown) => void
  now?: () => number
  flushMs?: number
  // 落盘前改写定稿的行（密钥保险箱：明文 → {{secret:名称}}）；按批整段处理，跨行的值也认得出
  mask?: (text: string) => string
}

export class SessionLogger {
  private logs = new Map<string, Log>()
  private timer?: ReturnType<typeof setInterval>
  constructor(private o: SessionLoggerOpts) {}

  private now(): Date { return new Date(this.o.now?.() ?? Date.now()) }
  private dayOf(d: Date): string { return makeStartedAtLabel(d).split('_')[0] }

  has(id: string): boolean { return this.logs.has(id) }
  ids(): string[] { return [...this.logs.keys()] }

  /** cols/rows：终端当前尺寸（未知用 80x24，之后 resize 跟上） */
  open(id: string, label: string, cols = 80, rows = 24): void {
    if (this.logs.has(id)) return
    const d = this.now()
    const l: Log = { label, screen: undefined!, day: this.dayOf(d), file: sessionLogPath(this.o.dir(), label, id, d), buf: [], chain: Promise.resolve(), failed: false }
    l.screen = new ScreenLines(cols, rows, (lines) => this.push(l, lines))
    this.logs.set(id, l)
    if (!this.timer) { this.timer = setInterval(() => this.tick(), this.o.flushMs ?? 1000); this.timer.unref?.() }
  }

  data(id: string, chunk: string): void { this.logs.get(id)?.screen.write(chunk) }
  resize(id: string, cols: number, rows: number): void { this.logs.get(id)?.screen.resize(cols, rows) }
  /** 等该终端已收到的输出解析完（测试/取文件前用） */
  async settle(id: string): Promise<void> { await this.logs.get(id)?.screen.settle() }

  /** 定时：过了零点换新文件（旧缓冲先落旧文件），再批量追加 */
  tick(): void {
    const d = this.now()
    for (const [id, l] of this.logs) {
      void this.flush(l)
      const day = this.dayOf(d)
      if (day !== l.day) { l.day = day; l.file = sessionLogPath(this.o.dir(), l.label, id, d) }
    }
  }

  /** 当前文件路径（先落盘缓冲；还没写过内容就建个空文件，好让系统打开） */
  async fileOf(id: string): Promise<string | undefined> {
    const l = this.logs.get(id)
    if (!l) return undefined
    await l.screen.settle()
    await this.flush(l, true)
    return l.file
  }

  /** 结束一个终端的日志：屏上剩下的内容（提示符等）也写进去，resolve 于落盘后 */
  async close(id: string): Promise<void> {
    const l = this.logs.get(id)
    if (!l) return
    this.logs.delete(id)
    if (!this.logs.size && this.timer) { clearInterval(this.timer); this.timer = undefined }
    await l.screen.end()
    return this.flush(l)
  }
  closeAll(): Promise<void> { return Promise.all(this.ids().map((id) => this.close(id))).then(() => {}) }

  private push(l: Log, raw: string[]): void {
    if (!raw.length) return
    const lines = this.o.mask ? this.o.mask(raw.join('\n')).split('\n') : raw
    if (!this.o.timestamps()) { l.buf.push(...lines); return }
    const t = `[${makeStartedAtLabel(this.now()).split('_')[1].replace(/-/g, ':')}] `
    for (const x of lines) l.buf.push(t + x)
  }

  // 串行追加（同一文件不乱序）；touch=缓冲空也追加空串以建出文件。失败每个终端只记一次日志
  private flush(l: Log, touch = false): Promise<void> {
    if (!l.buf.length && !touch) return l.chain
    const text = l.buf.length ? l.buf.join('\n') + '\n' : ''
    const file = l.file
    l.buf = []
    l.chain = l.chain
      .then(async () => { await mkdir(dirname(file), { recursive: true, mode: 0o700 }); await appendFile(file, text, { encoding: 'utf8', mode: 0o600 }) })
      .catch((e) => { if (!l.failed) { l.failed = true; this.o.onError?.('会话日志写入失败', { file, error: String(e) }) } })   // i18n-ignore 日志
    return l.chain
  }
}
