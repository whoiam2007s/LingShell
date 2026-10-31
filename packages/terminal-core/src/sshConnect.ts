import { createHash } from 'node:crypto'
import { Client, type CompressionAlgorithm, type ConnectConfig, type ServerHostKeyAlgorithm } from 'ssh2'
import { tr, type SshConnectOpts, type HostKeyInfo, type SshAuthPromptInfo } from '@lingshell/shared'
import { connectViaProxy } from './proxyConnect.js'
import { spawnProxyCommand, expandProxyCommand, type ProxyCommandSock } from './proxyCommand.js'

// 一条就绪的 SSH 连接（可能经跳板机）。close() 同时断目标与所有跳板。
export interface SshConn { client: Client; close(): void }

// 连接期额外参数（如 SSH 心跳），同时作用于跳板与目标。
export type SshConnectExtra = Pick<ConnectConfig, 'keepaliveInterval' | 'keepaliveCountMax'>

const hopName = (o: SshConnectOpts) => o.label || `${o.username}@${o.host}:${o.port}`

// ── 主机指纹校验（TOFU，同 OpenSSH）────────────────────
// 主进程启动时 setHostKeyPolicy 注入（记录读写 + 首连确认）。未注入 = 无记录也无人确认 → 一律 host_key_unknown（失败即关闭）。
export interface HostKeyPolicy {
  lookup(hostPort: string): { keyType: string; fingerprint: string } | undefined
  remember(hostPort: string, keyType: string, fingerprint: string): void
  prompt?(info: HostKeyInfo): Promise<boolean>   // 首次见到 → 问用户；缺省（无 UI）= 拒绝
  onMismatch?(info: HostKeyInfo): void           // 指纹不符（连接已拒）→ 通知 UI 告警
}
let policy: HostKeyPolicy | undefined
export function setHostKeyPolicy(p: HostKeyPolicy | undefined): void { policy = p }

export const hostPortOf = (host: string, port: number) => `${host.trim().toLowerCase()}:${port}`
// OpenSSH 风格：SHA256 + base64 去尾部 '='（对服务器公钥原始 blob 求）
export const sshFingerprint = (keyBlob: Buffer) => 'SHA256:' + createHash('sha256').update(keyBlob).digest('base64').replace(/=+$/, '')
// 公钥 blob 开头是 uint32 长度 + 类型名（ssh-ed25519 / ssh-rsa / ecdsa-sha2-nistp256 ...）
export const keyTypeOf = (keyBlob: Buffer) => {
  try { return keyBlob.subarray(4, 4 + keyBlob.readUInt32BE(0)).toString('ascii') } catch { return 'unknown' }
}
// 已知主机：优先协商记录里的钥匙类型（同 OpenSSH），否则服务器多钥时可能给另一把 → 误报不符
const ALGS_OF: Record<string, ServerHostKeyAlgorithm[]> = {
  'ssh-rsa': ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'],
  'ssh-ed25519': ['ssh-ed25519'],
  'ecdsa-sha2-nistp256': ['ecdsa-sha2-nistp256'],
  'ecdsa-sha2-nistp384': ['ecdsa-sha2-nistp384'],
  'ecdsa-sha2-nistp521': ['ecdsa-sha2-nistp521'],
}

// 开压缩：优先 zlib，服务器不支持时回落 none（不因此连不上）
const COMPRESS: CompressionAlgorithm[] = ['zlib@openssh.com', 'zlib', 'none']

// ssh2 1.16 缺陷：开压缩时连接断开后 zlib 已释放，还开着的 channel 随后（下一 tick）收尾发 CHANNEL_CLOSE 会同步抛
// 'Invalid Zlib instance'（未捕获异常，主进程弹错）。在底层 socket 的 end/close 上（排在 ssh2 自己的处理之后、channel 收尾之前）
// 把写出口换成直通：连接已断、加密器已作废，包不会真发出去。挂在 socket 上而非 client 上：重连时会 removeAllListeners 旧 client
type ClientInternals = { _sock?: NodeJS.EventEmitter; _protocol?: { _packetRW?: { write?: { finalize(b: Buffer): Buffer } } } }
function guardZlibAfterClose(client: Client): void {
  const c = client as unknown as ClientInternals
  const off = () => { const w = c._protocol?._packetRW?.write; if (w) w.finalize = (b) => b }
  c._sock?.once('end', off)
  c._sock?.once('close', off)
}

// 同一主机同一指纹的并发首连（如启动恢复多个同主机终端）只问一次
const asking = new Map<string, Promise<boolean>>()
const askOnce = (info: HostKeyInfo, prompt: NonNullable<HostKeyPolicy['prompt']>) => {
  const k = `${info.hostPort} ${info.fingerprint}`
  let p = asking.get(k)
  if (!p) {
    p = prompt(info).catch(() => false).finally(() => asking.delete(k))
    asking.set(k, p)
  }
  return p
}

