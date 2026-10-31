import type { Client, ClientChannel, SFTPWrapper, ShellOptions } from 'ssh2'
import { BaseTerminal } from './Terminal.js'
import { tr } from '@lingshell/shared'
import { cleanTermType, DEFAULT_TERM_TYPE, createDecoder, decodeText, encodeText, isLegacyEncoding, parseTmuxProbe, tmuxAttachCommand, tmuxCreateCommand, tmuxFallback, tmuxProbeCommand, SHELL_EXITED, TMUX_OK, type SshConnectOpts, type TermOs } from '@lingshell/shared'
import { connectSsh, mapSshError, type SshConn } from './sshConnect.js'
import { PROMPT_NEWLINE_SETUP } from './promptNewline.js'

// 保持会话（tmux）这次连接的结果：active = 交互通道跑在 tmux 里；os 来自探测时顺带的 uname；notice = 没用上 tmux 的原因；
// created = 会话是这次新建的（不是接回）
export interface TmuxState { active: boolean; os: TermOs; notice?: string; created?: boolean }

// 登录命令拆行：去掉空行和行尾空白（保留行首缩进）
export const loginLines = (s?: string): string[] => (s ?? '').split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim())

// SSH 终端：ssh2 的 Client + shell() channel 做底层 IO，公共逻辑（哨兵/scrollback/execCapture）复用 BaseTerminal。
export class SshTerminal extends BaseTerminal {
  // 工厂内立即赋值；strict 下用 definite-assignment 断言（构造器不初始化）。
  private client!: Client
  private conn?: SshConn      // 当前连接（含跳板），close() 一并断开
  private channel?: ClientChannel
  private closed = false
  private opts!: SshConnectOpts   // 保存连接参数，供原地重连复用
  private sftpSession?: SFTPWrapper   // 复用的 SFTP 会话：一个 channel 支撑所有 readdir/stat/unlink，避免每次开新 channel 撞 MaxSessions
  private sftpPending?: Promise<SFTPWrapper>   // 并发首次请求去重：多个目录同时展开时只开一个 channel

  // 建连参数（只读）：监听端口「转发到本机」用它另开一条转发连接（临时连接的主机没存凭据，只能从这拿）
  get connectOpts(): SshConnectOpts { return this.opts }

  tmuxName?: string                // 要用的 tmux 会话名（主机开了保持会话）；undefined = 普通 shell
  tmuxState?: TmuxState            // 每次建连（含重连）刷新

  private constructor(id: string) { super(id) }

  // 工厂：建立连接 + 开 shell channel，成功 resolve 实例，失败 reject 归一后的连接错误。
  static connect(id: string, opts: SshConnectOpts, tmux?: string): Promise<SshTerminal> {
    const term = new SshTerminal(id)
    term.opts = opts
    term.tmuxName = tmux
    return term.openChannel().then(() => term)
  }

  // 保持会话：探测 tmux（顺带 uname）→ 会话不在就后台建好并打入提示符设置 → 交互通道改为 attach。
  // 任一步失败都退回普通 shell（带 notice），不让建连失败
  private async prepareTmux(client: Client, name: string): Promise<TmuxState> {
    let probe
    try { probe = parseTmuxProbe(await execOn(client, tmuxProbeCommand(name), 8000)) }
    catch { return { active: false, os: 'unknown', notice: tr('检测 tmux 失败，已用普通会话') } }
    const notice = tmuxFallback(probe, isLegacyEncoding(this.opts.encoding))
    if (notice) return { active: false, os: probe.os, notice }
    if (!probe.exists) {
      const out = await execOn(client, tmuxCreateCommand(name, probe.version, PROMPT_NEWLINE_SETUP), 8000).catch(() => '')
      if (!out.includes(TMUX_OK)) return { active: false, os: probe.os, notice: tr('创建 tmux 会话失败，已用普通会话') }
      return { active: true, os: probe.os, created: true }
    }
    return { active: true, os: probe.os }
  }

