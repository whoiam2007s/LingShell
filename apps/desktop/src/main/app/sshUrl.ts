// ssh:// 链接唤起：注册为系统 ssh:// 协议的打开方式（仅打包版；开发版 electron 可执行文件不是本应用，注册了也打不开），
// 收到链接（启动参数 / 已运行时的 second-instance / macOS open-url）→ 只解析出 用户@主机:端口 → 交给 UI：
// 匹配已存主机 → 弹确认再连；不匹配 → 打开新建连接并预填（不自动连、不带密码）。系统设置「ssh:// 链接」可关（默认开）
import { app } from 'electron'
import { parseSshUrl, findSshUrlArg, type AppEvent, type SshUrlTarget } from '@lingshell/shared'
import { log } from '../core/index.js'

// 协议命令行：exe -- "%1"。「--」之后 Chromium 不再解析开关，链接再怎么构造也不会被当成启动参数
const ARGS = ['--']
let pending: SshUrlTarget | null = null
let deliver: ((t: SshUrlTarget) => void) | undefined

/** 收到一个可能的链接：合法就交给 UI（UI 还没就绪先存着，挂载后 takePending 取走） */
export function receiveSshUrl(raw: string | undefined): void {
  if (!raw) return
  const t = parseSshUrl(raw)
  if (!t) { log('warn', 'main', 'sshUrl', '忽略无法解析的 ssh:// 链接', { raw: raw.slice(0, 200) }); return }   // i18n-ignore 日志
  if (deliver) deliver(t); else pending = t
}
export const receiveSshUrlArgv = (argv: readonly string[]) => receiveSshUrl(findSshUrlArg(argv))

/** 进程启动早期调用（whenReady 之前）：启动参数里的链接 + macOS 的 open-url */
export function initSshUrl(): void {
  app.on('open-url', (e, url) => { e.preventDefault(); receiveSshUrl(url) })
  receiveSshUrlArgv(process.argv)
}

export interface SshUrlDeps {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  send(ev: AppEvent): void
  enabled(): boolean
}

/** 注册 IPC + 按设置注册/注销系统协议。返回 apply：系统设置保存后调用 */
export function registerSshUrl(d: SshUrlDeps): { apply(): void } {
  deliver = (t) => { if (d.enabled()) d.send({ type: 'sshUrl:open', target: t }) }
  d.handle('sshUrl:takePending', () => { const t = pending; pending = null; return t && d.enabled() ? t : null })
  const apply = () => {
    if (!app.isPackaged) return
    try {
      const on = app.isDefaultProtocolClient('ssh', process.execPath, ARGS)
      if (d.enabled() && !on) app.setAsDefaultProtocolClient('ssh', process.execPath, ARGS)
      else if (!d.enabled() && on) app.removeAsDefaultProtocolClient('ssh', process.execPath, ARGS)
    } catch (e) { log('warn', 'main', 'sshUrl', '注册 ssh:// 协议失败', { error: String(e) }) }   // i18n-ignore 日志
  }
  apply()
  return { apply }
}
