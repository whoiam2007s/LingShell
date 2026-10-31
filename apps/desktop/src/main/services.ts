// 主进程共享服务（从 ipc.ts 原样搬来，创建顺序不变）：存储、终端管理、录像 / 会话日志、密钥保险箱、授权、脱敏等。
// 多个领域都用到的才放这里；只有一个领域用的在那个领域的 register.ts 里创建。返回值即 MainContext（见 core/context.ts）
import { type BrowserWindow, app, ipcMain, clipboard, safeStorage } from 'electron'
import { type Encryptor, SettingsStore, CommandHistoryStore, AuditStore, HostStore, WebhookStore, AutoReplyStore, SessionStore,
  LayoutStore, McpStore, SecretStore } from '@lingshell/config'
import { join } from 'node:path'
import { TerminalManager, PortForwardManager, connectSsh, execFull } from '@lingshell/terminal-core'
import { DshController, McpManager, AUTO_COMPACT_CAP, unifiedDiff, wireOf } from '@lingshell/dsh-controller'
import { AuthRegistry, JsonAuthStore } from '@lingshell/auth-registry'
import { type AppEvent, type TerminalInfo, DEFAULT_SYSTEM_SETTINGS, redactAi, type SecretStreamMasker } from '@lingshell/shared'
import { createAuditHelpers, findLiveTerminal, initAppContext, log } from './core/index.js'
import { TransferService, fileHistory, type FileAccess, localAccess, sftpAccess } from './files/index.js'
import { setNotifyLockState, notifyIfUnfocused, userWatching, notify, AppLock, installLockGate, registerAppearance, shouldHideOnClose,
  beginQuit, cancelQuit } from './app/index.js'
import { TerminalRecorder, pruneRecordings, SessionLogger, pruneSessionLogs, AutoReplyEngine } from './terminal/index.js'
import { ProfileStore, hostRunner, registerHostDashboard } from './ops/index.js'
import { type SecretsService, registerSecrets } from './integrations/index.js'
import { summaryPathOf } from './ai/index.js'

// Electron safeStorage 实现的加密器（OS 密钥链：Windows DPAPI / macOS Keychain）
const electronEncryptor: Encryptor = {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
  decrypt: (cipher) => safeStorage.decryptString(Buffer.from(cipher, 'base64')),
}