  // 本次建连要给用户看的提示（tmux 没用上、agent 转发没生效等），TerminalManager 放进 info.notice
  agentNotice?: string
  get notice(): string | undefined {
    return [this.tmuxState?.notice, this.agentNotice].filter(Boolean).join(tr('；')) || undefined
  }

  // 登录命令：在提示符设置之后由 TerminalManager 调用，逐行发到交互终端（用户看得到回显，不进命令历史）。
  // 普通 shell 每次建连（含重连，都是新 shell）都发；tmux 只在本次新建会话时发，接回已有会话不发（里面可能正跑着任务）
  runLoginCommands(): boolean {
    const lines = loginLines(this.opts?.loginCommands)
    if (!lines.length || !this.channel || (this.tmuxState?.active && !this.tmuxState.created)) return false
    this.write(lines.join('\r') + '\r', { noHistory: true })
    return true
  }

  // 原地重连：复用存的 opts 重建 client + channel，复用同一 terminalId。
  // 成功后底层 IO 重新接上（onRawData/onRawExit）；失败 reject 归一错误（上层保持 disconnected）。
  async reconnect(): Promise<void> {
    this.closed = false
    this.resetExitGuard()   // 先重置：开新通道期间若立刻断，旧的一次性守卫不能把这次断线吞掉
    this.sftpSession = undefined; this.sftpPending = undefined   // 旧连接的 sftp 会话失效，重连后重建
    await this.openChannel()
  }

