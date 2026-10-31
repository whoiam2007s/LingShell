import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { isLegacyEncoding, isShellId, shellKind, shellLabel, wslDistro, wslToWinPath, osFromPlatform, osFromUname, tr, parseTmuxJobs, parseTmuxSessions, tmuxKillCommand, tmuxPanesCommand, tmuxPwdCommand, TMUX_LIST_COMMAND, TMUX_PREFIX, type TerminalInfo, type SshConnectOpts, type TermOs, type TmuxSessionInfo } from '@lingshell/shared'
import { LocalTerminal } from './LocalTerminal.js'
import { SshTerminal, type ExecFullOpts, type ExecFullResult, type ExecStreamHandlers } from './SshTerminal.js'
import type { Terminal, DataHandler, WriteOpts } from './Terminal.js'
import type { SentinelResult } from './sentinel.js'
import { PROMPT_NEWLINE_SETUP } from './promptNewline.js'


// ssh：建连参数（含跳板/编码/标题），供「复制会话」原样再开一个；persist：要求保持会话（复制时也用新 tmux 会话）
interface Entry { term: Terminal; info: TerminalInfo; ssh?: SshConnectOpts & { title?: string }; persist?: boolean }

// 新的 tmux 会话名：lingshell-<8 位 hex>（格式见 shared/terminal/tmux.ts）
export const newTmuxSessionName = (): string => `${TMUX_PREFIX}${randomBytes(4).toString('hex')}`

