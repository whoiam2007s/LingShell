// 终端领域：本地 / SSH 终端、录像、会话日志、主机与密钥、端口转发、主机指纹、命令历史、自动应答、快速命令（从 ipc.ts 原样搬来，顺序不变）
import { ipcMain, dialog, shell } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { setHostKeyPolicy, newTmuxSessionName, testSshConnection, connectSsh, setSshAuthPrompter, execFull } from '@lingshell/terminal-core'
import { PortForwardStore, KnownHostsStore, requireSshAgent, appendNoteText, previewSshConfig, importSshConfig, detectSshAgent, readJson,
  writeJson, QuickCommandStore } from '@lingshell/config'
import { type HostKeyInfo, type SshConnectInput, type SshConnectOpts, type SshCreateOpts, type TerminalInfo, type HostInput,
  type PortForwardInput, type QuickCommandsData, type AutoReplyInput, tr, MAX_JUMP_DEPTH, isTmuxSessionName } from '@lingshell/shared'
import { randomUUID } from 'node:crypto'
import { log, type MainContext } from '../core/index.js'
import { parseProxy, registerSshAuth } from './sshAuthIpc.js'
import { registerHostProbe } from './hostProbe.js'
import { listRecordings, recordingPath } from './recorder.js'
import { HostStatsScheduler, localStats, remoteStats } from './hostStats.js'
import { registerLocalShells } from './localShells.js'
import { registerGitBash } from './gitBashIpc.js'
import { KeyStore, registerSshKeys } from './sshKeys.js'
import { registerCredentials } from './credentialsIpc.js'
import { registerHostBatch } from './hostBatchIpc.js'
import { registerSessionImport } from './sessionImportIpc.js'
import type { registerFilesIpc } from '../files/index.js'
import type { registerOpsIpc } from '../ops/index.js'

type Deps = Pick<ReturnType<typeof registerFilesIpc>, 'externalEdit'> & Pick<ReturnType<typeof registerOpsIpc>, 'ports'>