// ── keyboard-interactive（二次验证 / OTP / 堡垒机提示）────
// 主进程注入：把服务器的提示推给 UI，返回用户填的回答；null = 取消/超时。未注入（无 UI）= 不能应答
export type SshAuthPrompter = (info: SshAuthPromptInfo, signal: AbortSignal) => Promise<string[] | null>
let authPrompter: SshAuthPrompter | undefined
export function setSshAuthPrompter(p: SshAuthPrompter | undefined): void { authPrompter = p }

// 「Password:」类提示（不回显、提到密码、不像验证码/改密）→ 可用已存密码自动回答
export const isPasswordPrompt = (p: { prompt: string; echo?: boolean }) =>
  !p.echo && /pass(word)?\b|密码|口令/i.test(p.prompt) && !/passcode|otp|one[- ]?time|verif|token|code|验证|动态|new|新|again|确认|retype/i.test(p.prompt)

class HostKeyUnknown extends Error { constructor(msg: string, public info: HostKeyInfo) { super(msg) } }

// 所有 SSH 连接（终端/测试/SFTP 传输/目录浏览/端口转发）的唯一入口。
// 有 opts.jump：先递归连跳板 → forwardOut 到目标 host:port → 目标 Client 以 sock 走这条隧道。
// 每一跳都校验主机指纹（先跳板后目标）：不符 → host_key_mismatch；首次见到 → 问用户（opts.noHostKeyPrompt 或无 prompt → host_key_unknown）。
// 失败 reject 归一错误；链路中（有跳板）的错误带前缀标明哪一跳：「跳板机「X」: ssh_auth_failed」。
// 无跳板时错误码与原来完全一致（ssh_auth_failed 等）。
export function connectSsh(opts: SshConnectOpts, extra?: SshConnectExtra): Promise<SshConn> {
  return connectTrusted(opts, extra, undefined, !opts.noHostKeyPrompt)
}

// 首次见到的主机：这次握手先拒掉（不让连接挂着等用户：ssh2 readyTimeout / 服务器 LoginGraceTime 会先断），
// 用户确认信任 → 记住 → 重连一次（此时已是已知主机）。认证在指纹校验之后，拒掉时密码尚未发出。
async function connectTrusted(opts: SshConnectOpts, extra: SshConnectExtra | undefined, role: '跳板机' | undefined, ask: boolean): Promise<SshConn> {
  try { return await connectHop(opts, extra, role, ask) }
  catch (e) {
    if (!(e instanceof HostKeyUnknown)) throw e
    const prompt = ask ? policy?.prompt : undefined
    if (!prompt) throw new Error(e.message + tr('。先手动连接一次以确认指纹'))
    if (!(await askOnce(e.info, prompt))) throw new Error(e.message.replace('host_key_unknown', 'host_key_rejected') + tr('，已取消连接'))
    policy?.remember(e.info.hostPort, e.info.keyType, e.info.fingerprint)
    try { return await connectHop(opts, extra, role, ask) }
    catch (e2) { throw e2 instanceof HostKeyUnknown ? new Error(e2.message) : e2 }   // 记住后仍未知（存储失败）：不再问，直接失败
  }
}

