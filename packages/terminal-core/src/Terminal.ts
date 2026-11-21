import { tr } from '@lingshell/shared'
import { makeSentinel, SentinelParser, stripAnsi, type CaptureParser, type SentinelResult } from './sentinel.js'
import { detectNeedsInput, groomOutput, stripQuotedText } from './terminalGroom.js'

export type DataHandler = (chunk: string) => void
export type ExitHandler = (info: { code?: number; reason?: string }) => void
export type CommandHandler = (command: string, source: 'user' | 'ai') => void
// silent：不回显命令/输出到 UI、不记命令历史（内部探测用，如资源管理器取 pwd）
// wire：实际发进 shell 的命令（密钥保险箱占位符已换成明文）；command 只用于回显 / 命令历史 / 拦截判定，始终是占位符原文
// onStall：命令长时间无输出时的兜底判定（规则没识别出来时由调用方问模型「是不是在等输入」），返回 'waiting' 则中止
// handoff：判定为等输入时不发 Ctrl-C，命令留在终端里交给用户敲答案（终端保持原样，调用方不应再往里发命令）
export interface ExecCaptureOpts {
  silent?: boolean
  wire?: string
  onStall?: (tail: string) => Promise<'waiting' | 'continue'>
  handoff?: boolean
  /**
   * auto 模式：判定为等输入时问一次「这条提示怎么答」。
   * 返回要写进终端的一行（不含换行，如 'y'）；返回 undefined = 交回给用户（命令留在终端里）。
   * 一条命令最多自动答 MAX_AUTO_ANSWERS 次，防止死循环。
   */
  answerFor?: (prompt: string) => Promise<string | undefined>
}

/** auto 模式下同一条命令最多自动答几次（多步向导、连续确认会问好几次） */
const MAX_AUTO_ANSWERS = 5
// noHistory：不进用户输入行缓冲、不记命令历史（自动应答发的密码/yes 不是命令）
export interface WriteOpts { noHistory?: boolean }

export interface Terminal {
  readonly id: string
  readonly busy: boolean   // 捕获中或有未回车的用户输入（静默探测前自检用）
  write(data: string, opts?: WriteOpts): void
  onData(h: DataHandler): () => void
  onExit(h: ExitHandler): () => void
  onCommand(h: CommandHandler): () => void
  execCapture(command: string, timeoutMs?: number, signal?: AbortSignal, opts?: ExecCaptureOpts): Promise<SentinelResult>
  readSnapshot(lines?: number): string
  resize(cols: number, rows: number): void
  kill(): void
  resetExitGuard(): void
}

const FORBIDDEN_EXEC = [/^(exit|logout)\b/, /^kill\s+-9\s+\$\$/]
const FULLSCREEN = [/^(vim?|nano|emacs|top|htop|less|more|man|tmux|screen)\b/]
// 「卡在等输入」判据：命令至少跑够这么久，再连续这么久没输出才算（避免 apt 之类先打一堆日志被误杀）
const STALL_MIN_RUN_MS = 10_000
const STALL_MS = 8_000
// 按 ; && || | & 换行 切段逐段检查（`cd /tmp && exit`、`sudo vim x` 也要拦），去掉段首 sudo。
// 先剥掉引号里的内容：`grep "exit" 文件` 里的 exit 只是参数，不该当成会关终端的命令。
function anySegment(command: string, res: RegExp[]): boolean {
  return stripQuotedText(command).split(/&&|\|\||[;|&\n]/)
    .map((seg) => seg.trim().replace(/^sudo\s+/, ''))
    .some((seg) => res.some((re) => re.test(seg)))
}