  // 建连主体：connect 和 reconnect 共用。经 connectSsh（含跳板）拿就绪 Client，再开 shell channel，接好 data/close。
  private async openChannel(): Promise<void> {
    // 重连场景：摘掉旧 client 的监听器并关闭（含跳板），否则其延迟 close/error 事件会误触发 onRawExit
    // 把刚重连好的终端标成 disconnected（旧闭包捕获 this，重连后 closed=false+channel truthy 使条件成立）。
    try { this.client?.removeAllListeners(); this.client?.on('error', () => {}); this.conn?.close() } catch { /* 首连时未定义 / 已关 */ }
    // 旧 channel 同理：其迟到的 close/data 不能打到新连接上
    this.channel?.removeAllListeners(); this.channel?.stderr?.removeAllListeners()
    this.channel = undefined
    // 保活：每 15s 发 SSH 心跳，连续 3 次无回应(约 45s)判定断线 → 触发 close/error → onRawExit → UI 即时标断开。
    // 否则空闲被 NAT/服务器静默丢连接时客户端察觉不到，要等用户操作才 timeout 发现。
    // 主机配了心跳（keepaliveSec）时 connectSsh 以它为准
    const conn = await connectSsh(this.opts, { keepaliveInterval: 15000, keepaliveCountMax: 3 })
    const client = conn.client
    this.conn = conn
    this.client = client
    const tmux = this.tmuxName
    this.tmuxState = tmux ? await this.prepareTmux(client, tmux) : undefined
    const inTmux = !!tmux && this.tmuxState!.active
    this.rawDuringCapture = inTmux
    // agent 转发：只在交互通道上请求（ssh2 先发 auth-agent-req 再开 shell）；没有 agent 可转发时不请求并提示
    const wantFwd = !!this.opts.agentForward
    this.agentNotice = wantFwd && !this.opts.agent ? tr('未检测到 ssh-agent / Pageant，agent 转发未生效') : undefined
    return new Promise<void>((resolve, reject) => {
      client.on('error', (err: Error) => {
        if (!this.channel) reject(mapSshError(err))            // 开 shell 前错误 → reject
        else this.onRawExit({ reason: String(err.message) })   // 已连后错误 → 断线
      })
      client.on('close', () => { if (!this.closed && this.channel) this.onRawExit({ reason: 'connection closed' }) })
      // $TERM：默认 xterm-256color（xterm.js 支持 256 色 / 真彩）；主机「高级」可改，非法值回退默认
      const pty = { term: cleanTermType(this.opts.termType) ?? DEFAULT_TERM_TYPE, cols: this.cols, rows: this.rows }
      // tmux：exec + pty 跑 attach 代替登录 shell（tmux 客户端退出 = channel 带退出码关闭，同 shell exit）
      // ssh2 运行时支持按通道的 agentForward 选项（@types/ssh2 没声明）
      const fwdOpt = { agentForward: true } as unknown as ShellOptions
      const open = (fwd: boolean, cb: (err: Error | undefined, channel: ClientChannel) => void) => inTmux
        ? client.exec(tmuxAttachCommand(tmux!), fwd ? { pty, ...fwdOpt } : { pty }, cb)
        : fwd ? client.shell(pty, fwdOpt, cb) : client.shell(pty, cb)
      const onOpen = (fwd: boolean) => (err: Error | undefined, channel: ClientChannel) => {
        // 服务器拒绝 agent 转发（AllowAgentForwarding no）时 ssh2 会连带关掉 channel：不带转发重开一次，提示用户
        if (err && fwd && /agent forwarding/i.test(err.message)) {
          this.agentNotice = tr('服务器拒绝了 agent 转发（sshd_config 里 AllowAgentForwarding no），已不带转发登录')
          open(false, onOpen(false)); return
        }
        if (err) { conn.close(); reject(mapSshError(err)); return }
        this.channel = channel
        // 流式解码（按主机编码）：多字节字符被切在两个包之间也不乱码；stdout/stderr 各自一个解码器
        const decOut = createDecoder(this.opts.encoding), decErr = createDecoder(this.opts.encoding)
        channel.on('data', (d: Buffer) => this.onRawData(decOut(d)))
        channel.stderr?.on('data', (d: Buffer) => this.onRawData(decErr(d)))
        // 远端 shell 正常退出（exit/logout）会先给退出码再 close：标 SHELL_EXITED，UI 据此不自动重连
        let exited = false
        channel.on('exit', (code: unknown) => { if (typeof code === 'number') exited = true })
        channel.on('close', () => { if (!this.closed && channel === this.channel) this.onRawExit({ reason: exited ? SHELL_EXITED : 'channel closed' }) })
        resolve()
      }
      const fwd = wantFwd && !!this.opts.agent
      open(fwd, onOpen(fwd))
    })
  }

  // 非 UTF-8 主机：键入/粘贴/AI 命令转成主机编码再发（表外字符变 '?'）
  protected writeRaw(data: string): void {
    this.channel?.write(isLegacyEncoding(this.opts.encoding) ? Buffer.from(encodeText(data, this.opts.encoding)) : data)
  }
  protected killRaw(): void {
    this.closed = true
    this.sftpSession = undefined; this.sftpPending = undefined
    try { this.channel?.end() } catch { /* 已关 */ }
    this.conn?.close()   // 目标 + 跳板一起断
  }
  // ssh2 的 setWindow 参数顺序为 (rows, cols, height, width)。
  // 记住尺寸：重连新开的 channel 沿用，不回落到 80x30
  private cols = 80
  private rows = 30
  resize(cols: number, rows: number): void { this.cols = cols; this.rows = rows; this.channel?.setWindow(rows, cols, 0, 0) }