async function connectHop(opts: SshConnectOpts, extra: SshConnectExtra | undefined, role: '跳板机' | undefined, ask: boolean): Promise<SshConn> {
  let jump: SshConn | undefined
  let sock: ConnectConfig['sock']
  let pc: ProxyCommandSock | undefined   // ProxyCommand 子进程：连接结束/失败时结束它
  if (opts.jump) {
    jump = await connectTrusted(opts.jump, extra, '跳板机', ask)   // 内层失败已带前缀   // i18n-ignore 跳板机 / 目标主机 是 SshAuthPromptInfo.role 的取值，前缀由 UI 按正则解析（SshConnectDialog.sshErrorText）
    const j = jump
    try {
      sock = await new Promise((resolve, reject) =>
        j.client.forwardOut('127.0.0.1', 0, opts.host, opts.port, (err, stream) => err ? reject(err) : resolve(stream)))
    } catch (e) {
      j.close()
      throw new Error(tr('跳板机「{name}」无法转发到 {target}: {error}', { name: hopName(opts.jump), target: `${opts.host}:${opts.port}`, error: errText(e) }))
    }
  } else if (opts.proxyCommand) {
    // 本地代理命令：子进程 stdin/stdout 即连接（与跳板/出站代理互斥，HostStore 保存时已校验）
    pc = spawnProxyCommand(expandProxyCommand(opts.proxyCommand, opts.host, opts.port, opts.username))
    sock = pc.sock
  } else if (opts.proxy) {
    // 出站代理：只作用于直接建 TCP 的这一跳（经跳板时目标走跳板隧道，代理看跳板自己的配置）
    try { sock = await connectViaProxy(opts.proxy, opts.host, opts.port, opts.readyTimeoutMs ?? 20000) }
    catch (e) { throw new Error((role ? `${role}「${hopName(opts)}」: ` : '') + errText(e)) }   // i18n-ignore 跳板机 / 目标主机 是 SshAuthPromptInfo.role 的取值，前缀由 UI 按正则解析（SshConnectDialog.sshErrorText）
  }
  const hostPort = hostPortOf(opts.host, opts.port)
  const readyTimeout = opts.readyTimeoutMs ?? 20000
  const known = policy?.lookup(hostPort)
  const algs = known && ALGS_OF[known.keyType]
  let bad: HostKeyInfo | undefined   // 校验未通过的那把钥匙（有 expected = 不符，否则 = 未知）
  const client = new Client()
  let authTimer: NodeJS.Timeout | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      client.on('ready', () => { clearTimeout(authTimer); resolve() })
      // 连接期错误 → reject；之后的错误由调用方自挂监听处理（此监听保留，防未处理 error 崩进程）
      client.on('error', (err: Error) => { clearTimeout(authTimer); reject(mapSshError(err)) })
      // keyboard-interactive：「Password:」类提示用已存密码答一次（再问 = 密码不对，交给用户）；其余（OTP/堡垒机）弹框问用户
      let pwUsed = false
      const asking = new AbortController()   // 等用户输入时连接被服务器断开（LoginGraceTime）→ 让 UI 关掉弹窗
      client.on('close', () => { clearTimeout(authTimer); asking.abort(); reject(new Error(`ssh_error: ${tr('认证完成前连接被服务器关闭')}`)) })
      client.on('keyboard-interactive', (name, instructions, _lang, prompts, finish) => {
        if (opts.password !== undefined && !pwUsed && prompts.length && prompts.every(isPasswordPrompt)) {
          pwUsed = true
          finish(prompts.map(() => opts.password!))
          return
        }
        const fail = (msg: string) => { clearTimeout(authTimer); reject(new Error(msg)); try { client.end() } catch { /* 已关 */ } }
        const prompter = ask ? authPrompter : undefined
        if (!prompter) { fail(`ssh_auth_failed: ${((ps) => (ask ? tr('服务器要求二次验证（{prompts}），当前无界面可输入', { prompts: ps }) : tr('服务器要求二次验证（{prompts}），无人值守连接无法输入', { prompts: ps })))(prompts.map((p) => p.prompt.trim()).join(' / ') || 'keyboard-interactive')}`); return }
        // 等用户输入期间停掉 ssh2 的握手超时（内部计时器），答完再按同样时长兜底
        clearTimeout((client as unknown as { _readyTimeout?: NodeJS.Timeout })._readyTimeout)
        clearTimeout(authTimer)
        const info: SshAuthPromptInfo = { hostPort, label: hopName(opts), role: role ?? '目标主机', name, instructions, prompts: prompts.map((p) => ({ prompt: p.prompt, echo: !!p.echo })) }   // i18n-ignore 跳板机 / 目标主机 是 SshAuthPromptInfo.role 的取值，前缀由 UI 按正则解析（SshConnectDialog.sshErrorText）
        prompter(info, asking.signal).catch(() => null).then((answers) => {
          if (asking.signal.aborted) return
          if (!answers) { fail(`ssh_auth_cancelled: ${tr('已取消二次验证（或超时未输入）')}`); return }
          authTimer = setTimeout(() => fail('ssh_connect_timeout'), readyTimeout)
          try { finish(answers) } catch (e) { fail(`ssh_error: ${errText(e)}`) }
        })
      })
      client.connect({
        host: opts.host, port: opts.port, username: opts.username,
        password: opts.password, privateKey: opts.privateKey, passphrase: opts.passphrase,
        // 连接级不开 agentForward（否则每个 exec channel 都请求，且服务器拒绝时整个 channel 打不开）；
        // 主机开了转发时只在交互通道上按需请求（见 SshTerminal）
        agent: opts.agent,
        tryKeyboard: true,
        readyTimeout,
        sock, ...extra,
        // 主机自己配了心跳就用它（0 = 关），否则用调用方默认
        ...(opts.keepaliveSec !== undefined ? { keepaliveInterval: opts.keepaliveSec * 1000 } : {}),
        ...(algs || opts.compress ? { algorithms: {
          ...(algs ? { serverHostKey: { remove: algs, prepend: algs, append: [] } } : {}),   // 键序即执行序：先移除再前置
          ...(opts.compress ? { compress: COMPRESS } : {}),
        } } : {}),
        // 同步校验：返回 false → ssh2 断开握手并报 error（此时尚未认证）。重协商（rekey）也会再校验
        hostVerifier: (key: Buffer) => {
          const fingerprint = sshFingerprint(key)
          if (known && known.fingerprint === fingerprint) return true
          bad = { hostPort, label: hopName(opts), role: role ?? '目标主机', keyType: keyTypeOf(key), fingerprint, expected: known?.fingerprint }   // i18n-ignore 跳板机 / 目标主机 是 SshAuthPromptInfo.role 的取值，前缀由 UI 按正则解析（SshConnectDialog.sshErrorText）
          return false
        },
      })
      if (opts.compress) guardZlibAfterClose(client)   // connect() 里同步建好 socket
    })
  } catch (e) {
    try { client.end() } catch { /* 已关 */ }
    jump?.close()
    const msg = errText(e)
    // ProxyCommand 握手前就失败多半是命令本身出错（找不到程序 / 未登录 / 目标不可达）：带上它的错误输出
    const pcErr = pc && !bad && !/^ssh_(auth|invalid_key)/.test(msg) ? await proxyCommandError(pc) : ''
    pc?.kill()
    const prefix = role ? `${role}「${hopName(opts)}」: ` : jump ? `目标主机「${hopName(opts)}」: ` : ''   // i18n-ignore 跳板机 / 目标主机 是 SshAuthPromptInfo.role 的取值，前缀由 UI 按正则解析（SshConnectDialog.sshErrorText）
    if (bad?.expected) {
      policy?.onMismatch?.(bad)
      throw new Error(`${prefix}host_key_mismatch: ${tr('{host} 的主机指纹与记录不符，可能遭遇中间人攻击，已拒绝连接（已记录 {expected}，本次 {actual}）', { host: hostPort, expected: bad.expected, actual: `${bad.keyType} ${bad.fingerprint}` })}`)
    }
    if (bad) throw new HostKeyUnknown(`${prefix}host_key_unknown: ${tr('{host} 首次连接，主机指纹 {key} 未确认', { host: hostPort, key: `${bad.keyType} ${bad.fingerprint}` })}`, bad)
    // agent 认证失败多半是 agent 里没加载对的钥匙：补一句提示（保留错误码前缀，UI 按 includes 匹配）
    throw new Error(prefix + (opts.agent && msg === 'ssh_auth_failed' ? `${msg}: ${tr('ssh-agent 中没有被服务器接受的密钥（ssh-add -l 查看已加载的密钥）')}` : msg) + pcErr)
  }
  // 目标断开 → 顺手断跳板 / 结束代理命令，避免泄漏
  if (jump) { const j = jump; client.on('close', () => j.close()) }
  if (pc) { const p = pc; client.on('close', () => p.kill()) }
  return {
    client,
    close: () => { try { client.end() } catch { /* 已关 */ } jump?.close(); pc?.kill() },
  }
}