// 本地/SSH 终端公共逻辑：onData 分发、scrollback、哨兵 execCapture、静默回显、防护。
// 子类只实现底层 IO：writeRaw / killRaw / resize，并把底层 data/exit 接到 onRawData/onRawExit。
export abstract class BaseTerminal implements Terminal {
  private handlers = new Set<DataHandler>()
  private exitHandlers = new Set<ExitHandler>()
  private commandHandlers = new Set<CommandHandler>()
  private inputLine = ''   // 用户输入行缓冲（write 累积，遇 \r emit）
  private esc: 'none' | 'esc' | 'csi' = 'none'   // 转义序列跳过态：跨 write 保持（序列可能跨 chunk）
  private scrollback: string[] = []
  private partial = ''
  private capturing?: {
    parser: CaptureParser; raw: boolean; resolve: (r: SentinelResult, tail: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout
    /** 收到新输出就重排静默计时（判断「是不是卡在等输入」用） */
    bumpStall?: () => void
  }
  private static MAX_LINES = 2000

  constructor(public readonly id: string) {}

  // 终端是否"忙"：正在 execCapture 捕获中，或用户敲了一半命令未回车。
  // 用于静默探测（如资源管理器取 pwd）前的自检——忙则不发探测命令，避免干扰正在执行/输入的内容。
  // 注意：无法可靠探知"用户手敲的前台命令(如 wget)是否在跑"——PTY 层看不到前台进程；此判据只覆盖能确知的忙态。
  get busy(): boolean { return this.capturing !== undefined || this.inputLine.length > 0 }
  protected get capturingNow(): boolean { return this.capturing !== undefined }   // AI 哨兵命令在跑（不算用户半行输入）

  protected abstract writeRaw(data: string): void
  protected abstract killRaw(): void
  abstract resize(cols: number, rows: number): void

  // 捕获期间也把原始输出照常转给 UI（不另行回显命令/输出）：tmux 里必须这样——tmux 按它认为屏幕上已有的内容做增量重绘，
  // 中间漏掉一段，xterm 就和 tmux 的屏幕对不上（光标错位、残影）。代价是用户能看到哨兵包装命令和标记行
  protected rawDuringCapture = false

  /**
   * 一次捕获怎么包装、怎么解析。默认：文字哨兵（__CW_START/END），捕获期间原始输出不转给 UI，另外回显命令和输出。
   * 子类可换成别的（Windows 本地 Git Bash 用不可见 OSC 标记 + 原样显示，见 LocalTerminal.ts）；raw = 捕获期间原样转给 UI
   */
  protected makeCapture(_display: string, wire: string, _silent: boolean): { wrapped: string; parser: CaptureParser; raw?: boolean; cleanup?: () => void } {
    const s = makeSentinel(wire)
    return { wrapped: s.wrapped, parser: new SentinelParser(s) }
  }

  protected onRawData(d: string): void {
    if (!this.capturing || this.capturing.raw) this.handlers.forEach((h) => h(d))
    this.pushScrollback(d)
    if (this.capturing) {
      this.capturing.bumpStall?.()   // 有新输出：静默计时重排（说明它还在干活，不是卡在等输入）
      this.capturing.parser.feed(d)
      const r = this.capturing.parser.result()
      if (r) this.finishCapture(r, this.capturing.parser.tail(d))
    }
  }
  private exited = false
  protected onRawExit(info: { code?: number; reason?: string }): void {
    if (this.exited) return   // 一次性：SSH 断线时 channel.close + client.close 会双触发，去重
    this.exited = true
    this.abortCapture()
    this.exitHandlers.forEach((h) => h(info))
  }

  // 重连复用同实例时重置一次性 exit 守卫，否则重连后再次断线不会触发 onExit。
  resetExitGuard(): void { this.exited = false }

  private pushScrollback(d: string): void {
    const text = stripAnsi(this.partial + d)   // 拼上未完行再剥：OSC 标记（每个提示符都有）跨 chunk 时半截不残留
    const lines = text.split(/\r?\n/)
    this.partial = lines.pop() ?? ''
    for (const ln of lines) this.scrollback.push(ln)
    if (this.scrollback.length > BaseTerminal.MAX_LINES) {
      this.scrollback.splice(0, this.scrollback.length - BaseTerminal.MAX_LINES)
    }
  }
  private finishCapture(r: SentinelResult, tail: string): void {
    const cap = this.capturing!
    clearTimeout(cap.timer)
    this.capturing = undefined
    cap.resolve(r, tail)
  }
  // 终端没了（退出/kill）：捕获立即失败，不干等超时、也不再往死 pty 写 \x03
  private abortCapture(): void {
    const cap = this.capturing
    if (!cap) return
    clearTimeout(cap.timer)
    this.capturing = undefined
    cap.reject(new Error('terminal_disconnected'))
  }
  private emitToUi(s: string): void { this.handlers.forEach((h) => h(s)) }

  // ponytail: 用户命令捕获用简单行缓冲(遇 \r 切行)，并跳过完整 ESC/CSI/SS3 转义序列(方向键等)避免 garbage；
  // 状态机跨 write 保持(序列可能跨 chunk)。多行粘贴/退格够用，要精确再上 PTY 行解析。
  write(data: string, opts?: WriteOpts): void {
    if (opts?.noHistory) { this.writeRaw(data); return }
    for (const ch of data) {
      const code = ch.charCodeAt(0)
      if (this.esc === 'csi') {                          // CSI/SS3：吞到终止字节(0x40–0x7E)为止
        if (code >= 0x40 && code <= 0x7e) this.esc = 'none'
      } else if (this.esc === 'esc') {                   // ESC 后第一个字符：[ 或 O 走 CSI/SS3，否则两字符转义就此结束
        this.esc = (ch === '[' || ch === 'O') ? 'csi' : 'none'
      } else if (ch === '\x1b') {                        // ESC：进入转义序列跳过态
        this.esc = 'esc'
      } else if (ch === '\r' || ch === '\n') {
        const line = this.inputLine.trim()
        if (line) this.emitCommand(line, 'user')
        this.inputLine = ''
      } else if (ch === '\x7f' || ch === '\b') {
        this.inputLine = this.inputLine.slice(0, -1)   // 退格：删缓冲末字符
      } else if (ch === '\x03' || ch === '\x15') {
        this.inputLine = ''                            // Ctrl-C / Ctrl-U：整行作废
      } else if (ch === '\x17') {
        this.inputLine = this.inputLine.replace(/\S*\s*$/, '')   // Ctrl-W：删前一个词
      } else if (ch >= ' ') {
        this.inputLine += ch                           // 可见字符累积；控制字符(\x03 等)忽略
      }
    }
    this.writeRaw(data)
  }
  onData(h: DataHandler): () => void { this.handlers.add(h); return () => this.handlers.delete(h) }
  onExit(h: ExitHandler): () => void { this.exitHandlers.add(h); return () => this.exitHandlers.delete(h) }
  onCommand(h: CommandHandler): () => void { this.commandHandlers.add(h); return () => this.commandHandlers.delete(h) }
  private emitCommand(command: string, source: 'user' | 'ai'): void { this.commandHandlers.forEach((h) => h(command, source)) }
  kill(): void { this.abortCapture(); this.killRaw() }

  readSnapshot(lines = 200): string {
    const all = this.partial ? [...this.scrollback, this.partial] : this.scrollback
    return all.filter((ln) => !/__CW_(START|END)_[0-9a-f]+__/.test(ln)).slice(-lines).join('\n')
  }

  execCapture(command: string, timeoutMs = 50000, signal?: AbortSignal, opts?: ExecCaptureOpts): Promise<SentinelResult> {
    if (anySegment(command, FORBIDDEN_EXEC)) {
      return Promise.reject(new Error(`forbidden_command: ${tr('会终止终端，已拒绝执行')}`))
    }
    if (anySegment(command, FULLSCREEN)) {
      return Promise.reject(new Error(`fullscreen_program: ${tr('交互全屏程序无法捕获，请用只读快照')}`))
    }
    if (this.capturing) return Promise.reject(new Error('terminal_busy'))
    if (signal?.aborted) return Promise.reject(new Error('aborted'))

    // 包装行以空格开头（HISTCONTROL=ignorespace 时不进 bash 历史，见 sentinel.ts）
    const cap = this.makeCapture(command, opts?.wire ?? command, opts?.silent === true)
    const raw = this.rawDuringCapture || cap.raw === true
    const silent = opts?.silent === true || raw   // raw：输出已原样到了 UI，不再回显
    if (opts?.silent !== true) this.emitCommand(command, 'ai')   // 命令历史：AI 经 exec 执行的命令（silent 探测命令如 pwd 不记）
    if (!silent) this.emitToUi(`\x1b[36m${command}\x1b[0m\r\n`)   // silent 时不回显到终端
    let cleaned = false
    const cleanup = () => { if (!cleaned) { cleaned = true; cap.cleanup?.() } }
    return new Promise<SentinelResult>((resolve, reject) => {
      const finish = (r: SentinelResult) => {
        if (silent) return   // silent：不把输出回显到终端
        const out = r.output.trim()
        if (out) this.emitToUi(out.replace(/\n/g, '\r\n') + '\r\n')
      }
      const timer = setTimeout(() => {
        const cur = this.capturing
        this.capturing = undefined
        if (signal) signal.removeEventListener('abort', onAbort)
        this.writeRaw('\x03')
        const partialOut = cur ? cur.parser.partial() : ''
        const r = { output: partialOut, exitCode: -1, truncated: true }
        cleanup(); finish(r); resolve(autoAnswers.length ? { ...r, autoAnswered: [...autoAnswers] } : r)
      }, timeoutMs)
      // 中断收割：发 Ctrl-C 尝试中止命令，清 capturing，promise reject('aborted')。
      // ponytail: Ctrl-C 杀不掉的命令（SSH 端不理）留在终端，用户可见可手动处理，不升级强杀。
      const onAbort = () => {
        clearTimeout(timer)
        this.capturing = undefined
        this.writeRaw('\x03')
        cleanup()
        reject(new Error('aborted'))
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true })
      // ── 是不是卡在等输入？──
      // 判据：命令已跑够 STALL_MIN_RUN_MS，且连续 STALL_MS 没有任何新输出（有输出就重排，说明还在干活）。
      // 先看规则（中英文提示词）；规则没命中且有 onStall，就让调用方用模型判一次（每条命令最多一次）。
      const startedAt = Date.now()
      let stallTimer: NodeJS.Timeout | undefined
      let probed = false
      let answered = 0
      let answering = false
      const autoAnswers: string[] = []   // auto 模式替用户答过什么（随结果返回，让界面上看得见）
      const abortForInput = (prompt: string, forceHandoff?: boolean): void => {
        if (!this.capturing) return
        clearTimeout(timer)
        if (stallTimer) clearTimeout(stallTimer)
        const cur = this.capturing
        this.capturing = undefined
        if (signal) signal.removeEventListener('abort', onAbort)
        // handoff：不中止，命令留在终端里等用户敲答案（终端保持原样）；否则 Ctrl-C 退回提示符
        const handoff = forceHandoff === true || opts?.handoff === true
        if (!handoff) this.writeRaw('\x03')
        cleanup()
        const r: SentinelResult = {
          output: groomOutput(cur.parser.partial()), exitCode: -1, truncated: true, needsInput: prompt, stalled: true,
          ...(handoff ? { handedOff: true } : {}),
        }
        finish(r)
        if (autoAnswers.length) r.autoAnswered = [...autoAnswers]; resolve(r)
      }
      const armStall = (): void => {
        if (stallTimer) clearTimeout(stallTimer)
        stallTimer = setTimeout(checkStall, STALL_MS)   // 定时器触发时 checkStall 已定义
        stallTimer.unref?.()
      }
      // 判定为等输入之后：auto 模式先让调用方决定怎么答（y/n 自己答、需要用户就别答），答不了再交回
      const handleInput = (prompt: string): void => {
        const pick = opts?.answerFor
        if (!pick || answering || answered >= MAX_AUTO_ANSWERS) { abortForInput(prompt, !!pick); return }
        answering = true
        void pick(prompt)
          .then((answer) => {
            answering = false
            if (!this.capturing) return
            if (!answer) { abortForInput(prompt, true); return }   // 交给用户：保留现场
            answered++
            autoAnswers.push(answer)
            this.writeRaw(`${answer}\r`)
            armStall()   // 答案发出去后命令会继续跑，重新计时
          })
          .catch(() => { answering = false; abortForInput(prompt, true) })
      }
      const checkStall = (): void => {
        if (!this.capturing) return
        if (Date.now() - startedAt < STALL_MIN_RUN_MS) { armStall(); return }
        const tail = this.capturing.parser.partial()
        const byRule = detectNeedsInput(tail)
        if (byRule) { handleInput(byRule); return }
        const ask = opts?.onStall
        if (!ask || probed) { armStall(); return }
        probed = true
        void ask(tail)
          .then((verdict) => {
            if (verdict === 'waiting') {
              const last = tail.trimEnd().split('\n').pop()?.trim().slice(0, 200)
              handleInput(last || '（检测到命令在等待输入）')   // i18n-ignore 模型提示词 / 给模型的结果
            } else armStall()
          })
          .catch(() => armStall())   // 判定失败：宁可多等，也不误杀
      }
      this.capturing = {
        parser: cap.parser, raw,
        bumpStall: armStall,
        resolve: (r, tail) => {
          if (signal) signal.removeEventListener('abort', onAbort)
          if (stallTimer) clearTimeout(stallTimer)
          cleanup()
          finish(r)
          if (!silent && tail) this.emitToUi(tail)   // 结束标记后的提示符；silent 探测不补，免得多一行提示符
          resolve({ ...r, output: groomOutput(r.output), ...(autoAnswers.length ? { autoAnswered: [...autoAnswers] } : {}) })
        },
        reject: (e) => { if (signal) signal.removeEventListener('abort', onAbort); cleanup(); reject(e) },
        timer,
      }
      armStall()
      this.writeRaw(cap.wrapped + '\r')
    })
  }
}