// MSYS/Git-Bash 路径 → Windows 路径：/c/Users/x → C:\Users\x。非 MSYS 挂载形式(如已是 C:\... 或普通 /foo)原样返回。
export function toWinPath(p: string): string {
  const m = /^\/([A-Za-z])\/(.*)$/.exec(p)   // /c/rest
  if (m) return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`
  if (/^\/([A-Za-z])$/.test(p)) return `${p[1].toUpperCase()}:\\`   // 恰好在盘根 /c
  return p
}

export type LockedEmit = (terminalId: string, locked: boolean) => void
export type StatusEmit = (terminalId: string, status: 'running' | 'disconnected', reason?: string, os?: TermOs) => void
export type CommandEmit = (command: string, terminalId: string, source: 'user' | 'ai') => void

export class TerminalManager {
  private entries = new Map<string, Entry>()
  private cwd = new Map<string, string>()   // 终端当前工作目录：创建时按 home 初始化，随用户/AI 的 cd 命令更新（不主动发 pwd 探测）
  constructor(private opts?: { emit?: LockedEmit; statusEmit?: StatusEmit; commandEmit?: CommandEmit }) {}

  // 终端 id：term_ + 4 位随机 hex。不复用（避免重启后 term_1 复用导致的授权/引用混淆），
  // 短随机而非 uuid：AI 经 list_terminals 引用它，短 id 省 prompt 字符、好读。碰撞则重生成（4位仅65536种）。
  private newId(): string {
    let id: string
    do { id = `term_${randomBytes(2).toString('hex')}` } while (this.entries.has(id))
    return id
  }

  // 本地终端编号：同前缀（本地 / PowerShell / cmd / 发行版名）存活终端中未占用的最小正整数（关掉的编号会回收，不像 seq 一直累加）。
  private nextLocalNo(prefix = tr('本地')): number {
    const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (\\d+)$`)
    const used = new Set([...this.entries.values()]
      .filter((e) => e.info.type === 'local')
      .map((e) => Number(re.exec(e.info.title)?.[1]))
      .filter((n) => Number.isFinite(n)))
    let n = 1
    while (used.has(n)) n++
    return n
  }

  // SSH 标题去重：base 已被占用时加数字后缀（"腾讯云PW" → "腾讯云PW 2" → "腾讯云PW 3"）。
  private uniqueSshTitle(base: string): string {
    const titles = new Set([...this.entries.values()].filter((e) => e.info.type === 'ssh').map((e) => e.info.title))
    if (!titles.has(base)) return base
    let n = 2
    while (titles.has(`${base} ${n}`)) n++
    return `${base} ${n}`
  }

  // shell：非默认 shell（见 shared/terminal/localShell.ts，仅 Windows）。PowerShell / cmd 标仅手动；
  // WSL 先按仅手动登记，后台等它出提示符后静默试一次哨兵，通过才放开给 AI（调用方 await ready(id) 拿最终信息）
  createLocal(opts?: { cwd?: string; shell?: string }): TerminalInfo {
    let shell = opts?.shell && opts.shell !== 'bash' ? opts.shell : undefined
    if (shell !== undefined && !isShellId(shell)) throw new Error(`invalid_shell: ${tr('不认识的 shell')}`)
    if (shell && process.platform !== 'win32') shell = undefined   // 其它系统只有默认 shell
    const id = this.newId()
    const term = new LocalTerminal(id, { cwd: opts?.cwd, shell })
    const kind = shellKind(shell)
    const prefix = kind === 'bash' ? tr('本地') : kind === 'wsl' ? wslDistro(shell)! : shellLabel(shell)
    const info: TerminalInfo = {
      id, title: `${prefix} ${this.nextLocalNo(prefix)}`, type: 'local', status: 'running', locked: false,
      os: kind === 'wsl' ? 'linux' : osFromPlatform(process.platform), ...(shell ? { shell, manualOnly: true } : {}),
    }
    this.wireExit(id, term)
    this.wireCommand(id, term)
    this.entries.set(id, { term, info })
    this.cwd.set(id, opts?.cwd ?? homedir())   // 本地终端初始 cwd = home（或指定 cwd），后续随 cd 命令更新
    if (kind === 'wsl') this.readyP.set(id, this.probeWsl(id, term))
    return info
  }

  // 建好后的最终信息（WSL 要等哨兵探测完）；其它终端立即返回
  private readyP = new Map<string, Promise<void>>()
  async ready(id: string): Promise<TerminalInfo> {
    await this.readyP.get(id)
    return { ...this.get(id).info }
  }

  // WSL：等首屏输出（冷启动可能好几秒）安静下来再发探测，否则探测命令会混进登录横幅、提示符被吞。
  // 探测 = 提示符设置 + uname（同 SSH 的 primePrompt）：出 Linux 说明哨兵在这个 shell 里跑得通 → 允许 AI；fish 等跑不通就保持仅手动
  private async probeWsl(id: string, term: Terminal, firstMs = 20000, quietMs = 400): Promise<void> {
    const e = this.entries.get(id)!
    e.info.locked = true   // 探测期间别让 AI / pwd 探测撞上（不发锁事件：界面这时还没拿到这个终端）
    try {
      await new Promise<void>((resolve) => {
        let quiet: NodeJS.Timeout | undefined
        const done = () => { clearTimeout(quiet); clearTimeout(cap); off(); offExit(); resolve() }
        const cap = setTimeout(done, firstMs)
        const off = term.onData(() => { clearTimeout(quiet); quiet = setTimeout(done, quietMs) })
        const offExit = term.onExit(done)
      })
      if (e.info.status !== 'running') return
      if (await this.primePrompt(term, 15000) === 'linux') delete e.info.manualOnly
    } finally {
      e.info.locked = false
      this.readyP.delete(id)
    }
  }

  // tmux：保持会话的会话名（有则接回 / 没有则新建；服务器没 tmux 时退回普通 shell，info.notice 说明）
  async createSsh(opts: SshConnectOpts & { title?: string; tmux?: string }): Promise<TerminalInfo> {
    const { tmux, ...conn } = opts
    const id = this.newId()
    const term = await SshTerminal.connect(id, conn, tmux)   // 连接失败抛错，不注册
    const detail = `${conn.username}@${conn.host}:${conn.port}`
    const info: TerminalInfo = {
      id, title: this.uniqueSshTitle(conn.title || detail), detail, type: 'ssh', status: 'running', locked: false,
      ...(isLegacyEncoding(conn.encoding) ? { encoding: conn.encoding } : {}),
    }
    if (term.notice) info.notice = term.notice
    this.wireExit(id, term)
    this.wireCommand(id, term)
    this.entries.set(id, { term, info, ssh: conn, persist: !!tmux })
    // SSH 登录默认在用户 home：root → /root，其它 → /home/<user>。后续随 cd 命令更新。
    this.cwd.set(id, conn.username === 'root' ? '/root' : `/home/${conn.username}`)
    info.os = await this.afterConnect(id, term)
    return info
  }

  // 建连/重连后：tmux 里提示符设置已在建会话时打进去（接回的会话里可能正跑着任务，不能再往里打字），系统用探测结果；
  // 普通 shell 照旧静默设置 + 探测。之后再发主机的登录命令（不经 AI，用户可见）
  private async afterConnect(id: string, term: Terminal): Promise<TermOs> {
    const e = this.entries.get(id)
    const t = term instanceof SshTerminal ? term.tmuxState : undefined
    if (e) { if (t?.active) e.info.tmux = (term as SshTerminal).tmuxName; else delete e.info.tmux }
    const os = t?.active ? t.os : await this.primePrompt(term)
    if (term instanceof SshTerminal) term.runLoginCommands()
    return os
  }

  // 复制会话：SSH 用同一份建连参数（同主机/跳板/编码，标题自动加序号）；本地在同一 cwd 开新 shell
  async duplicate(id: string): Promise<TerminalInfo> {
    const e = this.get(id)
    if (e.ssh) return this.createSsh(e.persist ? { ...e.ssh, tmux: newTmuxSessionName() } : e.ssh)
    // WSL 的 cwd 可能是 \\wsl.localhost\… 这种 pty 起不了的目录：从家目录开。
    // 不等 ready：调用方拿到后才订阅输出，等探测完首屏就丢了（返回的 manualOnly 可能偏保守，AI 侧以 list() 实时为准）
    const shell = e.info.shell
    const cwd = shellKind(shell) === 'wsl' ? undefined : (await this.pwd(id)) || undefined
    return this.createLocal({ cwd, shell })
  }

  // SSH：远端一般不收我们的环境变量，连上后静默发一条设置让提示符总另起一行（见 promptNewline.ts）。
  // 等它做完再返回：否则 AI 刚建完终端就 exec 会撞上 terminal_busy。非 bash / 超时都只是没这个效果，不影响使用。
  // 同一条里顺带 uname -s 探测系统（不多一次往返）；失败/超时 → unknown
  private async primePrompt(term: Terminal, timeoutMs = 8000): Promise<TermOs> {
    try { return osFromUname((await term.execCapture(`${PROMPT_NEWLINE_SETUP}; uname -s`, timeoutMs, undefined, { silent: true })).output) } catch { return 'unknown' }
  }

  // 终端退出（断线/进程结束）→ 标记 disconnected + 发事件
  private wireExit(id: string, term: Terminal): void {
    term.onExit((e) => {
      const entry = this.entries.get(id)
      if (entry) entry.info.status = 'disconnected'
      this.opts?.statusEmit?.(id, 'disconnected', e.reason)
    })
  }

  // 命令历史：终端内命令（用户手敲或 AI execCapture）上抛给上层（主进程存历史）。
  // 顺带记下 shell integration 每个提示符报的当前目录（OSC 633;P;Cwd，见 promptNewline.ts）：不用往终端里打 pwd 也知道目录
  private wireCommand(id: string, term: Terminal): void {
    term.onCommand((command, source) => this.opts?.commandEmit?.(command, id, source))
    term.onData((d) => {
      if (!d.includes(']633;P;Cwd=')) return
      // eslint-disable-next-line no-control-regex -- OSC 633 序列以 BEL 结尾
      const all = [...d.matchAll(/\x1b\]633;P;Cwd=([^\x07\x1b]*)\x07/g)]
      if (all.length) this.oscCwd.set(id, all[all.length - 1][1])
    })
  }
  private oscCwd = new Map<string, string>()
  /** 最近已知的当前目录：提示符上报的优先，否则用创建时 / 上次 pwd 的缓存；不触发探测。给 AI 终端清单用 */
  cachedCwd(id: string): string | undefined { return this.knownCwd(id) ?? this.cwd.get(id) }

  /** shell 最近一次提示符报的当前目录（本地已转成 Windows 路径）；没有 shell integration / 还没出过提示符 → undefined */
  knownCwd(id: string): string | undefined {
    const c = this.oscCwd.get(id), e = this.entries.get(id)
    if (!c || !e) return undefined
    if (e.info.type !== 'local') return c
    const distro = wslDistro(e.info.shell)
    if (distro) return wslToWinPath(c, distro)
    const w = toWinPath(c)
    return /^[A-Za-z]:/.test(w) ? w : undefined   // Git Bash 的 /tmp、/usr 这类挂载点换不成 Windows 路径：当不知道
  }

  write(id: string, data: string, opts?: WriteOpts): void {
    const e = this.get(id)
    if (e.info.status === 'disconnected') throw new Error('terminal_disconnected')
    if (e.info.locked) throw new Error('terminal_locked')
    e.term.write(data, opts)
  }

  // AI 正在该终端 execCapture（或静默探测）中：自动应答据此不触发
  isLocked(id: string): boolean { return this.entries.get(id)?.info.locked ?? false }

  interrupt(id: string): void {
    const e = this.get(id)
    if (e.info.status === 'disconnected') return   // 断线终端不能写（避免 write after end）
    e.term.write('\x03')
  }

  // 前端 xterm fit 后同步 PTY 尺寸，否则远端 shell 一直按 80 列折行，vim/top/less 错乱
  resize(id: string, cols: number, rows: number): void {
    const e = this.get(id)
    if (e.info.status === 'disconnected' || cols < 2 || rows < 2) return
    e.term.resize(Math.floor(cols), Math.floor(rows))
  }

  // SSH 终端原地重连：复用同 id/同实例重建连接，成功后 status 回 running。
  // 本地终端不支持（pty 断了即进程没了，语义不同）。
  // 自动重连与手动点重连可能撞车：同一终端进行中的重连复用同一个 promise；已在线则不动
  private reconnecting = new Map<string, Promise<void>>()
  async reconnect(id: string): Promise<void> {
    const e = this.get(id)
    if (e.info.type !== 'ssh') throw new Error('reconnect_not_supported')
    const term = e.term
    if (!(term instanceof SshTerminal)) throw new Error('reconnect_not_supported')
    if (e.info.status === 'running') return
    const pending = this.reconnecting.get(id)
    if (pending) return pending
    const p = (async () => {
      await term.reconnect()                       // 失败抛归一错误，status 保持 disconnected
      if (!this.entries.has(id)) { term.kill(); return }   // 重连期间标签被关了：断掉刚建的连接，不再报 running
      term.resetExitGuard()                        // 复用实例：重置一次性 exit 守卫
      // 先记 running 再 afterConnect：探测期间若又掉线，wireExit 会把状态改回 disconnected，
      // 这里就不能再无条件报 running（否则横幅被收起，实际连不上）
      e.info.status = 'running'
      e.info.os = await this.afterConnect(id, term)   // 重连是新 shell，设置要重做（系统也重测）；tmux 接回原会话则不用
      if (e.info.status !== 'running') return
      this.opts?.statusEmit?.(id, 'running', undefined, e.info.os)
    })().finally(() => this.reconnecting.delete(id))
    this.reconnecting.set(id, p)
    return p
  }

  onData(id: string, h: DataHandler): () => void { return this.get(id).term.onData(h) }
  list(): TerminalInfo[] { return [...this.entries.values()].map((e) => ({ ...e.info })) }

  readSnapshot(id: string, lines?: number): string { return this.get(id).term.readSnapshot(lines) }

  // 取某 SSH 终端的 sftp 会话（本地终端无 → 抛错）。资源树/下载用。
  async sftp(id: string): Promise<import('ssh2').SFTPWrapper> {
    const e = this.get(id)
    if (!(e.term instanceof SshTerminal)) throw new Error('not_ssh_terminal')
    return e.term.sftp()
  }

  // SSH 终端：独立 exec channel 跑只读命令取 stdout（主机状态采集）。不看 locked——不碰交互 shell，AI 执行中也可以采
  async execRead(id: string, command: string, timeoutMs: number): Promise<string> {
    const e = this.get(id)
    if (!(e.term instanceof SshTerminal)) throw new Error('not_ssh_terminal')
    if (e.info.status === 'disconnected') throw new Error('terminal_disconnected')
    return e.term.execRead(command, timeoutMs)
  }

  // SSH 终端的建连参数（含跳板 / 凭据，只在主进程内用）：临时端口转发另开连接用
  sshOpts(id: string): SshConnectOpts {
    const e = this.get(id)
    if (!(e.term instanceof SshTerminal)) throw new Error('not_ssh_terminal')
    return e.term.connectOpts
  }

  // 批量执行：同 execRead 不碰交互 shell，带退出码与 stderr
  async execFull(id: string, command: string, o: Omit<ExecFullOpts, 'encoding'>): Promise<ExecFullResult> {
    const e = this.get(id)
    if (!(e.term instanceof SshTerminal)) throw new Error('not_ssh_terminal')
    if (e.info.status === 'disconnected') throw new Error('terminal_disconnected')
    return e.term.exec(command, o)
  }

  // 日志实时查看：独立 exec channel 流式输出，返回关闭函数（见 SshTerminal.execStream）
  execStream(id: string, command: string, h: ExecStreamHandlers): () => void {
    const e = this.get(id)
    if (!(e.term instanceof SshTerminal)) throw new Error('not_ssh_terminal')
    if (e.info.status === 'disconnected') throw new Error('terminal_disconnected')
    return e.term.execStream(command, h)
  }

  // opts.wire：实际发进 shell 的命令（含密钥明文），command 是占位符原文（回显 / 历史用）；opts.silent：不回显、不记历史（AI 后台任务的退路）
  async execCapture(id: string, command: string, signal?: AbortSignal, timeoutMs?: number, opts?: { wire?: string; silent?: boolean }): Promise<SentinelResult> {
    const e = this.get(id)
    if (e.info.manualOnly) throw new Error(`shell_not_supported: ${tr('{shell} 终端是仅手动终端，AI 不能在里面执行命令（命令捕获依赖 bash）', { shell: shellLabel(e.info.shell) })}`)
    if (e.info.status === 'disconnected') throw new Error('terminal_disconnected')
    if (e.info.locked) throw new Error('terminal_busy')
    e.info.locked = true
    this.opts?.emit?.(id, true)
    try {
      const o = { ...(opts?.wire !== undefined ? { wire: opts.wire } : {}), ...(opts?.silent ? { silent: true } : {}) }
      return await e.term.execCapture(command, timeoutMs, signal, Object.keys(o).length ? o : undefined)
    } finally {
      e.info.locked = false
      this.opts?.emit?.(id, false)
    }
  }

  // 取终端当前工作目录（供资源管理器定位）。终端【空闲】时发一次 silent pwd（不回显、不记历史）拿 shell 真实 cwd，
  // 【忙时】（execCapture 中 / 有半行输入 / 断线）不发探测命令，回退上次缓存 —— 不干扰正在执行或输入的内容。
  // tab 补全/方向键编辑不影响（直接问 shell 真实值，不靠解析输入猜）。本地终端多为 Git Bash，pwd 返 MSYS 路径需归一为 Windows。
  async pwd(id: string): Promise<string> {
    const e = this.entries.get(id)
    if (!e) return ''
    if (e.term.busy || e.info.locked || e.info.status === 'disconnected' || e.info.manualOnly) return this.cwd.get(id) ?? ''   // 忙 / 非 bash（发不了探测）→ 用缓存
    // tmux：问 tmux 当前窗格目录（走 exec channel）。接回的会话里可能正跑着任务，往 shell 里打 pwd 会喂给它
    if (e.info.tmux && e.term instanceof SshTerminal) {
      const p = (await e.term.execRead(tmuxPwdCommand(e.info.tmux), 5000).catch(() => '')).trim()
      if (p.startsWith('/')) this.cwd.set(id, p)
      return this.cwd.get(id) ?? ''
    }
    // Windows 本地 Git Bash：每个提示符都报目录（OSC 633），直接用，不往终端里打 pwd——ConPTY 整屏重画时打过的探测命令会露出来
    if (e.info.type === 'local' && process.platform === 'win32' && shellKind(e.info.shell) === 'bash') {
      const k = this.knownCwd(id)
      if (k) this.cwd.set(id, k)
      return this.cwd.get(id) ?? ''
    }
    // 探测期间同样上锁：否则 AI exec 看到未锁、却被 BaseTerminal 以 terminal_busy 拒。
    // 不 emit 锁事件——探测是毫秒级的静默操作，避免 UI 锁标志闪烁
    e.info.locked = true
    try {
      const r = await e.term.execCapture('pwd', 8000, undefined, { silent: true })
      const line = r.output.trim().split(/\r?\n/).pop()?.trim() ?? ''
      if (!(line.startsWith('/') || /^[A-Za-z]:/.test(line))) return this.cwd.get(id) ?? ''   // 结果不像绝对路径 → 缓存
      // 本地 MSYS→Windows 归一（WSL：/mnt/c → C:\，其余走 \\wsl.localhost\<发行版>）；SSH 原样
      const distro = wslDistro(e.info.shell)
      const cwd = e.info.type !== 'local' ? line : distro ? wslToWinPath(line, distro) : toWinPath(line)
      this.cwd.set(id, cwd)   // 缓存成功结果，供忙时回退
      return cwd
    } catch { return this.cwd.get(id) ?? '' }   // 探测失败（如终端刚断）→ 缓存
    finally { e.info.locked = false }
  }

  // tmux 终端关闭：kill = 先结束远端会话 / keep = 留在服务器（以后可接回）/ idle（缺省）= 没有任务在跑才结束。
  // 断线中的终端结束不了远端会话，只能留着。返回的 promise 在远端处理完、连接断开后 resolve
  async close(id: string, tmux: 'kill' | 'keep' | 'idle' = 'idle'): Promise<void> {
    const e = this.entries.get(id)
    if (!e) return
    this.entries.delete(id)
    this.cwd.delete(id)
    this.oscCwd.delete(id)
    const name = e.info.tmux
    if (name && tmux !== 'keep' && e.info.status === 'running' && e.term instanceof SshTerminal) {
      const t = e.term
      try {
        if (tmux === 'kill' || !parseTmuxJobs(await t.execRead(tmuxPanesCommand(name), 5000)).length) await t.execRead(tmuxKillCommand(name), 5000)
      } catch { /* 远端没响应：会话留在服务器 */ }
    }
    e.term.kill()
  }

  // tmux 会话里正在跑的非 shell 命令（关标签前确认）。非 tmux / 断线 → []；查询失败 → null（不确定，别当成没任务）
  async tmuxJobs(id: string): Promise<string[] | null> {
    const e = this.entries.get(id)
    if (!e?.info.tmux || e.info.status !== 'running' || !(e.term instanceof SshTerminal)) return []
    try { return parseTmuxJobs(await e.term.execRead(tmuxPanesCommand(e.info.tmux), 5000)) } catch { return null }
  }

  // 该终端所在主机上保留着的 lingshell- 会话，去掉本应用当前已打开的
  async tmuxSessions(id: string): Promise<TmuxSessionInfo[]> {
    const e = this.get(id)
    if (!(e.term instanceof SshTerminal) || e.info.status !== 'running') return []
    const open = new Set([...this.entries.values()].map((x) => x.info.tmux).filter(Boolean))
    return parseTmuxSessions(await e.term.execRead(TMUX_LIST_COMMAND, 5000)).filter((s) => !open.has(s.name))
  }

  private get(id: string): Entry {
    const e = this.entries.get(id)
    if (!e) throw new Error('terminal_not_found')
    return e
  }
}