  // 复用本终端已建立的 ssh2 连接的【单个】sftp 会话：readdir/stat/unlink 全走它，避免资源管理器每展开一个目录就开新 channel 撞服务器 MaxSessions(默认10) → "Channel open failure reason 2"。
  // 会话缓存：首次开一个并缓存；channel 出错/关闭时清缓存下次重建；并发首请求去重（多目录同时展开只开一个）。
  // ponytail: 连接断则 sftp 直接回错误，上层树标不可用，符合预期。
  sftp(): Promise<SFTPWrapper> {
    if (this.closed) return Promise.reject(new Error('terminal_disconnected'))
    if (this.sftpSession) return Promise.resolve(this.sftpSession)
    if (this.sftpPending) return this.sftpPending
    this.sftpPending = new Promise<SFTPWrapper>((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        this.sftpPending = undefined
        if (err) return reject(err)
        this.sftpSession = sftp
        // channel 关闭/出错 → 清缓存，下次 sftp() 重新开一个（如断线重连后）
        const drop = () => { if (this.sftpSession === sftp) this.sftpSession = undefined }
        sftp.on('close', drop)
        sftp.on('error', drop)
        resolve(sftp)
      })
    })
    return this.sftpPending
  }

  // 在同一连接上开【独立】exec channel 跑一条命令，拿 stdout（主机状态采集用）。
  // 不经交互 shell：不回显、不进命令历史/会话日志/录像/自动应答，也不占 BaseTerminal 的哨兵捕获（AI exec 照常）。
  // 超时关 channel 并 reject；输出超 maxBytes 截断（防异常输出撑内存）。channel 用完即关，不常驻占 MaxSessions。
  execRead(command: string, timeoutMs: number, maxBytes = 256 * 1024): Promise<string> {
    if (this.closed || !this.channel) return Promise.reject(new Error('terminal_disconnected'))
    return execOn(this.client, command, timeoutMs, maxBytes)
  }

  // 批量执行：同 execRead 走独立 exec channel，但带退出码、stderr，按主机编码解码
  exec(command: string, o: Omit<ExecFullOpts, 'encoding'>): Promise<ExecFullResult> {
    if (this.closed || !this.channel) return Promise.reject(new Error('terminal_disconnected'))
    return execFull(this.client, command, { ...o, encoding: this.opts.encoding })
  }

  // 日志实时查看：独立 exec channel 流式输出（见 execStream）
  execStream(command: string, h: ExecStreamHandlers): () => void {
    if (this.closed || !this.channel) throw new Error('terminal_disconnected')
    return execStream(this.client, command, h)
  }
}

// data：stdout/stderr 按到达顺序的原始字节；end：通道结束（只调一次，error 有值 = 开通道失败等）
export interface ExecStreamHandlers { data(chunk: Buffer): void; end(error?: string): void }

// 独立 exec channel 长跑一条命令（不分配 pty），持续回调输出；返回的函数关闭通道：
// 先发 TERM 信号（服务器支持就直接结束进程），再送 EOF 并关 channel（命令自己要能在 stdin EOF 时退出，见 shared/ops/logTail.ts）
export function execStream(client: Client, command: string, h: ExecStreamHandlers): () => void {
  let ch: ClientChannel | undefined, done = false
  const finish = (err?: string) => { if (!done) { done = true; h.end(err) } }
  const kill = (c?: ClientChannel) => {
    if (!c) return
    try { c.signal('TERM') } catch { /* 已关 */ }
    try { c.end() } catch { /* 已关 */ }
    try { c.close() } catch { /* 已关 */ }
  }
  try {
    client.exec(command, (err, channel) => {
      if (err) return finish(err.message)
      if (done) return kill(channel)   // 已经叫停后才开出来的直接关
      ch = channel
      channel.on('data', (d: Buffer) => h.data(d))
      channel.stderr?.on('data', (d: Buffer) => h.data(d))
      channel.on('close', () => finish())
    })
  } catch (e) { finish((e as Error).message) }   // 连接已断时 ssh2 可能同步抛
  return () => { finish(); kill(ch) }
}

// stdin：写进命令的标准输入后关闭（敏感内容 / 提交说明等不进命令行）
export interface ExecFullOpts { timeoutMs: number; maxBytes?: number; signal?: AbortSignal; encoding?: string; stdin?: string }
// stopped：超时 / 中止时关掉 channel，带回已收到的输出（code 为 null）
export interface ExecFullResult { code: number | null; output: string; truncated: boolean; stopped?: 'timeout' | 'aborted' }