export function registerTerminalIpc(ctx: MainContext, deps: Deps) {
  const { sys, terminals, recUnsub, termSize, recorder, vault, recMask, send, paths, hostStore, win, hiddenTerms, hostOf, termHostKey,
    startLog, startAutoReply, settings, stopRecording, stopLog, autoReply, sessionLog, dashboard, appLock, sessionLogDir, forwards,
    cmdHistory, auditHost, autoReplyStore, resetAutoReplyRules, notifyIfUnfocused, summaryPathOf, electronEncryptor } = ctx
  const { externalEdit, ports } = deps
  const startRecording = (id: string) => {
    if (!sys().terminalRecording) throw new Error(`recording_disabled: ${tr('请先在系统设置里启用终端录屏')}`)
    const t = terminals.list().find((x) => x.id === id)
    if (!t) throw new Error('terminal_not_found')
    if (recUnsub.has(id)) return
    const sz = termSize.get(id)
    recorder.start(id, t.title, t.type, sz?.cols, sz?.rows)
    const m = vault.stream()
    recMask.set(id, m)
    recUnsub.set(id, terminals.onData(id, (chunk) => recorder.output(id, m.push(chunk))))
    send({ type: 'terminal:recording', terminalId: id, recording: true })
  }
  // 应用管理的 SSH 密钥（见 sshKeys.ts）：主机认证选「应用密钥」时连接从这里取私钥
  const keyStore = new KeyStore(paths.config, electronEncryptor)
  hostStore.appKey = (id) => keyStore.resolve(id)
  const savedForwards = new PortForwardStore(paths.config)

  // ── SSH 主机指纹（TOFU）：所有 SSH 连接都经 connectSsh 校验，这里注入记录存储 + 首连确认 ──
  const knownHosts = new KnownHostsStore(paths.config)
  const hostKeyPending = new Map<string, (trust: boolean) => void>()
  const HOSTKEY_TIMEOUT_MS = 2 * 60_000
  const lastMismatch = new Map<string, HostKeyInfo>()   // hostPort → 最近一次不符时服务器给的钥匙（acceptChanged 只能用它，不信任渲染层传指纹）
  setHostKeyPolicy({
    lookup: (hp) => knownHosts.get(hp),
    remember: (hp, keyType, fp) => { knownHosts.put(hp, keyType, fp); log('info', 'main', 'ssh', 'host key trusted', { hostPort: hp, keyType, fp }) },
    // 首次见到：弹确认（同授权卡：pending + 事件 + decide），超时 = 取消。无人值守连接不会走到这（opts.noHostKeyPrompt）
    prompt: (info) => new Promise<boolean>((resolve) => {
      const requestId = randomUUID()
      const timer = setTimeout(() => {
        hostKeyPending.delete(requestId)
        send({ type: 'hostKey:resolved', requestId })
        resolve(false)
      }, HOSTKEY_TIMEOUT_MS)
      hostKeyPending.set(requestId, (trust) => { clearTimeout(timer); resolve(trust) })
      send({ type: 'hostKey:unknown', requestId, info, deadlineMs: HOSTKEY_TIMEOUT_MS })
      notifyIfUnfocused(win, tr('首次连接 SSH 主机，请确认指纹'), tr('{label}（{hostPort}）', { label: info.label, hostPort: info.hostPort }))
    }),
    onMismatch: (info) => {
      lastMismatch.set(info.hostPort, info)
      log('warn', 'main', 'ssh', 'host key mismatch', info)
      send({ type: 'hostKey:mismatch', info })
    },
  })
  // 新连接表单（明文）→ 连接参数；选了跳板机则带上解析好的跳板链（新连接本身占一级，跳板链剩 MAX-1 级）
  const inputToOpts = (c: SshConnectInput): SshConnectOpts => ({
    host: c.host, port: c.port, username: c.username,
    password: c.authType === 'password' ? c.password : undefined,
    privateKey: c.authType === 'key' ? c.privateKey : undefined,
    passphrase: c.authType === 'key' ? c.passphrase : undefined,
    agent: c.authType === 'agent' ? requireSshAgent() : undefined,
    jump: c.jumpHostId ? hostStore.resolveConnectOpts(c.jumpHostId, MAX_JUMP_DEPTH - 1) : undefined,
    encoding: c.encoding,
    // 出站代理（经跳板时不用）：表单指定 > 全局默认
    proxy: c.jumpHostId || c.proxyCommand || c.proxy === 'none' ? undefined : c.proxy && c.proxy !== 'default' ? parseProxy(c.proxy) : hostStore.defaultProxyOpts(),
    ...(!c.jumpHostId && c.proxyCommand?.trim() ? { proxyCommand: c.proxyCommand.trim() } : {}),   // 主机管理页测试连接：表单里的 ProxyCommand
    ...(c.authType === 'key' && c.keyId ? keyStore.resolve(c.keyId) : {}),   // 应用密钥
    ...(c.credentialId ? hostStore.credentialConnectOpts(c.credentialId) : {}),   // 使用凭据：用户名/认证全取自凭据
  })

  // terminal handlers
  // 只列用户可见的终端（巡检后台终端不给界面；渲染页重载后界面靠它接管已有终端）
  ipcMain.handle('terminal:list', () => terminals.list().filter((t) => !hiddenTerms.has(t.id))
    .map((t) => { const h = t.type === 'ssh' ? hostOf(termHostKey.get(t.id) ?? '') : undefined; return h ? { ...t, env: h.env, hostId: h.id } : t }))
  ipcMain.handle('terminal:createLocal', async (_e, opts) => {
    const info = terminals.createLocal(opts)
    termHostKey.set(info.id, 'local')
    terminals.onData(info.id, (chunk) => send({ type: 'terminal:data', terminalId: info.id, chunk }))
    startLog(info)
    startAutoReply(info.id)
    return terminals.ready(info.id)   // WSL：等命令捕获探测完（决定 AI 能不能用），先订阅再等，首屏不丢
  })
  registerLocalShells({ handle: (ch, fn) => ipcMain.handle(ch, fn) })   // 新建本地终端可选的 shell（见 localShells.ts）
  registerGitBash({ handle: (ch, fn) => ipcMain.handle(ch, fn), getPath: () => sys().bashPath ?? '',   // Git Bash 探测 / 手动指定（见 gitBashIpc.ts）
    setPath: (p) => settings.save({ ...settings.get(), system: { ...sys(), bashPath: p } }),
    pickFile: async () => (await dialog.showOpenDialog(win, { title: tr('选择 Git Bash（bash.exe）'), properties: ['openFile'], filters: [{ name: 'bash.exe', extensions: ['exe'] }] })).filePaths[0] })
  // SSH 终端：用已存主机(hostId) 或 新连接(connect，可选 saveAs 存为主机)
  ipcMain.handle('terminal:createSsh', async (_e, opts: SshCreateOpts) => {
    let connectOpts
    let title: string | undefined
    let savedId: string | undefined
    let tmux: string | undefined   // 保持会话：已存主机开了才用；指定的会话名（布局恢复 / 接回）校验格式，否则新起一个
    if ('hostId' in opts) {
      connectOpts = hostStore.resolveConnectOpts(opts.hostId)
      const h = hostStore.list().find((x) => x.id === opts.hostId)
      title = h?.label   // 标签作 title
      if (h?.persistSession) tmux = isTmuxSessionName(opts.tmuxSession) ? opts.tmuxSession : newTmuxSessionName()
    } else {
      const c = opts.connect
      connectOpts = inputToOpts(c)
      title = opts.saveAs   // 新连接的标签（saveAs 即 label）作 title
      if (opts.saveAs) {
        // 存下的主机 id 就是这个终端的 hostKey：上传/下载靠它找连接参数，授权也按它记
        savedId = hostStore.save({ label: opts.saveAs, host: c.host, port: c.port, username: c.username, authType: c.authType, password: c.password, privateKey: c.privateKey, passphrase: c.passphrase, jumpHostId: c.jumpHostId, notes: opts.notes, env: opts.env, group: opts.group, encoding: c.encoding, persistSession: opts.persistSession, ...(c.keyId ? { keyId: c.keyId } : {}), ...(c.credentialId ? { credentialId: c.credentialId } : {}) }).id
        if (opts.persistSession) tmux = newTmuxSessionName()
      }
    }
    const hostKey = 'hostId' in opts ? opts.hostId : savedId ?? `${connectOpts.host}:${connectOpts.port}`
    // 勾了「保存为主机」的新连接也把 savedId 带回去：标签页持久化 / 上传 / tmux 都按 hostId 认
    const savedHostId = 'hostId' in opts ? opts.hostId : savedId
    let created: TerminalInfo
    try { created = await terminals.createSsh({ ...connectOpts, title, tmux }) }
    catch (e) {
      // 连不上（密码错 / 地址不通）不留下本次刚保存的主机：否则每重试一次就多一条（还带着错的密码）
      if (savedId && !('hostId' in opts)) hostStore.delete(savedId)
      throw e
    }
    const info: TerminalInfo = { ...created, env: hostOf(hostKey)?.env, ...(savedHostId ? { hostId: savedHostId } : {}) }
    termHostKey.set(info.id, hostKey)
    terminals.onData(info.id, (chunk) => send({ type: 'terminal:data', terminalId: info.id, chunk }))
    startLog(info)
    startAutoReply(info.id)
    return info
  })
  // 测试 SSH 连接：只验证能否连上，不开终端
  // hostId：编辑已存主机时测试连接。表单里密码 / 私钥留空 = 用已存的那份（以前会拿空密码去测，好的主机也报认证失败）
  ipcMain.handle('terminal:testSsh', async (_e, c: SshConnectInput, hostId?: string) => {
    try {
      const opts = inputToOpts(c)
      if (hostId) {
        const st = hostStore.resolveConnectOpts(hostId)
        if (c.authType === 'password' && !c.password) opts.password = st.password
        if (c.authType === 'key' && !c.keyId && !c.privateKey) { opts.privateKey = st.privateKey; opts.passphrase = c.passphrase || st.passphrase }
        if (!opts.jump && st.jump) opts.jump = st.jump
        if (!c.proxyCommand && st.proxyCommand) opts.proxyCommand = st.proxyCommand
        if (c.proxy === undefined && st.proxy) opts.proxy = st.proxy
        else if (opts.proxy && st.proxy && !opts.proxy.password && opts.proxy.type === st.proxy.type && opts.proxy.host === st.proxy.host && opts.proxy.port === st.proxy.port && opts.proxy.username === st.proxy.username) opts.proxy.password = st.proxy.password
      }
      await testSshConnection(opts)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('terminal:write', (_e, id: string, data: string, opts?: { noHistory?: boolean }) => { terminals.write(id, data, opts?.noHistory === true ? { noHistory: true } : undefined); recorder.input(id, data) })
  ipcMain.handle('terminal:close', (_e, id: string, tmux?: 'kill' | 'keep') => {
    void terminals.close(id, tmux === 'kill' || tmux === 'keep' ? tmux : 'idle')
    void stopRecording(id)
    void stopLog(id)
    autoReply.detach(id)
    externalEdit.stopTerminal(id)
    ports.stopTerminal(id)
    // 授权按 hostKey（主机）记录，非按终端 → 关一个终端不撤主机授权（同主机可能还有别的终端）
    termHostKey.delete(id)
    termSize.delete(id)
  })
  // 渲染页重载后回填滚动区：主进程里的会话还活着，读最近输出（剥 ANSI，不含密钥 —— 与终端里可见内容一致）
  ipcMain.handle('terminal:snapshot', (_e, id: string, lines?: number) => terminals.readSnapshot(id, lines))
  ipcMain.handle('terminal:interrupt', (_e, id: string) => { terminals.interrupt(id); recorder.input(id, '') })
  ipcMain.handle('terminal:resize', (_e, id: string, cols: number, rows: number) => {
    terminals.resize(id, cols, rows)
    if (cols >= 2 && rows >= 2) { termSize.set(id, { cols: Math.floor(cols), rows: Math.floor(rows) }); recorder.resize(id, Math.floor(cols), Math.floor(rows)); sessionLog.resize(id, Math.floor(cols), Math.floor(rows)) }
  })
  ipcMain.handle('terminal:reconnect', (_e, id: string) => terminals.reconnect(id))
  // 复制会话：同目标再开一个（hostKey 沿用：授权/上传/历史跟原终端同主机）
  ipcMain.handle('terminal:duplicate', async (_e, id: string) => {
    const hostKey = termHostKey.get(id) ?? 'local'
    const dup = await terminals.duplicate(id)
    const info: TerminalInfo = dup.type === 'ssh' ? { ...dup, env: hostOf(hostKey)?.env } : dup
    termHostKey.set(info.id, hostKey)
    terminals.onData(info.id, (chunk) => send({ type: 'terminal:data', terminalId: info.id, chunk }))
    startLog(info)
    startAutoReply(info.id)
    return info
  })
  ipcMain.handle('terminal:pwd', (_e, id: string) => terminals.pwd(id))
  ipcMain.handle('terminal:tmuxJobs', (_e, id: string) => terminals.tmuxJobs(id))
  ipcMain.handle('terminal:tmuxSessions', (_e, id: string) => terminals.tmuxSessions(id))

  // 主机状态小面板（见 hostStats.ts）：只采 UI 报来的可见终端；SSH 走独立 exec channel，不碰交互 shell
  const hostStats = new HostStatsScheduler({
    settings: () => ({ enabled: sys().hostStats, intervalSec: sys().hostStatsIntervalSec, prod: sys().hostStatsProd }),
    targets: () => terminals.list().filter((t) => !hiddenTerms.has(t.id)).map((t) => {
      const hostKey = termHostKey.get(t.id) ?? 'local'
      return { id: t.id, hostKey, type: t.type, os: t.os, running: t.status === 'running', prod: t.type === 'ssh' && hostOf(hostKey)?.env === 'prod' }
    }),
    collect: (t) => t.type === 'local' ? localStats()
      : remoteStats((cmd, ms) => terminals.execRead(t.id, cmd, ms), t.os === 'macos' ? 'macos' : 'linux'),
    emit: (terminalId, u) => { if (u.stats) dashboard.ingest(termHostKey.get(terminalId), u.stats); send({ type: 'terminal:hostStats', terminalId, ...u }) },
    paused: () => appLock.locked,
  })
  hostStats.start()
  ipcMain.handle('terminal:watchStats', (_e, ids: unknown) => hostStats.watch(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []))

  // 终端录像：列表 / 读整份给回放 / 在文件管理器里定位
  ipcMain.handle('recordings:list', () => listRecordings(paths.recordings, recorder.activeIds()))
  ipcMain.handle('recordings:start', (_e, id: string) => startRecording(id))
  ipcMain.handle('recordings:stop', (_e, id: string) => stopRecording(id))
  ipcMain.handle('recordings:active', () => [...recUnsub.keys()])
  ipcMain.handle('recordings:read', (_e, id: string) => readFile(recordingPath(paths.recordings, id), 'utf8'))
  // 删单个录像：id 走 recordingPath 校验（只能删录像目录内的 .cast）；正在录的不让删
  ipcMain.handle('recordings:delete', async (_e, id: string) => {
    const p = recordingPath(paths.recordings, id)
    if (recorder.activeIds().has(id)) throw new Error(`recording_active: ${tr('正在录制，先停止录制再删除')}`)
    await rm(p, { force: true })
    await rm(summaryPathOf(p), { force: true })   // 旁边的 AI 摘要
  })
  ipcMain.handle('recordings:openFolder', async (_e, id?: string) => {
    if (id) shell.showItemInFolder(recordingPath(paths.recordings, id))
    else await shell.openPath(paths.recordings)
  })
  // 会话日志：打开目录（设置页可传未保存的目录）/ 用系统程序打开某终端当前的 .log（打不开就在文件管理器里定位）
  ipcMain.handle('sessionLogs:openFolder', async (_e, dir?: string) => {
    const d = dir || sessionLogDir()
    await mkdir(d, { recursive: true })
    const err = await shell.openPath(d)
    if (err) throw new Error(err)
  })
  ipcMain.handle('sessionLogs:openTerminal', async (_e, id: string) => {
    const file = await sessionLog.fileOf(id)
    if (!file) throw new Error(`session_log_off: ${tr('该终端没有在记录会话日志（请先在系统设置里开启）')}`)
    if (await shell.openPath(file)) shell.showItemInFolder(file)
  })

  // hosts handlers
  ipcMain.handle('hosts:list', () => hostStore.list())
  ipcMain.handle('hosts:save', (_e, input: HostInput) => hostStore.save(input))
  // 删主机：先停掉这台主机上正在跑的端口转发（否则 SSH / 监听一直留着，界面上却找不到入口），再删保存的转发和主机
  ipcMain.handle('hosts:delete', (_e, id: string) => { forwards.stopByHost(id); hostStore.delete(id); savedForwards.deleteByHost(id) })
  ipcMain.handle('hosts:appendNote', (_e, hostKey: string, text: string) => {
    if (hostKey !== 'local') return hostStore.appendNote(hostKey, text)
    settings.save({ ...settings.get(), system: { ...sys(), localNotes: appendNoteText(sys().localNotes, text) } })
  })
  // 从 ~/.ssh/config 导入：预览不含私钥内容；导入时主进程重新读取私钥并加密保存
  ipcMain.handle('hosts:sshConfigPreview', () => previewSshConfig(hostStore.list()))
  ipcMain.handle('hosts:importSshConfig', (_e, aliases: string[]) => importSshConfig(hostStore, aliases))
  ipcMain.handle('hosts:detectAgent', () => detectSshAgent() ?? null)

  // 端口转发：本地（127.0.0.1:localPort → remoteHost:remotePort）/ 动态 SOCKS5（目标由客户端指定），均经该主机（含跳板）
  ipcMain.handle('portForward:list', () => forwards.list())
  // unattended：启动时自动开启的不弹指纹确认（首次手动启动时已确认过）
  const startForward = async (input: PortForwardInput, unattended = false) => {
    const label = hostStore.list().find((h) => h.id === input.hostId)?.label ?? input.hostId
    hostStore.resolveConnectOpts(input.hostId)   // 先校验一次：主机不存在/凭据坏了直接报错，不留半截转发
    return forwards.start(input, () => ({ ...hostStore.resolveConnectOpts(input.hostId), ...(unattended ? { noHostKeyPrompt: true } : {}) }), label)
  }
  ipcMain.handle('portForward:start', (_e, input: PortForwardInput) => startForward(input))
  ipcMain.handle('portForward:stop', (_e, id: string) => forwards.stop(id))
  ipcMain.handle('portForward:retry', (_e, id: string) => forwards.retry(id))
  ipcMain.handle('portForward:listSaved', () => savedForwards.list())
  ipcMain.handle('portForward:save', (_e, input: PortForwardInput) => {
    if (!hostStore.list().some((h) => h.id === input.hostId)) throw new Error(tr('临时连接的转发无法保存（没有已存凭据），请先保存主机'))
    return savedForwards.save(input)
  })
  ipcMain.handle('portForward:setAutoStart', (_e, id: string, on: boolean) => savedForwards.setAutoStart(id, on === true))
  ipcMain.handle('portForward:deleteSaved', (_e, id: string) => savedForwards.delete(id))
  for (const s of savedForwards.autoStartList(hostStore.list().map((h) => h.id))) {
    startForward(s.input, true).catch((e: unknown) => log('warn', 'main', 'portForward', 'autoStart failed', { id: s.id, err: e instanceof Error ? e.message : String(e) }))
  }

  // SSH 主机指纹
  ipcMain.handle('knownHosts:list', () => knownHosts.list())
  ipcMain.handle('knownHosts:decide', (_e, requestId: string, trust: boolean) => {
    const r = hostKeyPending.get(requestId); if (!r) return   // 已超时/已决，幂等
    hostKeyPending.delete(requestId); r(trust === true)
    send({ type: 'hostKey:resolved', requestId })
  })
  ipcMain.handle('knownHosts:acceptChanged', (_e, hostPort: string) => {
    const m = lastMismatch.get(hostPort)
    if (!m) throw new Error(tr('没有该主机最近的指纹不符记录，请重新连接一次'))
    knownHosts.put(hostPort, m.keyType, m.fingerprint)
    lastMismatch.delete(hostPort)
    log('warn', 'main', 'ssh', 'host key replaced by user', m)
  })
  ipcMain.handle('knownHosts:remove', (_e, hostPort: string) => knownHosts.remove(hostPort))
  ipcMain.handle('knownHosts:importOpenSsh', async () => {
    const file = join(homedir(), '.ssh', 'known_hosts')
    if (!existsSync(file)) throw new Error(tr('未找到 {file}', { file }))
    return knownHosts.importOpenSsh(await readFile(file, 'utf8'))
  })

  // 命令历史
  ipcMain.handle('history:list', (_e, hostKey: string) => cmdHistory.list(hostKey))
  ipcMain.handle('history:delete', (_e, hostKey: string, index: number) => cmdHistory.delete(hostKey, index))
  ipcMain.handle('history:clear', (_e, hostKey: string) => cmdHistory.clear(hostKey))
  // 命令补全：按终端定主机（与记历史时同一个 hostKey）
  ipcMain.handle('history:forTerminal', (_e, tid: string) => { const hostKey = termHostKey.get(tid) ?? 'local'; return { hostKey, entries: cmdHistory.list(hostKey) } })
  ipcMain.handle('history:deleteCommand', (_e, tid: string, command: string) => { cmdHistory.deleteCommand(termHostKey.get(tid) ?? 'local', String(command)) })
  // SSH 二次验证弹框 + 全局默认出站代理（见 sshAuthIpc.ts）
  registerSshAuth({ handle: (ch, fn) => ipcMain.handle(ch, fn), send, notify: (t, b) => notifyIfUnfocused(win, t, b), setPrompter: setSshAuthPrompter,
    proxy: { get: () => hostStore.getDefaultProxy(), save: (p) => hostStore.saveDefaultProxy(p) } })
  registerHostProbe({
    handle: (ch, fn) => ipcMain.handle(ch, fn), hosts: () => hostStore.list(), hasDefaultProxy: () => !!hostStore.getDefaultProxy(),
    // 复制主机时把主机规则（rules.json）一起复制，否则复制出来的生产主机悄悄少一层 AI 安全规则
    duplicate: (id) => {
      const copy = hostStore.duplicate(id)
      const file = join(paths.config, 'rules.json')
      const r = readJson<{ groups?: Record<string, string>; hosts?: Record<string, string> }>(file)
      const t = r?.hosts?.[id]
      if (t) writeJson(file, { ...r, hosts: { ...(r?.hosts ?? {}), [copy.id]: t } })
      return copy
    },
  })
  // SSH 密钥管理 / 部署公钥（见 sshKeys.ts）：部署走临时连接（用主机现有认证），跑完即断，记执行记录 key_deploy
  registerSshKeys({
    handle: (ch, fn) => ipcMain.handle(ch, fn),
    keys: keyStore, hosts: hostStore,
    pickFile: async () => {
      const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'showHiddenFiles'], defaultPath: join(homedir(), '.ssh') })
      return r.canceled ? undefined : r.filePaths[0]
    },
    saveFile: async (name, content) => {
      const r = await dialog.showSaveDialog(win, { defaultPath: name })
      if (r.canceled || !r.filePath) return undefined
      await writeFile(r.filePath, content, { encoding: 'utf8', mode: 0o600 })
      return r.filePath
    },
    exec: async (o, command) => {
      const conn = await connectSsh(o)
      try { return await execFull(conn.client, command, { timeoutMs: 30_000, maxBytes: 64 * 1024 }) }
      finally { conn.close() }
    },
    test: (o) => testSshConnection(o),
    audit: (hostKey, title, command, exitCode) => {
      auditHost(hostKey, { terminalTitle: title, command, decision: 'key_deploy', ...(typeof exitCode === 'number' ? { exitCode } : {}) }, { logCommand: true })
    },
  })
  registerCredentials({ handle: (ch, fn) => ipcMain.handle(ch, fn), hosts: hostStore })   // 命名凭据（见 credentialsIpc.ts）
  registerHostBatch({ handle: (ch, fn) => ipcMain.handle(ch, fn), hosts: hostStore })    // 批量修改主机（见 hostBatchIpc.ts）
  registerSessionImport({
    handle: (ch, fn) => ipcMain.handle(ch, fn),
    hosts: hostStore,
    pick: async (dir, filters) => {
      const r = await dialog.showOpenDialog(win, { properties: [dir ? 'openDirectory' : 'openFile'], ...(filters.length ? { filters } : {}) })
      return r.canceled ? undefined : r.filePaths[0]
    },
  })
  const quickStore = new QuickCommandStore(paths.config)
  ipcMain.handle('quickCommands:get', () => quickStore.get())
  ipcMain.handle('quickCommands:save', (_e, data: QuickCommandsData) => quickStore.save(data))

  ipcMain.handle('autoReplies:list', () => autoReplyStore.list())
  ipcMain.handle('autoReplies:save', (_e, input: AutoReplyInput) => { const r = autoReplyStore.save(input); resetAutoReplyRules(); return r })
  ipcMain.handle('autoReplies:delete', (_e, id: string) => { autoReplyStore.delete(id); resetAutoReplyRules() })
  return { hostStats }
}