// 握手失败时代理命令的错误输出：子进程可能还在写，稍等它退出（最多 300ms）再取
async function proxyCommandError(pc: ProxyCommandSock): Promise<string> {
  for (let i = 0; i < 6 && !pc.exited(); i++) await new Promise((r) => setTimeout(r, 50))
  const e = pc.stderr()
  return e ? tr('（ProxyCommand 输出：{output}）', { output: e.slice(-500) }) : tr('（ProxyCommand 没有输出，请检查命令能否在本机命令行里运行）')
}

const errText = (e: unknown) => e instanceof Error ? e.message : String(e)

// ssh2 错误归一为我方稳定错误码。
export function mapSshError(err: Error): Error {
  const m = err.message.toLowerCase()
  // ssh2 与 agent 通信失败（连不上/取钥匙/签名）发 level='agent' 的 error
  if ((err as Error & { level?: string }).level === 'agent') return new Error(`ssh_agent_failed: ${tr('与 ssh-agent/Pageant 通信失败（{error}）', { error: err.message })}`)
  if (m.includes('authentication') || m.includes('all configured authentication')) return new Error('ssh_auth_failed')
  if (m.includes('timed out') || m.includes('timeout')) return new Error('ssh_connect_timeout')
  if (m.includes('econnrefused') || m.includes('ehostunreach') || m.includes('enotfound')) return new Error('ssh_unreachable')
  if (m.includes('key') || m.includes('passphrase')) return new Error('ssh_invalid_key')
  return new Error(`ssh_error: ${err.message}`)
}