export function createMainContext(win: BrowserWindow) {
  const { paths } = initAppContext()
  const sendTaps: ((ev: AppEvent) => void)[] = []   // 旁听发给界面的事件（手机访问用，见 mobileIpc.ts）
  let clearCardsOnTurnEnd: (sid: string) => void = () => {}
  const send = (ev: AppEvent) => {
    win.webContents.send('app:event', ev); for (const f of sendTaps) f(ev)
    if (ev.type === 'agent:turnCompleted' || ev.type === 'agent:turnFailed') clearCardsOnTurnEnd(ev.sessionId)
  }
  // 应用锁：门禁装在所有 handler 注册之前（默认拒绝，见 appLock.ts）。后台连接/AI/巡检照跑，只拦来自 UI 和 HTTP 接口的操作
  const appLock = new AppLock(join(paths.config, 'lock.json'), (locked) => {
    send({ type: 'app:lock', locked })
    if (locked && app.isPackaged) win.webContents.closeDevTools()
    log('info', 'main', 'lock', locked ? '应用已锁定' : '应用已解锁')   // i18n-ignore 日志
  })
  installLockGate(ipcMain, () => appLock.locked)
  setNotifyLockState(() => appLock.locked)
  const termHostKey = new Map<string, string>()   // terminalId → hostKey（local / hostId / host:port）
  // 巡检用的后台终端 → 所属会话。不进 UI 标签页，锁/状态事件也不发（否则 UI 会切到一个不存在的标签）
  const hiddenTerms = new Map<string, string>()
  // 设置存储：放 ~/.lingshell/config，key 经 safeStorage 加密
  const settings = new SettingsStore(paths.config, electronEncryptor)
  // 系统设置 getter：每次读最新 settings（非快照）。缺省回落 DEFAULT。
  const sys = () => ({ ...DEFAULT_SYSTEM_SETTINGS, ...(settings.get().system ?? {}) })
  registerAppearance(win, sys)   // 界面主题 / 缩放：窗口显示前先按已存设置应用（见 appearance.ts）
  const cmdHistory = new CommandHistoryStore(paths.config, () => sys().historyLimit)
  const auditStore = new AuditStore(paths.config)
  const terminals = new TerminalManager({
    emit: (terminalId, locked) => { if (!hiddenTerms.has(terminalId)) send({ type: 'terminal:locked', terminalId, locked }) },
    statusEmit: (terminalId, status, reason, os) => { if (!hiddenTerms.has(terminalId)) send({ type: 'terminal:status', terminalId, status, reason, os }) },
    commandEmit: (command, terminalId, source) => {
      const hostKey = termHostKey.get(terminalId) ?? 'local'
      const terminalTitle = terminals.list().find((t) => t.id === terminalId)?.title ?? terminalId
      cmdHistory.add(hostKey, { command, terminalId, terminalTitle, source })
    },
  })
  // 终端录像（见 recorder.ts）：系统设置里的开关只决定「允许录屏」，录不录由用户在终端上手动开始/停止。
  // 启动时按保留天数清旧目录
  const recorder = new TerminalRecorder(paths.recordings, (m, d) => log('warn', 'main', 'recording', m, d))
  const prunedRec = pruneRecordings(paths.recordings, sys().recordingRetentionDays, new Date())
  if (prunedRec.length) log('info', 'main', 'recording', `清理过期录像 ${prunedRec.length} 天`)   // i18n-ignore 日志
  const recUnsub = new Map<string, () => void>()                       // terminalId → 停止喂输出
  const recMask = new Map<string, SecretStreamMasker>()                // 录像输出里的密钥保险箱明文 → 占位符
  const termSize = new Map<string, { cols: number; rows: number }>()   // 中途开录时 header 用当前尺寸
  const stopRecording = async (id: string) => {
    const off = recUnsub.get(id)
    if (!off) return
    off(); recUnsub.delete(id)
    recorder.output(id, recMask.get(id)?.flush() ?? ''); recMask.delete(id)
    await recorder.stop(id)
    send({ type: 'terminal:recording', terminalId: id, recording: false })
  }
  // 会话日志（见 sessionLog.ts）：开关打开后用户可见的终端自动记纯文本；巡检后台终端不记。启动时 + 每天按保留天数清旧
  const sessionLogDir = () => sys().sessionLogDir || join(paths.logs, 'sessions')
  const sessionLog = new SessionLogger({ dir: sessionLogDir, timestamps: () => sys().sessionLogTimestamps, onError: (m, d) => log('warn', 'main', 'sessionLog', m, d), mask: (s) => vault.maskText(s) })
  const logUnsub = new Map<string, () => void>()
  const startLog = (t: Pick<TerminalInfo, 'id' | 'type' | 'title'>) => {
    if (!sys().sessionLog || logUnsub.has(t.id) || hiddenTerms.has(t.id)) return
    const sz = termSize.get(t.id)
    sessionLog.open(t.id, t.type === 'local' ? '本地' : t.title, sz?.cols, sz?.rows)   // i18n-ignore 会话日志文件名要稳定
    logUnsub.set(t.id, terminals.onData(t.id, (c) => sessionLog.data(t.id, c)))
  }
  const stopLog = (id: string) => { logUnsub.get(id)?.(); logUnsub.delete(id); return sessionLog.close(id) }
  const stopAllLogs = () => Promise.all([...logUnsub.keys()].map(stopLog))
  const pruneLogs = () => {
    const n = pruneSessionLogs(sessionLogDir(), sys().sessionLogRetentionDays, new Date())
    if (n.length) log('info', 'main', 'sessionLog', `清理过期会话日志 ${n.length} 天`)   // i18n-ignore 日志
  }
  pruneLogs()
  setInterval(pruneLogs, 86_400_000).unref()
  // 限速按每个任务（KB/s → 字节/秒）；已结束的任务存历史，重启后传输面板还能看到
  const transfer = new TransferService((ev) => send(ev), () => sys().transferConcurrency, () => Math.max(0, Number(sys().transferLimitKBps) || 0) * 1024, fileHistory(join(paths.root, 'transfer-history.json')))
  // 主机存储：SSH 主机信息（密码/私钥经 safeStorage 加密）放 ~/.lingshell/config
  const hostStore = new HostStore(paths.config, electronEncryptor)
  // 密钥保险箱（见 secretsIpc.ts）：AI 命令里的 {{secret:名称}} 发进终端前才展开；工具结果 / 会话日志 / 录像里的明文换回占位符
  let invalidateMobileSecrets = () => {}   // 手机页的红字缓存（registerMobile 在下面才创建）
  const secretStore = new SecretStore(paths.config, electronEncryptor)
  // 早期系统密钥链不可用时存下的明文值：现在能加密了就迁移，不再一直以明文留在 secrets.json
  try { const n = secretStore.migrate(); if (n) log('info', 'main', 'secrets', `已把 ${n} 个明文密钥迁移为加密存储`) } catch (e) { log('warn', 'main', 'secrets', `明文密钥迁移失败：${String(e)}`) }   // i18n-ignore 日志
  const vault: SecretsService = registerSecrets({
    handle: (ch, fn) => ipcMain.handle(ch, fn),
    store: secretStore,
    hostKeyOf: (tid) => (terminals.list().some((t) => t.id === tid) ? termHostKey.get(tid) ?? 'local' : undefined),
    hosts: () => hostStore.list(),
    clipboard,
    busy: (tid) => terminals.isLocked(tid),
    // 撰写栏：明文直接写进终端（noHistory：不进本应用的命令历史缓冲），历史 / 录像键入记占位符原文
    write: (tid, wire, shown) => {
      terminals.write(tid, wire, { noHistory: true })
      recorder.input(tid, shown)
      const hostKey = termHostKey.get(tid) ?? 'local'
      const terminalTitle = terminals.list().find((t) => t.id === tid)?.title ?? tid
      for (const line of shown.split('\r')) if (line.trim()) cmdHistory.add(hostKey, { command: line.trim(), terminalId: tid, terminalTitle, source: 'user' })
    },
    onChange: () => { aiSecretCache = undefined; invalidateMobileSecrets() },
  })
  // 巡检告警群机器人（URL/签名密钥经 safeStorage 加密）
  const webhookStore = new WebhookStore(paths.config, electronEncryptor)
  // 自动应答（见 autoReply.ts）：密钥应答经 safeStorage 加密；规则解密后缓存，增删改/导入后失效。
  // 只挂用户可见的终端（巡检后台终端不挂）；应答直接写终端（noHistory），不进命令历史、不进录像键入
  const autoReplyStore = new AutoReplyStore(paths.config, electronEncryptor)
  let autoReplyRules: ReturnType<AutoReplyStore['resolveAll']> | undefined
  const autoReply = new AutoReplyEngine({
    rules: () => (autoReplyRules ??= autoReplyStore.resolveAll()),
    hostKey: (tid) => termHostKey.get(tid) ?? 'local',
    isProd: (hk) => hostOf(hk)?.env === 'prod',
    aiBusy: (tid) => terminals.isLocked(tid),
    write: (tid, data) => terminals.write(tid, data, { noHistory: true }),
    notify: (terminalId, rule, disabled) => send({ type: 'terminal:autoReply', terminalId, rule, disabled }),
    log: (m, d) => log('info', 'main', 'autoReply', m, d),
  })
  const startAutoReply = (id: string) => {
    if (hiddenTerms.has(id)) return
    autoReply.attach(id)
    terminals.onData(id, (c) => autoReply.data(id, c))
  }
  // 会话元数据 + 终端布局持久化（非敏感，明文）放 ~/.lingshell/config
  const sessionStore = new SessionStore(paths.config)
  const layoutStore = new LayoutStore(paths.config)
  // 端口转发（仅用户手动，不给 AI）：断线重连等状态变化 → 通知 UI 刷新；已保存的转发存 port-forwards.json
  const forwards = new PortForwardManager((id) => send({ type: 'portForward:changed', id }))

  // ── 授权 + 引擎 ──────────────────────────────────────
  const auth = new AuthRegistry({ store: new JsonAuthStore(join(paths.config, 'auth.json')) })
  // 主机备注/分级：hostKey 是已保存主机 id 时才有；'local' 的备注在系统设置里；临时 SSH（host:port）没有
  const hostOf = (hostKey: string) => hostStore.list().find((h) => h.id === hostKey)
  // 执行记录 / 找在线终端的公共写法（见 core/audit.ts）：各领域不再各抄一遍
  const { auditRaw, auditTerminal, auditHost } = createAuditHelpers({
    add: (e) => auditStore.add(e),
    activeSessionId: () => layoutStore.get().activeSessionId ?? '',
    terminalTitle: (id) => terminals.list().find((t) => t.id === id)?.title,
    hostKeyOf: (id) => termHostKey.get(id),
    hostLabel: (hostKey) => hostOf(hostKey)?.label,
    logAudit: (label, data) => log('info', 'main', 'audit', label, data),
  })
  const liveTerminal = (hostKey: string, o: { running?: boolean; ssh?: boolean; includeHidden?: boolean } = {}) =>
    findLiveTerminal(hostKey, { ...o, terminals: () => terminals.list(), hostKeys: () => termHostKey, isHidden: (id) => hiddenTerms.has(id) })

  // 正在无人值守巡检的会话 → 允许操作的 hostKey（见 inspection.ts unattendedDecide）
  const unattended = new Map<string, Set<string>>()

  // 建终端后统一：接 onData 转发 + emit terminal:created（让 UI 加标签）
  const wireNewTerminal = (info: import('@lingshell/shared').TerminalInfo) => {
    terminals.onData(info.id, (chunk) => send({ type: 'terminal:data', terminalId: info.id, chunk }))
    send({ type: 'terminal:created', info })
    startLog(info)
    startAutoReply(info.id)
    return { terminalId: info.id, title: info.title }
  }

  // AI 文件工具：按终端所在主机取文件访问（本地 fs / 该 SSH 终端连接上复用的 SFTP 会话）。
  // 用终端自己的连接而不是 hostStore 新建：临时连接（未保存主机）的终端也能用，也不额外占 MaxSessions。
  const fileAccessOf = async (terminalId: string): Promise<FileAccess> => {
    const hostKey = termHostKey.get(terminalId)
    if (!hostKey) throw new Error(`terminal_not_found: ${terminalId}`)
    return hostKey === 'local' ? localAccess(paths.root) : sftpAccess(await terminals.sftp(terminalId), termEncoding(terminalId))
  }
  const termEncoding = (id: string) => terminals.list().find((t) => t.id === id)?.encoding

  // 外部 MCP 服务（监控/数据库/工单…）：应用启动就连，不等第一个会话；dsh 启动时把已连上的工具注册进去。
  // 一个服务连不上只标失败（设置页可见），不影响启动
  const mcpStore = new McpStore(paths.config, electronEncryptor)

  // 已知机密明文（诊断包抹日志 / 发给 AI 前脱敏共用）。mcpAll=false 时 MCP env/header 只取键名敏感的
  // （NODE_ENV=production 这类值整段替换会把输出里的普通词都抹掉）
  const knownSecrets = (mcpAll: boolean): string[] => {
    const secrets: string[] = []
    try { secrets.push(...settings.allApiKeys()) } catch { /* 解密失败就只靠样式脱敏 */ }   // 全部模型配置的 Key
    secrets.push(...hostStore.knownSecrets())   // 主机自己的 + 全部命名凭据的密码/私钥/口令
    try { for (const w of webhookStore.resolveAll()) secrets.push(w.url, w.secret ?? '') } catch { /* 同上 */ }
    try { for (const r of autoReplyStore.resolveAll()) if (r.secret && r.response) secrets.push(r.response) } catch { /* 同上 */ }
    const pick = (o?: Record<string, string>) => Object.entries(o ?? {}).filter(([k]) => mcpAll || /pass|secret|token|key|auth|credential|cookie|session/i.test(k)).map(([, v]) => v)
    try { for (const s of mcpStore.resolve()) secrets.push(...pick(s.env), ...pick(s.headers)) } catch { /* 同上 */ }
    try { secrets.push(...vault.values().map((s) => s.value)) } catch { /* 同上 */ }   // 密钥保险箱（AI 侧先换成 {{secret:名称}}，这里兜底诊断包等）
    return secrets
  }
  // 发给 AI 前脱敏：每次工具调用现取，缓存 5 秒（逐台解密主机凭据不便宜）；改了密码/Key 最多 5 秒后生效
  let aiSecretCache: { at: number; list: string[] } | undefined
  const aiSecrets = () => {
    if (!sys().aiRedact) return undefined
    if (!aiSecretCache || Date.now() - aiSecretCache.at > 5000) aiSecretCache = { at: Date.now(), list: knownSecrets(false) }
    return aiSecretCache.list
  }
  // 所有「把内容发给模型」的旁路（命令预测 / 复核 / 配置解释 / 部署评审 / 看门狗 / Git…）统一走这里：
  // 密钥保险箱明文先回写成占位符（不受脱敏开关影响），再按「发给 AI 前脱敏」处理
  const redactForAi = (s: string, tool = false) => redactAi(s, aiSecrets(), (t) => vault.maskText(t), { tool })
  const fleetDeps: Parameters<typeof hostRunner>[0] = {
    liveTerminal: (hostId) => [...termHostKey].find(([id, k]) => k === hostId && !hiddenTerms.has(id) && terminals.list().some((x) => x.id === id && x.status === 'running'))?.[0],
    execOnTerminal: (id, c, o) => terminals.execFull(id, c, o),
    connectOpts: (hostId) => hostStore.resolveConnectOpts(hostId),
    connect: (o) => connectSsh(o),
    execOnClient: (client, c, o) => execFull(client as Parameters<typeof execFull>[0], c, o),
  }
  const fleetOpen = hostRunner(fleetDeps)
  // 主机仪表盘（见 hostDashboard.ts）：在线终端复用其连接，未连接的按需临时连接采样；只跑固定只读命令
  const dashProfiles = new ProfileStore(join(paths.root, 'profiles'))
  const dashboard = registerHostDashboard({
    handle: (ch, fn) => ipcMain.handle(ch, fn),
    hosts: () => hostStore.list(),
    liveTerminal: (hostId) => [...termHostKey].find(([id, k]) => k === hostId && !hiddenTerms.has(id) && terminals.list().some((x) => x.id === id && x.status === 'running'))?.[0],
    execOnTerminal: (id, c, o) => terminals.execFull(id, c, o),
    connect: async (hostId) => {
      const o = hostStore.resolveConnectOpts(hostId)
      const conn = await connectSsh(o)
      return { exec: (c, x) => execFull(conn.client, c, { ...x, encoding: o.encoding }), close: () => conn.close() }
    },
    lastCheck: async (hostId) => { const m = (await dashProfiles.list(hostId)).find((p) => p.type === 'check'); return m ? { at: m.at, issues: m.issues } : undefined },
    paused: () => appLock.locked,
    log: (lv, m, d) => log(lv, 'main', 'dashboard', m, d),
  })
  win.webContents.on('did-start-loading', () => dashboard.setOpen(false))   // 渲染页重载：仪表盘随之消失，别让采样一直跑

  // ── 磁盘空间分析 / 报错定位一键打开 / 配置按键对比 / 证书巡检（见各自文件）──
  const visibleTerm = (id: string) => terminals.list().find((t) => t.id === id && !hiddenTerms.has(t.id))
  return {
    paths, sessionStore, unattended, send, terminals, hostStore, hostOf, termHostKey, wireNewTerminal, hiddenTerms, termEncoding, mcpStore,
    auth, sys, settings, redactForAi, fleetDeps, auditStore, fleetOpen, aiSecrets, vault, transfer, fileAccessOf, appLock,
    notifyIfUnfocused, DshController, McpManager, AUTO_COMPACT_CAP, userWatching, notify, wireOf, unifiedDiff, recUnsub, termSize,
    recorder, recMask, startLog, startAutoReply, stopRecording, stopLog, autoReply, sessionLog, dashboard, sessionLogDir, forwards,
    cmdHistory, layoutStore, autoReplyStore, summaryPathOf, electronEncryptor, dashProfiles, webhookStore, visibleTerm, logUnsub,
    auditRaw, auditTerminal, auditHost, liveTerminal,
    stopAllLogs, knownSecrets, sendTaps, shouldHideOnClose, beginQuit, cancelQuit, win,
    setClearCards: (f: (sid: string) => void) => { clearCardsOnTurnEnd = f },
    setMobileSecretsInvalidator: (f: () => void) => { invalidateMobileSecrets = f },
    resetAutoReplyRules: () => { autoReplyRules = undefined },
  }
}
