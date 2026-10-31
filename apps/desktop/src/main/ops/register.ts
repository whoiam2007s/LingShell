// 运维领域：容器 / 进程 / 端口 / systemd / K8s 视图、体检、合规、批量执行、多主机日志、巡检、看门狗、部署评审、证书（从 ipc.ts 原样搬来，顺序不变）
import { ipcMain, dialog, app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { writeFile, rm } from 'node:fs/promises'
import { connectSsh, execFull, execStream } from '@lingshell/terminal-core'
import { RunbookStore, ScheduleStore } from '@lingshell/config'
import { type TerminalInfo, type RunbookInput, type ScheduleInput, tr, tk, dateLocale, type CompareTarget, type BatchTag,
  type BatchExecResult, clampInt, BATCH_MAX_TIMEOUT_SEC, BATCH_DEFAULT_TIMEOUT_SEC, batchTagDecision, BATCH_DECISION,
  watchdogSessionPrompt, redactAi, K8S_MAX_BYTES } from '@lingshell/shared'
import { log, findBash, type MainContext } from '../core/index.js'
import { localAccess, sftpAccess } from '../files/index.js'
import { registerLogTail } from './logTail.js'
import { InspectionScheduler } from './inspection.js'
import { selectWebhooks, pushAlerts, alertInfo } from '../integrations/index.js'
import { isReadOnlyCommand } from './readonlyCommand.js'
import { registerDocker } from './docker.js'
import { registerProcesses } from './processes.js'
import { registerPorts } from './portsIpc.js'
import { registerSystemd } from './systemdIpc.js'
import type { SFTPWrapper } from 'ssh2'
import { registerLogMulti } from './logMulti.js'
import { registerConnProbe } from './connProbe.js'
import { BatchRuns, type Runner, localRunner, runBatchHost } from './batchExec.js'
import { WatchdogStore, WatchdogScheduler, registerWatchdogs } from './watchdog.js'
import { registerHostCheck, ProfileStore } from './hostCheck.js'
import { registerTrend } from './trendIpc.js'
import { registerCompliance } from './complianceIpc.js'
import { registerOpsViews } from './opsViewsIpc.js'
import { registerConfigExplain } from './configExplainIpc.js'
import { registerDeployReview } from './deployReviewIpc.js'
import { createLocalViews } from './localViews.js'
import { runSh } from '../terminal/index.js'
import { registerK8s } from './k8sIpc.js'
import { registerDiskUsage } from './diskUsageIpc.js'
import { registerConfigDiff } from './configDiffIpc.js'
import { CertStore, CertMonitor, registerCerts } from './certCheck.js'
import type { registerAiIpc } from '../ai/index.js'

type Deps = Pick<ReturnType<typeof registerAiIpc>, 'controller' | 'openTerminal'>

export function registerOpsIpc(ctx: MainContext, deps: Deps) {
  const { aiSecrets, vault, terminals, hiddenTerms, layoutStore, termHostKey, auditTerminal, auditRaw, liveTerminal, hostOf, wireNewTerminal, forwards, paths, sys,
    sessionStore, send, dashProfiles, dashboard, hostStore, fleetOpen, win, auth, unattended, stopRecording, webhookStore, redactForAi,
    visibleTerm, fileAccessOf, unifiedDiff, notify } = ctx
  const { controller, openTerminal } = deps
  // 逐行版：配置解释 / 部署评审按行标注，行号不能变（私钥块按行遮掉）
  const redactForAiLines = (s: string) => redactAi(s, aiSecrets(), (t) => vault.maskText(t), { lines: true })

  // 本机视图（见 localViews.ts）：本地终端也能开容器 / 进程 / 端口抽屉，数据在本机子进程里取
  const localViews = createLocalViews()
  // 容器视图（见 docker.ts）：SSH 独立 exec channel；启停重启记执行记录（同 user_edit，记到当前会话）
  registerDocker({
    handle: (ch, fn) => ipcMain.handle(ch, fn),
    terminal: (id) => terminals.list().find((t) => t.id === id && !hiddenTerms.has(t.id)),
    exec: (id) => (cmd, ms) => terminals.execRead(id, cmd, ms),
    localExec: localViews.exec,
    audit: (terminalId, e) => auditTerminal(terminalId, e, { logCommand: true }),
    // 同 terminal:duplicate 再开一个，经 terminal:created 让 UI 加标签；createSsh 返回时提示符已就绪，直接敲命令
    openTerminal: async (id, line) => {
      const hostKey = termHostKey.get(id) ?? 'local'
      const info: TerminalInfo = { ...await terminals.duplicate(id), env: hostOf(hostKey)?.env }
      termHostKey.set(info.id, hostKey)
      wireNewTerminal(info)
      terminals.write(info.id, `${line}\r`)
    },
  })
  // 进程管理器（见 processes.ts）：SSH 独立 exec channel 跑 ps；发信号记执行记录 process_kill（记到当前会话）
  registerProcesses({
    handle: (ch, fn) => ipcMain.handle(ch, fn),
    terminal: (id) => terminals.list().find((t) => t.id === id && !hiddenTerms.has(t.id)),
    exec: (id) => (cmd, ms) => terminals.execRead(id, cmd, ms),
    local: localViews,
    audit: (terminalId, e) => auditTerminal(terminalId, e, { logCommand: true }),
  })
  // 监听端口视图 + 一键转发（见 portsIpc.ts）：临时本地转发复用 forwards，终端关闭时停
  const ports = registerPorts({
    handle: (ch, fn) => ipcMain.handle(ch, fn),
    terminal: (id) => terminals.list().find((t) => t.id === id && !hiddenTerms.has(t.id)),
    exec: (id) => (cmd, ms) => terminals.execRead(id, cmd, ms),
    sshOpts: (id) => terminals.sshOpts(id),
    hostKey: (id) => termHostKey.get(id) ?? id,
    forwards,
    localPorts: () => localViews.ports(),
  })
  // systemd 服务视图（见 systemdIpc.ts）：独立 exec channel 跑 systemctl；启停等记执行记录 systemd_<动作>（记到当前会话）
  registerSystemd({
    handle: (ch, fn) => ipcMain.handle(ch, fn),
    terminal: (id) => terminals.list().find((t) => t.id === id && !hiddenTerms.has(t.id)),
    exec: (id) => (cmd, ms) => terminals.execRead(id, cmd, ms),
    audit: (terminalId, e) => auditTerminal(terminalId, e, { logCommand: true }),
  })
  // Kubernetes 视图（见 k8sIpc.ts）：SSH 独立 exec channel / 本机子进程跑 kubectl；滚动重启记执行记录 k8s_restart；SSH 上的端口转发复用端口视图的临时本地转发
  const k8sRun = (r: { stopped?: string; output: string }) => { if (r.stopped) throw new Error(tr('kubectl 超时：集群没有响应')); return r.output }
  const k8s = registerK8s({
    handle: (ch, fn) => ipcMain.handle(ch, fn),
    terminal: (id) => terminals.list().find((t) => t.id === id && !hiddenTerms.has(t.id)),
    exec: (id) => (cmd, ms) => terminals.execFull(id, cmd, { timeoutMs: ms, maxBytes: K8S_MAX_BYTES }).then(k8sRun),
    localExec: (cmd, ms) => runSh(cmd, { timeoutMs: ms, maxBytes: K8S_MAX_BYTES }).then(k8sRun),
    open: (id, cmd, h) => terminals.execStream(id, cmd, h),
    tunnel: async (id, port) => { const f = await ports.forward(id, '127.0.0.1', port); return { id: f.id, localPort: f.localPort } },
    untunnel: (id, fid) => { try { ports.stop(id, fid) } catch { /* 终端已关：转发已随之停 */ } },
    audit: (terminalId, e) => auditTerminal(terminalId, e, { logCommand: true }),
    openTerminal: async (id, line) => {
      const hostKey = termHostKey.get(id) ?? 'local'
      const info: TerminalInfo = { ...await terminals.duplicate(id), env: hostOf(hostKey)?.env }
      termHostKey.set(info.id, hostKey)
      wireNewTerminal(info)
      terminals.write(info.id, `${line}\r`)
    },
  })
  // 日志实时查看（见 logTail.ts）：独立 exec channel 跑 tail -F / journalctl -f，只读不记执行记录
  registerLogTail({ handle: (ch, fn) => ipcMain.handle(ch, fn), terminal: (id) => terminals.list().find((t) => t.id === id && !hiddenTerms.has(t.id)), open: (id, cmd, h) => terminals.execStream(id, cmd, h) })
  // 主机体检 / 配置漂移 / AI 变更前后快照（见 hostCheck.ts）：SSH 独立 exec channel 只读采集，档案存 <数据目录>/profiles
  const hostCheck = registerHostCheck({
    handle: (ch, fn) => ipcMain.handle(ch, fn), store: new ProfileStore(join(paths.root, 'profiles')),
    terminal: (id) => terminals.list().find((t) => t.id === id && !hiddenTerms.has(t.id)),
    hostKey: (id) => termHostKey.get(id) ?? id,
    exec: (id) => (cmd, o) => terminals.execFull(id, cmd, o),
    liveTerminalOf: (hk) => liveTerminal(hk, { running: true }),
    diff: unifiedDiff,
    enabled: () => sys().aiChangeSnapshot !== false,
    isReadOnly: isReadOnlyCommand,
    turnOf: (sid) => controller.turnOf(sid),
    dshIdOf: (sid) => sessionStore.list().find((m) => m.id === sid)?.dshId ?? sid,
    emit: (sessionId, turnId) => send({ type: 'hostChanges:turn', sessionId, turnId }),
    log: (lv, m, d) => log(lv, 'main', 'hostCheck', m, d),
  })
  controller.onEvent(hostCheck.onEvent)
  // 趋势预测（见 trendIpc.ts：体检档案 + 仪表盘采样）与基线合规检查（见 complianceIpc.ts：单机走终端连接，批量同跨主机提问）
  registerTrend({ handle: (ch, fn) => ipcMain.handle(ch, fn), store: dashProfiles, samples: async () => Object.fromEntries(Object.entries((await dashboard.snapshot()).hosts).map(([k, v]) => [k, v.points])) })
  registerCompliance({
    handle: (ch, fn) => ipcMain.handle(ch, fn), dir: paths.config, hosts: () => hostStore.list(), open: fleetOpen,
    terminal: (id) => terminals.list().find((t) => t.id === id && !hiddenTerms.has(t.id)), hostKey: (id) => termHostKey.get(id) ?? id,
    exec: (id, cmd, o) => terminals.execFull(id, cmd, o), log: (lv, m, d) => log(lv, 'main', 'compliance', m, d),
  })
  // 运维视图：定时任务 / 防火墙 / 服务拓扑（见 opsViewsIpc.ts）；改 crontab 记执行记录 cron_<操作>（记到当前会话）
  registerOpsViews({
    handle: (ch, fn) => ipcMain.handle(ch, fn),
    terminal: (id) => { const t = terminals.list().find((x) => x.id === id && !hiddenTerms.has(x.id)); return t && { ...t, env: hostOf(termHostKey.get(t.id) ?? '')?.env } },
    exec: (id) => (cmd, ms) => terminals.execRead(id, cmd, ms),
    audit: (terminalId, e) => auditTerminal(terminalId, e),
    complete: (s, u, sig) => controller.complete(s, u, sig, 'cron-gen'),
  })
  // 配置文件解释（见 configExplainIpc.ts）：缓存放 <数据目录>/config-explain；发给模型前按「发给 AI 前脱敏」处理
  registerConfigExplain({ handle: (ch, fn) => ipcMain.handle(ch, fn), dir: join(paths.root, 'config-explain'),
    complete: (s, u, sig) => controller.complete(s, u, sig, 'config-explain'),
    redact: (t) => redactForAiLines(t) })   // 逐行脱敏：行号不能变

  // 批量执行（见 batchExec.ts）：一台一次调用，连接选择同 fs:compare（在线终端复用连接，否则临时连、跑完即断）。
  // 命令发出去了就记一条执行记录 batch_exec（记到当前会话）
  const batchRuns = new BatchRuns()
  // 目标（本机 / 已保存主机 / 在线终端）→ 执行通道：在线终端复用其连接，已保存主机没开终端就临时连、用完即断
  const liveTermOfHost = (hostId: string) => liveTerminal(hostId, { running: true })
  const targetInfo = (t: CompareTarget) => {
    const termOf = (id: string): Runner => ({ exec: (c, o) => terminals.execFull(id, c, o), close() {} })
    if (t?.kind === 'terminal') {
      return { terminalId: t.terminalId, hostKey: termHostKey.get(t.terminalId) ?? t.terminalId, title: terminals.list().find((x) => x.id === t.terminalId)?.title ?? t.terminalId,
        open: async () => termOf(t.terminalId) }
    }
    if (t?.kind === 'host') {
      const tid = liveTermOfHost(t.hostId) ?? ''
      return { terminalId: tid, hostKey: t.hostId, title: hostOf(t.hostId)?.label ?? t.hostId,
        open: tid ? async () => termOf(tid) : async (): Promise<Runner> => {
          const o = hostStore.resolveConnectOpts(t.hostId)
          const conn = await connectSsh(o)
          return { exec: (c, x) => execFull(conn.client, c, { ...x, encoding: o.encoding }), close: () => conn.close() }
        } }
    }
    return { terminalId: '', hostKey: 'local', title: tr('本机'), open: async () => localRunner(findBash()) }
  }
  ipcMain.handle('batch:exec', async (_e, runId: string, t: CompareTarget, command: string, timeoutMs: number, tag?: BatchTag): Promise<BatchExecResult> => {
    if (typeof runId !== 'string' || typeof command !== 'string' || !command.trim()) throw new Error(tr('请填写命令'))
    const { terminalId, hostKey, title, open } = targetInfo(t)
    const okTag = tag && (tag.kind === 'rollback' || ((tag.kind === 'rollout' || tag.kind === 'health') && Number.isInteger(tag.batch))) ? tag : undefined
    const secs = clampInt(timeoutMs / 1000, 1, BATCH_MAX_TIMEOUT_SEC, BATCH_DEFAULT_TIMEOUT_SEC)
    return runBatchHost(open, command, secs * 1000, batchRuns.signal(runId), (r) => {
      // 运行日志不记命令原文（可能带密码 / token；执行记录里有）
      auditRaw({
        terminalId, terminalTitle: title, hostKey, command, decision: batchTagDecision(BATCH_DECISION, okTag),
        ...(typeof r.exitCode === 'number' ? { exitCode: r.exitCode } : {}), ...(r.status === 'timeout' ? { truncated: true } : {}),
      }, { logLabel: BATCH_DECISION, logExtra: { status: r.status } })
    })
  })
  ipcMain.handle('batch:cancel', (_e, runId: string) => { if (typeof runId === 'string') batchRuns.cancel(runId) })
  // 多主机日志（见 logMulti.ts）与连通性探测（见 connProbe.ts）：连接选择同批量执行；只读，不记执行记录
  const multiLogs = registerLogMulti({
    handle: (ch, fn) => ipcMain.handle(ch, fn),
    runner: (t) => targetInfo(t).open,
    encoding: (t) => {
      const tid = t.kind === 'terminal' ? t.terminalId : t.kind === 'host' ? liveTermOfHost(t.hostId) : undefined
      if (tid) return terminals.list().find((x) => x.id === tid)?.encoding
      try { return t.kind === 'host' ? hostStore.resolveConnectOpts(t.hostId).encoding : undefined } catch { return undefined }
    },
    open: async (t, cmd, h) => {
      const tid = t.kind === 'terminal' ? t.terminalId : t.kind === 'host' ? liveTermOfHost(t.hostId) : undefined
      if (tid) return terminals.execStream(tid, cmd, h)
      if (t.kind !== 'host') throw new Error(tr('只支持 SSH 主机'))
      const conn = await connectSsh(hostStore.resolveConnectOpts(t.hostId))
      let closed = false
      const close = () => { if (!closed) { closed = true; conn.close() } }
      const stop = execStream(conn.client, cmd, { data: h.data, end: (e) => { close(); h.end(e) } })
      return () => { stop(); close() }
    },
    log: (lv, m, d) => log(lv, 'main', 'logMulti', m, d),
  })
  registerConnProbe({ handle: (ch, fn) => ipcMain.handle(ch, fn), runner: (t) => targetInfo(t).open, log: (lv, m, d) => log(lv, 'main', 'probe', m, d) })
  const runbookStore = new RunbookStore(paths.config)
  ipcMain.handle('runbooks:list', () => runbookStore.list())
  ipcMain.handle('runbooks:save', (_e, input: RunbookInput) => runbookStore.save(input))
  ipcMain.handle('runbooks:delete', (_e, id: string) => runbookStore.delete(id))
  // 部署评审（见 deployReviewIpc.ts）：评审存 <数据目录>/deploy-reviews；文档 / 预检输出按「发给 AI 前脱敏」处理后才给模型
  registerDeployReview({
    handle: (ch, fn) => ipcMain.handle(ch, fn), dir: join(paths.root, 'deploy-reviews'),
    pickFiles: async (o) => (await dialog.showOpenDialog(win, { title: o.title, filters: o.filters, properties: o.multi ? ['openFile', 'multiSelections'] : ['openFile'] })).filePaths,
    complete: (s, u, sig) => controller.complete(s, u, sig, 'deploy-review'),
    redact: (t) => redactForAiLines(t),
    hosts: () => hostStore.list(), open: fleetOpen, isReadOnly: isReadOnlyCommand,
    saveRunbook: (input) => runbookStore.save(input),
    savePdf: async (html, name) => {
      const r = await dialog.showSaveDialog(win, { defaultPath: join(app.getPath('downloads'), name), filters: [{ name: 'PDF', extensions: ['pdf'] }] })
      if (r.canceled || !r.filePath) return undefined
      // 报告 HTML 落临时文件再打印（长报告放 data: 地址会超长度上限）；不需要脚本
      const tmp = join(app.getPath('temp'), `lingshell-report-${Date.now()}.html`)
      const pw = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true } })
      try {
        await writeFile(tmp, html, 'utf8')
        await pw.loadFile(tmp)
        await writeFile(r.filePath, await pw.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { marginType: 'default' } }))
      } finally { pw.destroy(); await rm(tmp, { force: true }) }
      return r.filePath
    },
    log: (lv, m, d) => log(lv, 'main', 'deployReview', m, d),
  })

  // ── 定时巡检（只在应用运行时执行，调度/授权说明见 inspection.ts）────────
  const scheduleStore = new ScheduleStore(paths.config)
  const hostLabel = (key: string) => key === 'local' ? tr('本地') : hostStore.list().find((h) => h.id === key)?.label ?? key
  const STATUS_TEXT = { abnormal: tk('发现异常'), failed: tk('执行失败'), timeout: tk('超时'), unknown: tk('未给出状态'), normal: tk('正常'), running: tk('运行中') } as const
  const inspection = new InspectionScheduler({
    list: () => scheduleStore.list(),
    markRun: (id, at) => scheduleStore.markRun(id, at),
    putRun: (run) => scheduleStore.putRun(run),
    prepare: async (s, title) => {
      const { id: sessionId } = await controller.createSession({ title })
      // 无人值守授权：只读档 + 预授目标主机 read（仅本会话）；运行期间决策走 unattendedDecide
      auth.setTrust(sessionId, 'readonly')
      for (const t of s.targets) auth.grant(sessionId, t, 'read')
      unattended.set(sessionId, new Set(s.targets))
      const cleanup = async () => {
        unattended.delete(sessionId)
        for (const [tid, sid] of hiddenTerms) {
          if (sid !== sessionId) continue
          terminals.close(tid); void stopRecording(tid); termHostKey.delete(tid); hiddenTerms.delete(tid)
        }
        // 用户正看着这个会话就留着，否则释放 agent（会话记录还在，点开时自动重连）
        if (layoutStore.get().activeSessionId !== sessionId) await controller.closeSession(sessionId)
      }
      try {
        const terms: { terminalId: string; label: string }[] = []
        for (const t of s.targets) terms.push({ terminalId: (await openTerminal(sessionId, t)).terminalId, label: hostLabel(t) })
        return { sessionId, terms, cleanup }
      } catch (e) { await cleanup(); throw e }
    },
    sendTurn: (sid, text) => controller.sendTurn(sid, text),
    interruptTurn: (sid) => controller.interruptTurn(sid),
    onEvent: (h) => controller.onEvent(h),
    emitRun: (run) => send({ type: 'inspection:run', run }),
    alert: (run) => notify(win, tr('巡检「{name}」{status}', { name: run.scheduleName, status: tr(STATUS_TEXT[run.status]) }),
      run.error ?? (run.summary.split('\n').filter(Boolean).slice(-3).join(' ') || tr('点击查看')),
      () => { if (run.sessionId) send({ type: 'inspection:openSession', sessionId: run.sessionId }) }),
    // 群机器人推送（见 webhook.ts）：日志只记名称与错误，不记 URL
    push: async (s, run) => {
      const targets = selectWebhooks(s, run.status, webhookStore.resolveAll())
      if (!targets.length) return undefined
      const err = await pushAlerts(targets, alertInfo(run, s.targets.map(hostLabel)))
      log(err ? 'warn' : 'info', 'main', 'inspection', err ? `群机器人推送失败：${err}` : `已推送到 ${targets.length} 个群机器人`)   // i18n-ignore 日志
      return err
    },
    log: (level, message, data) => log(level, 'main', 'inspection', message, data),
  })
  inspection.start()
  ipcMain.handle('schedules:list', () => scheduleStore.list())
  ipcMain.handle('schedules:save', (_e, input: ScheduleInput) => scheduleStore.save(input))
  ipcMain.handle('schedules:delete', (_e, id: string) => scheduleStore.delete(id))
  ipcMain.handle('schedules:runNow', (_e, id: string) => inspection.enqueue(id))
  ipcMain.handle('schedules:listRuns', () => scheduleStore.listRuns())
  // ── 看门狗（只在应用运行时检查，见 watchdog.ts）：独立 exec channel 跑只读脚本，不进交互终端。
  // 已保存主机有在线终端就复用它的连接，否则临时连一次、跑完即断（无人值守：未知指纹不弹确认，直接失败）
  const watchdogStore = new WatchdogStore(paths.config)
  const WD_TIMEOUT_MS = 30_000
  const watchdogs = new WatchdogScheduler({
    list: () => watchdogStore.list(),
    hosts: () => hostStore.list(),
    run: (hk, script) => {
      const signal = new AbortController().signal
      if (hk === 'local') return runBatchHost(async () => localRunner(findBash()), script, WD_TIMEOUT_MS, signal)
      const tid = liveTerminal(hk, { running: true })
      const open = tid ? async (): Promise<Runner> => ({ exec: (c, o) => terminals.execFull(tid, c, o), close() {} }) : async (): Promise<Runner> => {
        const o = hostStore.resolveConnectOpts(hk)
        const conn = await connectSsh({ ...o, noHostKeyPrompt: true })
        return { exec: (c, x) => execFull(conn.client, c, { ...x, encoding: o.encoding }), close: () => conn.close() }
      }
      return runBatchHost(open, script, WD_TIMEOUT_MS, signal, undefined, 20_000)
    },
    loadStates: () => watchdogStore.loadStates(),
    saveStates: (s) => watchdogStore.saveStates(s),
    emit: (state) => send({ type: 'watchdog:state', state }),
    // 锁定时 notify 自动换通用文案、点击不跳转（见 notify.ts）
    notify: (title, body, sid) => notify(win, title, body, sid ? () => send({ type: 'inspection:openSession', sessionId: sid }) : undefined),
    openSession: async (w, host, value) => {
      const { id } = await controller.createSession({ title: tr('看门狗 · {name} · {host}', { name: w.name, host: host.label }) })
      // 监控脚本输出是命令输出，按「发给 AI 前脱敏」处理（以前原样塞进用户消息）
      await controller.sendTurn(id, redactForAi(watchdogSessionPrompt(w, host, value)))
      return id
    },
    log: (level, message, data) => log(level, 'main', 'watchdog', message, data),
    loadPaused: () => watchdogStore.loadPaused(),
    savePaused: (p) => watchdogStore.savePaused(p),
    onPaused: (paused) => send({ type: 'watchdog:paused', paused }),
    // 自测用：开发版可用环境变量把「1 分钟」缩短（毫秒），打包版不认
    unitMs: !app.isPackaged && Number(process.env.LINGSHELL_WATCHDOG_UNIT_MS) > 0 ? Number(process.env.LINGSHELL_WATCHDOG_UNIT_MS) : undefined,
  })
  watchdogs.start()
  registerWatchdogs({ handle: (ch, fn) => ipcMain.handle(ch, fn), store: watchdogStore, scheduler: watchdogs, complete: (s, u, sig) => controller.complete(s, u, sig, 'watchdog') })
  const liveTermOf = (hk: string) => liveTerminal(hk, { running: true })
  registerDiskUsage({
    handle: (ch, fn) => ipcMain.handle(ch, fn), terminal: visibleTerm,
    sshExec: (tid) => (c, o) => terminals.execFull(tid, c, o),
    localExec: () => { const b = findBash(); return process.platform === 'win32' && !b ? undefined : localRunner(b ?? undefined).exec },
    log: (lv, m, d) => log(lv, 'main', 'disk', m, d),
  })
  registerConfigDiff({
    handle: (ch, fn) => ipcMain.handle(ch, fn),
    open: async (t) => {
      if (t.kind === 'local') return { fa: localAccess(paths.root), close() {} }
      const tid = t.kind === 'terminal' ? t.terminalId : liveTermOf(t.hostId)
      if (tid) return { fa: await fileAccessOf(tid), close() {} }
      const o = hostStore.resolveConnectOpts(t.kind === 'host' ? t.hostId : '')
      const conn = await connectSsh(o)
      try { return { fa: sftpAccess(await new Promise<SFTPWrapper>((res, rej) => conn.client.sftp((e, s) => (e ? rej(e) : res(s)))), o.encoding), close: () => conn.close() } }
      catch (e) { conn.close(); throw e }
    },
    log: (m, d) => log('info', 'main', 'configDiff', m, d),
  })
  // 证书巡检：经主机检查时有在线终端复用其连接，否则临时连（无人值守：未知指纹不弹确认）
  const certStore = new CertStore(paths.config)
  const certNow = !app.isPackaged ? process.env.LINGSHELL_CERT_NOW : undefined   // 自测注入「当前时间」，打包版不认
  const certs = new CertMonitor({
    store: certStore, now: () => (certNow ? new Date(certNow) : new Date()),
    runVia: async (hk, cmd, ms) => {
      const tid = liveTermOf(hk)
      const open = tid ? async (): Promise<Runner> => ({ exec: (c, o) => terminals.execFull(tid, c, o), close() {} }) : async (): Promise<Runner> => {
        const o = hostStore.resolveConnectOpts(hk)
        const conn = await connectSsh({ ...o, noHostKeyPrompt: true })
        return { exec: (c, x) => execFull(conn.client, c, { ...x, encoding: o.encoding }), close: () => conn.close() }
      }
      const r = await runBatchHost(open, cmd, ms, new AbortController().signal, undefined, 20_000)
      if (r.status === 'conn_error' || r.status === 'canceled') throw new Error(r.error ?? tr('连接失败'))
      if (r.status === 'timeout') throw new Error(tr('执行超时'))
      return r.output ?? ''
    },
    hostLabel: (id) => hostOf(id)?.label ?? id,
    notify: (t, b) => notify(win, t, b),
    push: (title, lines, hosts) => {
      const targets = webhookStore.resolveAll().filter((w) => w.enabled && w.url)
      if (!targets.length) return Promise.resolve(undefined)
      return pushAlerts(targets, { scheduleName: title, status: 'abnormal', hosts, time: new Date().toLocaleString(dateLocale(), { hour12: false }), summary: lines.join('\n') })
    },
    log: (lv, m, d) => log(lv, 'main', 'certs', m, d),
  })
  certs.start()
  registerCerts({ handle: (ch, fn) => ipcMain.handle(ch, fn), store: certStore, monitor: certs })
  return { hostCheck, ports, k8s, multiLogs, watchdogs, certs, inspection }
}