// 独立 exec channel 跑一条命令：stdout/stderr 按到达顺序合并，超过 maxBytes 截断。通道开不出来才 reject
export function execFull(client: Client, command: string, o: ExecFullOpts): Promise<ExecFullResult> {
  const max = o.maxBytes ?? 200 * 1024
  return new Promise<ExecFullResult>((resolve, reject) => {
    let ch: ClientChannel | undefined
    let done = false, code: number | null = null, size = 0, truncated = false
    const chunks: Buffer[] = []
    const finish = (err?: Error, stopped?: ExecFullResult['stopped']) => {
      if (done) return
      done = true
      clearTimeout(timer)
      o.signal?.removeEventListener('abort', onAbort)
      // 超时 / 中止：先发 TERM（OpenSSH 支持时远端命令随之退出），再关通道。没有 pty 时光关通道远端命令可能继续跑
      if (stopped) { try { ch?.signal('TERM') } catch { /* 服务端不支持 */ } }
      try { ch?.close() } catch { /* 已关 */ }
      if (err) return reject(err)
      resolve({ code: stopped ? null : code, output: decodeText(Buffer.concat(chunks).subarray(0, max), o.encoding), truncated, ...(stopped ? { stopped } : {}) })
    }
    const onAbort = () => finish(undefined, 'aborted')
    const timer = setTimeout(() => finish(undefined, 'timeout'), o.timeoutMs)
    if (o.signal?.aborted) return onAbort()
    o.signal?.addEventListener('abort', onAbort)
    const take = (d: Buffer) => {
      if (size >= max) { truncated = true; return }
      chunks.push(d); size += d.length
      if (size > max) truncated = true
    }
    try {
      client.exec(command, (err, channel) => {
        if (err) return finish(err)
        if (done) { try { channel.close() } catch { /* 已关 */ } return }   // 超时 / 中止后才开出来的直接关
        ch = channel
        channel.on('data', take)
        channel.stderr?.on('data', take)
        channel.on('exit', (c: unknown) => { code = typeof c === 'number' ? c : null })
        channel.on('close', () => finish())
        if (o.stdin !== undefined) channel.end(o.stdin)
      })
    } catch (e) { finish(e as Error) }   // 连接已断时 ssh2 可能同步抛
  })
}

// 在给定连接上开独立 exec channel 跑一条命令取 stdout（execRead 与建连时的 tmux 探测共用）
function execOn(client: Client, command: string, timeoutMs: number, maxBytes = 256 * 1024): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let ch: ClientChannel | undefined
    let done = false
    const finish = (err?: Error, out?: string) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { ch?.close() } catch { /* 已关 */ }
      if (err) reject(err); else resolve(out ?? '')
    }
    const timer = setTimeout(() => finish(new Error('exec_timeout')), timeoutMs)
    try {
      client.exec(command, (err, channel) => {
        if (err) return finish(err)
        if (done) { try { channel.close() } catch { /* 已关 */ } return }   // 超时后才开出来的 channel 直接关
        ch = channel
        const chunks: Buffer[] = []
        let size = 0
        channel.on('data', (d: Buffer) => { if (size < maxBytes) { chunks.push(d); size += d.length } })
        channel.stderr?.on('data', () => { /* 丢弃，但要读走，否则窗口满会卡住 */ })
        channel.on('close', () => finish(undefined, Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8')))
      })
    } catch (e) { finish(e as Error) }   // 连接已断时 ssh2 可能同步抛
  })
}

// 测试连接：只验证能否连上（认证 + 握手，含跳板链路），不开 shell channel。成功 resolve，失败 reject 归一错误。
export async function testSshConnection(opts: SshConnectOpts): Promise<void> {
  const conn = await connectSsh({ ...opts, readyTimeoutMs: opts.readyTimeoutMs ?? 15000 })
  conn.close()
}
