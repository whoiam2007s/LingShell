// AI 领域：授权卡 / 计划卡、dsh 控制器、会话与对话、知识库、安全规则、用量、MCP、模板（从 ipc.ts 原样搬来，顺序不变）
import { ipcMain, app, shell, dialog, clipboard } from 'electron'
import { join, posix } from 'node:path'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import type { ApprovalRequest, PlanRequest, DshController } from '@lingshell/dsh-controller'
import { TemplateStore } from '@lingshell/config'
import { type AppEvent, type ApprovalAnswer, type TrustLevel, type UsageRange, type UsagePrices, type TemplateInput, type McpServerInput,
  tr, decodeText, encodeText, type NlCommandRequest, buildNlCommandPrompt, sanitizeNlCommand, summarizeUsage, sessionUsage,
  applyRuleVerdict, evaluateCommandRules, dangerCheck } from '@lingshell/shared'
import { randomUUID } from 'node:crypto'
import { log, type MainContext } from '../core/index.js'
import { type FileAccess, localAccess, sftpAccess, writeWithBackup, MAX_FILE_BYTES, EXT_EDIT_MAX_BYTES } from '../files/index.js'
import { unattendedDecide, neededForExec, isReadOnlyCommand, hostRunner, runOnHosts, type registerHostCheck } from '../ops/index.js'
import { recordingPath, createSideExec } from '../terminal/index.js'
import { createTurnNotifier } from './turnNotify.js'
import { initUsage, recordUsage } from './usage.js'
import { registerModelProfiles } from './modelProfilesIpc.js'
import { registerSkills } from './skillsIpc.js'
import { parseAttachments, registerAttachments, parseFileNameW, IMAGE_FILTER } from './attachIpc.js'
import { registerChatFork } from './chatForkIpc.js'
import { sha256, registerTurnUndo } from './turnUndo.js'
import { registerRollback } from './rollbackIpc.js'
import { registerKnowledge } from './knowledgeIpc.js'
import { registerSafety } from './safetyIpc.js'
import { registerAiLink } from './aiLinkIpc.js'
import { createAskBroker, registerChatPlus } from './chatPlusIpc.js'

type Deps = { hostCheck: () => ReturnType<typeof registerHostCheck> }

export function registerAiIpc(ctx: MainContext, deps: Deps) {
  const { paths, sessionStore, win, unattended, send, setClearCards, terminals, hostStore, hostOf, termHostKey, wireNewTerminal, auditRaw, liveTerminal,
    hiddenTerms, termEncoding, mcpStore, auth, sys, settings, redactForAi, fleetDeps, auditStore, fleetOpen, aiSecrets, vault, transfer,
    fileAccessOf, appLock, notifyIfUnfocused, DshController, McpManager, AUTO_COMPACT_CAP, userWatching, notify, wireOf, unifiedDiff } = ctx
  const { hostCheck } = deps
  // 还没处理的授权 / 计划卡（渲染页重载后要重新发给界面，否则 AI 一直等、界面却看不到卡片）
  const pendingCards = new Map<string, { sid: string; ev: AppEvent }>()
  const usageStore = initUsage(paths.config)
  const sessionTitle = (id: string) => sessionStore.list().find((m) => m.id === id)?.title ?? id

  // 授权请求 IPC 桥：引擎需弹卡 → IPC → UI；UI 决策 → auth:decide → 回 resolve
  const pending = new Map<string, (ans: ApprovalAnswer) => void>()
  // dsh 的授权请求本身不限时（只随 turn 取消而结束）；原来的 50s 是给 CodeWhale 60s 上限留余量，已无此约束
  const APPROVAL_TIMEOUT_MS = 5 * 60_000

  const requestApproval = (req0: ApprovalRequest): Promise<ApprovalAnswer> => {
    // 兜底：巡检会话的决策只有 allow/deny，不该走到授权卡；万一走到也立即拒绝，绝不挂起
    if (unattended.has(req0.sessionId)) return Promise.resolve({ decision: 'deny', note: '无人值守巡检：不允许需要人工授权的操作' })   // i18n-ignore 拒绝说明给模型看
    const req = safety.decorate(req0)   // 需要提权的命令：卡上可选「N 分钟内允许提权」（见 safetyIpc.ts）
    const approvalId = randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(approvalId); pendingCards.delete(approvalId)
        send({ type: 'auth:resolved', approvalId, result: 'timeout' })
        resolve({ decision: 'deny' })
      }, APPROVAL_TIMEOUT_MS)
      pending.set(approvalId, (ans) => { clearTimeout(timer); safety.onAnswer(req, ans); resolve(ans) })
      const ev = { type: 'auth:request' as const, approvalId, deadlineMs: APPROVAL_TIMEOUT_MS, ...req }
      pendingCards.set(approvalId, { sid: req.sessionId, ev })
      send(ev)
      notifyIfUnfocused(win, tr('「{title}」等待你授权', { title: sessionTitle(req.sessionId) }), req.command ?? (req.needed === 'read' ? tr('读取终端') : tr('写入终端')))
    })
  }

  // 授权卡应答（桌面端 auth:decide 与手机端共用）。fromMobile = 该会话 id：dsh 在应答后同一轮微任务里同步写授权记录，
  // 这期间该会话的 allow:* / deny:user* 记录标「手机授权」（setImmediate 时清掉）
  let mobileDecided: string | undefined
  const decideApproval = (approvalId: string, ans: ApprovalAnswer, fromMobile?: string): boolean => {
    const r = pending.get(approvalId); if (!r) return false   // 已超时/已决，幂等
    pending.delete(approvalId); pendingCards.delete(approvalId)
    if (fromMobile) { mobileDecided = fromMobile; setImmediate(() => { mobileDecided = undefined }) }
    r(ans)
    send({ type: 'auth:resolved', approvalId, result: ans.decision })  // 通知 UI 关闭卡片（之前漏发，卡片不关）
    return true
  }

  // 计划审批卡：与授权卡共用 pending / auth:decide / auth:resolved，只是事件形状不同
  const requestPlan = (req: PlanRequest): Promise<ApprovalAnswer> => {
    // 巡检会话无人审批，计划卡同样不能挂起（巡检本就只读，不需要计划）
    if (unattended.has(req.sessionId)) return Promise.resolve({ decision: 'deny', note: '无人值守巡检：只做只读检查，不执行计划' })   // i18n-ignore 拒绝说明给模型看
    const approvalId = randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(approvalId); pendingCards.delete(approvalId)
        send({ type: 'auth:resolved', approvalId, result: 'timeout' })
        resolve({ decision: 'deny' })
      }, APPROVAL_TIMEOUT_MS)
      pending.set(approvalId, (ans) => { clearTimeout(timer); resolve(ans) })
      const ev = { type: 'plan:request' as const, approvalId, deadlineMs: APPROVAL_TIMEOUT_MS, ...req }
      pendingCards.set(approvalId, { sid: req.sessionId, ev })
      send(ev)
      notifyIfUnfocused(win, tr('「{title}」等待你审批计划', { title: sessionTitle(req.sessionId) }), tr('{title}（{n} 步）', { title: req.title, n: req.steps.length }))
    })
  }

  // 回合结束 / 删会话：挂着没人处理的卡片作废（界面那边由 turn 结束事件把卡片标成「未处理」）
  const clearCardsOnTurnEnd = (sid: string) => {
    for (const [approvalId, c] of [...pendingCards]) {
      if (c.sid !== sid) continue
      pendingCards.delete(approvalId)
      const r = pending.get(approvalId)
      if (r) { pending.delete(approvalId); r({ decision: 'deny', note: '本轮已结束' }) }   // i18n-ignore 拒绝说明给模型看
    }
  }
  setClearCards(clearCardsOnTurnEnd)
  const controllerRef: { current?: DshController } = {}
  // 开终端：AI 的 create_terminal 工具与定时巡检共用。巡检会话开的终端放后台（不进 UI，跑完关掉）
  const openTerminal = async (sessionId: string, target: string) => {
    let info: import('@lingshell/shared').TerminalInfo
    if (target === 'local') {
      const cwd = controllerRef.current?.getWorkDir(sessionId)
      info = terminals.createLocal(cwd ? { cwd } : undefined)
    } else {
      const connectOpts = hostStore.resolveConnectOpts(target)
      const host = hostOf(target)
      // 巡检无人值守：未知主机指纹不弹确认，直接失败（host_key_unknown）
      const noHostKeyPrompt = unattended.has(sessionId) || undefined
      info = { ...await terminals.createSsh({ ...connectOpts, title: host?.label, noHostKeyPrompt }), env: host?.env }   // env：生产徽标
    }
    termHostKey.set(info.id, target)
    if (!unattended.has(sessionId)) return wireNewTerminal(info)
    hiddenTerms.set(info.id, sessionId)
    return { terminalId: info.id, title: info.title }
  }
  // 还原时原终端可能已关：本地直接用 fs；远程找同主机任一仍打开的终端
  const fileAccessOfHost = async (hostKey: string): Promise<FileAccess> => {
    if (hostKey === 'local') return localAccess(paths.root)
    const tid = liveTerminal(hostKey, { running: true, includeHidden: true })
    if (!tid) throw new Error(tr('该主机当前没有已连接的终端，请先打开它的 SSH 终端再还原'))
    return sftpAccess(await terminals.sftp(tid), termEncoding(tid))
  }
  const mcp = new McpManager({
    log: (level, message, data) => log(level, 'main', 'mcp', message, data),
    onStatus: (servers) => send({ type: 'mcp:status', servers }),
  })
  const applyMcp = () => mcp.apply(mcpStore.resolve()).catch((e) => log('error', 'main', 'mcp', `apply failed: ${String(e)}`))
  void applyMcp()

  // 巡检会话：无人值守只读白名单（不弹卡）；其余照常，生产主机信任档至少 confirm、危险命令无视开关一律确认。
  // AI 工具网关与「一键回滚」共用（回滚不绕过规则 / 信任档）
  const decideCmd = (sid: string, hostKey: string, needed: 'read' | 'write', command?: string) => {
    const targets = unattended.get(sid)
    if (targets) return unattendedDecide(targets, hostKey, needed, command)
    const prod = hostOf(hostKey)?.env === 'prod'
    const base = () => auth.decide(sid, hostKey, neededForExec(needed, command, prod), command, sys().confirmDangerous, prod)
    if (!command) return base()
    // 命令放行 / 询问 / 禁止规则先判（见 shared/ai/commandRules.ts）：没有定论再走信任档
    return applyRuleVerdict(evaluateCommandRules(sys().commandRules, command, { hostKey, group: hostOf(hostKey)?.group }), base,
      { prod, readonly: auth.getTrust(sid) === 'readonly', dangerous: dangerCheck(command) === 'dangerous' })
  }
  // 主机知识库（见 knowledgeIpc.ts）+ 跨主机提问的执行通道（见 fleetExec.ts，连接选择同批量执行）
  const knowledge = registerKnowledge({ handle: (ch, fn) => ipcMain.handle(ch, fn), dir: paths.config, hosts: () => hostStore.list(), localNotes: () => sys().localNotes })
  // 安全与流程（见 safetyIpc.ts）：分层规则 / AI 复核 / 预演模式 / sudo 限时提权
  const safety = registerSafety({
    handle: (ch, fn) => ipcMain.handle(ch, fn), dir: paths.config, hosts: () => hostStore.list(), sys, auth, isReadOnly: isReadOnlyCommand,
    knowledgeTitles: (k) => knowledge.titles(k), profileName: (id) => settings.resolveProfile(id).name,
    complete: (s, u, sig, src, pid) => controllerRef.current!.complete(s, u, sig, src, pid),
    preview: { get: (sid) => !!controllerRef.current?.isPreview(sid), set: (sid, on) => controllerRef.current?.setPreview(sid, on), approve: (sid, steps) => controllerRef.current?.approvePlan(sid, steps) ?? 0 },
    unattended: (sid) => unattended.has(sid), send, redact: (t) => redactForAi(t), log: (lv, m, d) => log(lv, 'main', 'safety', m, d),
  })
  // 无人值守会话（巡检）里 AI 调 run_on_hosts：临时连接遇到未知指纹直接失败，不在半夜弹确认框
  const fleetOpenUnattended = hostRunner(fleetDeps, true)

  // AI 提问卡（ask_user，见 chatPlusIpc.ts）：发卡等回答，超时 / 停止 = 未回答
  const askBroker = createAskBroker({ send, notify: (t, b) => notifyIfUnfocused(win, t, b), sessionTitle, unattended: (sid) => unattended.has(sid) })
  // dsh 是进程内库：没有 MCP 协议层、没有 bridge 端口、没有会话进程池。
  // 终端能力直接注册成 dsh 工具，授权走 tools/pre-execute 三态网关。
  const controller = new DshController({
    baseDir: paths.sessions,
    terminals,
    resolveHostKey: (tid) => termHostKey.get(tid) ?? 'local',
    decide: (sid, hk, needed, cmd) => safety.leaseDecide(sid, hk, cmd, decideCmd(sid, hk, needed, cmd)),   // 叠上限时提权
    layeredRules: safety.layeredRules,
    reviewCommand: (r) => safety.review(r),
    isReadOnly: isReadOnlyCommand,   // 非只读的 exec 要求带回滚方案（生产缺失直接拒，见 terminalTools.rollbackDeny）
    grant: (sid, hostKey, level) => auth.grant(sid, hostKey, level),
    audit: (rec) => {
      // 运行日志不记命令原文（可能带口令，如 mysql -pxxx），只记结论；命令原文只在执行记录里
      // 落「执行记录」：主机标识和终端名在记录时取（终端之后可能已关）
      auditRaw({
        ...rec,
        // MCP 调用没有终端：hostKey 记 mcp:<服务名>，终端名位置显示工具名
        // run_on_hosts 不经终端：工具层直接给了主机 id 与名字
        hostKey: rec.hostKey ?? (rec.mcpServer ? `mcp:${rec.mcpServer}` : termHostKey.get(rec.terminalId) ?? 'local'),
        terminalTitle: rec.terminalTitle ?? rec.mcpTool ?? terminals.list().find((t) => t.id === rec.terminalId)?.title,
        ...(mobileDecided === rec.sessionId && /^(allow:|deny:user)/.test(rec.decision) ? { via: 'mobile' as const } : {}),
      }, { logLabel: 'cmd' })
    },
    requestApproval,
    requestPlan,
    requestAsk: (r, s) => askBroker.request(r, s),
    execTimeoutMs: () => sys().execTimeoutSec * 1000,
    contextLimitTokens: () => AUTO_COMPACT_CAP,   // 实际阈值 = min(600K, 模型上下文窗口 × 60%)，见 dsh-controller compaction.ts
    contextResetSteps: () => sys().contextResetSteps,
    createLocalTerminal: (sessionId) => openTerminal(sessionId, 'local'),
    createSshTerminal: (sessionId, hostId) => openTerminal(sessionId, hostId),
    // 分级 + 该主机的知识卡标题（全文在用到该主机后经系统提示「主机知识库」段注入）
    hostMeta: (tid) => {
      const hostKey = termHostKey.get(tid) ?? 'local'
      const titles = knowledge.titles(hostKey)
      return { ...(hostKey === 'local' ? {} : { env: hostOf(hostKey)?.env }), ...(titles.length ? { knowledge: titles } : {}) }
    },
    // AI 终端清单里带上各终端最近知道的 cwd（不触发 pwd 探测），问目录时不用为此跑命令、弹授权
    terminalCwd: (tid) => terminals.cachedCwd(tid),
    proposeKnowledge: (sessionId, req) => {
      const p = knowledge.propose(req)
      send({ type: 'knowledge:proposal', proposalId: randomUUID(), sessionId, ...p })
      return { targetLabel: p.targetLabel }
    },
    hostKnowledge: (keys) => knowledge.context(keys),
    // 跨主机提问：只给名称 / id / 分组 / 环境；只读判定同巡检白名单
    fleetHosts: () => hostStore.list().map((h) => ({ id: h.id, label: h.label, ...(h.group ? { group: h.group } : {}), ...(h.env ? { env: h.env } : {}) })),
    runOnHosts: (hosts, command, ms, signal, sid) => runOnHosts(hosts, sid && unattended.has(sid) ? fleetOpenUnattended : fleetOpen, command, ms, signal),
    customRules: () => sys().customRules,
    aiSecrets,
    secretVault: vault,
    mcp,
    trustOf: (sid) => auth.getTrust(sid),
    isUnattended: (sid) => unattended.has(sid),
    recordUsage,
    uploadFile: async (localPath, terminalId, targetDir) => {
      const hostKey = termHostKey.get(terminalId)
      if (!hostKey || hostKey === 'local') throw new Error('upload_requires_ssh_terminal: terminal_id 必须是 SSH 终端')   // i18n-ignore 工具报错给模型看
      const opts = hostStore.resolveConnectOpts(hostKey)
      const encrypt = sys().uploadEncrypt
      await transfer.upload(opts, localPath, targetDir, encrypt, hostKey)
      return { host: `${opts.username}@${opts.host}`, encrypted: encrypt }
    },
    readFile: async (terminalId, p) => {
      const fa = await fileAccessOf(terminalId)
      const buf = await fa.read(await fa.resolve(p))
      return buf && decodeText(buf, fa.encoding)
    },
    writeFile: async (terminalId, p, content) => {
      const fa = await fileAccessOf(terminalId)
      const data = Buffer.from(encodeText(content, fa.encoding))
      return { ...await writeWithBackup(fa, await fa.resolve(p), data), hash: sha256(data) }   // hash：按回合撤销时判断是否已被后续改动覆盖
    },
    // 落到 ~/Downloads/lingshell/：不混进会话工作目录（常是代码仓库），位置固定好找；重名加时间前缀不覆盖
    downloadFile: async (terminalId, remotePath) => {
      const hostKey = termHostKey.get(terminalId)
      if (!hostKey || hostKey === 'local') throw new Error('download_requires_ssh_terminal: terminal_id 必须是 SSH 终端')   // i18n-ignore 工具报错给模型看
      const opts = hostStore.resolveConnectOpts(hostKey)   // 与 transfer:download 同：仅已保存主机
      const dir = join(app.getPath('downloads'), 'LingShell')
      await mkdir(dir, { recursive: true })
      const name = posix.basename(remotePath)
      const localName = existsSync(join(dir, name)) ? `${Date.now()}_${name}` : name
      return { localPath: await transfer.download(opts, remotePath, dir, localName) }
    },
    // 一套模型配置（缺省 / 已删 = 默认配置），明文 key 只在主进程内
    resolveSettings: (profileId) => {
      const p = settings.resolveProfile(profileId)
      return { profileId: p.id, provider: p.provider, model: p.model, baseUrl: p.baseUrl, apiKey: p.apiKey, contextWindow: p.contextWindow, protocol: p.protocol, multimodal: p.multimodal }
    },
    listTerminals: () => terminals.list().map((t) => ({ id: t.id, title: t.title, type: t.type, os: t.os })),
    beforeChange: (sid, tids, cmd) => hostCheck().beforeChange(sid, tids, cmd),   // 变更保险（见 hostCheck.ts）
    sideExec: createSideExec(terminals),   // AI 后台任务走旁路通道，包装命令不进用户终端（见 bgJobExec.ts）
    sessionStore: {
      upsert: (m) => sessionStore.upsert(m),
      remove: (id) => sessionStore.remove(id),
      list: () => sessionStore.list(),
      touch: (id, at) => sessionStore.touch(id, at),
    },
    log: (level, message, data) => log(level, 'main', 'dsh', message, data),
  })
  controllerRef.current = controller

  controller.onEvent(send)
  // AI 回合完成 / 出错时提醒（见 turnNotify.ts）：窗口在前台不打扰；点通知回到窗口并切到那个会话（已是当前会话就不切）
  controller.onEvent(createTurnNotifier({
    enabled: () => sys().aiDoneNotify !== false,
    unattended: (sid) => unattended.has(sid),   // 巡检结果另有通知（只在异常时弹）
    title: sessionTitle,
    notify: (title, body, sid) => {
      if (userWatching(win) && !appLock.locked) return
      // 点击总是发 openSession：UI 要借它收起仪表盘 / 帮助 / 命令面板；同会话时 selectSession 会去重
      notify(win, title, body, () => send({ type: 'inspection:openSession', sessionId: sid }))
    },
  }))
  // 渲染页开始（重新）加载：活会话在下次界面 reconnect 时重放历史。首次加载时没有活会话，无副作用
  win.webContents.on('did-start-loading', () => controller.markRendererReloaded())

  // agent handlers
  ipcMain.handle('agent:createSession', (_e, opts) => controller.createSession(opts))
  ipcMain.handle('agent:listSessions', () => controller.listSessions())
  ipcMain.handle('agent:sendTurn', (_e, sessionId: string, prompt: string) => controller.sendTurn(sessionId, prompt))
  ipcMain.handle('agent:interruptTurn', (_e, sessionId: string) => controller.interruptTurn(sessionId))
  // 回合进行中追问（见 DshController.steer）；附件同 attach:send 校验
  ipcMain.handle('agent:steer', (_e, sessionId: string, prompt: unknown, atts: unknown) => controller.steer(String(sessionId), typeof prompt === 'string' ? prompt : '', parseAttachments(atts ?? [])))
  ipcMain.handle('agent:unsteer', (_e, sessionId: string, messageId: unknown) => controller.unsteer(String(sessionId), String(messageId)))
  // Phase 4 多会话持久化
  ipcMain.handle('agent:listPersisted', () => sessionStore.list())
  ipcMain.handle('agent:reconnectSession', async (_e, id: string) => {
    const meta = sessionStore.list().find((m) => m.id === id)
    if (!meta) throw new Error('session_not_found')
    const info = await controller.reconnectSession(meta)
    // 渲染页重载 / 切到正在跑的会话：回放故意不发 turn 事件，这里按主进程里的真实状态补一个，
    // 否则界面不知道这一轮还在跑（不显示停止按钮，发消息也走错分支）
    const turnId = controller.activeTurn(id)
    if (turnId) send({ type: 'agent:turnStarted', sessionId: id, turnId })
    // 重载前还没处理的授权 / 计划卡重新发给界面（卡片只在内存里，重载后丢了就没人能批准）
    for (const c of pendingCards.values()) if (c.sid === id) send(c.ev)
    return info
  })
  ipcMain.handle('agent:deleteSession', async (_e, id: string) => { await controller.deleteSession(id); auth.revokeSession(id); clearCardsOnTurnEnd(id) })
  ipcMain.handle('agent:renameSession', (_e, id: string, title: string) => controller.renameSession(id, title))
  ipcMain.handle('agent:setWorkDir', (_e, sessionId: string, workDir: string) => controller.setWorkDir(sessionId, workDir))
  ipcMain.handle('agent:resetContext', (_e, sessionId: string, seed?: string) => controller.resetContext(sessionId, seed))
  ipcMain.handle('agent:search', (_e, query: string) => controller.searchSessions(query))
  // 终端里自然语言写命令：一次性补全，30s 超时；只收描述 + 系统 / 目录 / 生产标记（不带终端内容）。报错原样抛，界面 nlErrorText 翻译
  ipcMain.handle('agent:suggestCommand', async (_e, req: NlCommandRequest) => {
    const description = String(req?.description ?? '').trim().slice(0, 500)
    if (!description) throw new Error(tr('无法转换成命令：描述为空'))
    const os = (['linux', 'macos', 'windows'] as const).find((x) => x === req?.os) ?? 'unknown'
    const p = buildNlCommandPrompt({ description, os, cwd: typeof req?.cwd === 'string' ? req.cwd.slice(0, 500) : undefined, prod: req?.prod === true })
    const r = sanitizeNlCommand(await controller.complete(p.system, p.user, AbortSignal.timeout(30_000), 'nl-command'))
    if ('error' in r) throw new Error(r.error)
    return r.command
  })
  // AI 与终端联动：预测下一条命令 / 录像 AI 摘要（见 aiLinkIpc.ts）
  registerAiLink({ handle: (ch, fn) => ipcMain.handle(ch, fn), complete: (s, u, sig, src) => controller.complete(s, u, sig, src),
    redact: (t) => redactForAi(t), castPath: (id) => recordingPath(paths.recordings, id) })

  // auth handlers
  ipcMain.handle('auth:decide', (_e, approvalId: string, ans: ApprovalAnswer) => { decideApproval(approvalId, ans) })
  // 授权按 hostKey（'local' / hostId / 'host:port'）记录；前端 AuthDrawer 直接传 hostKey，这里透传给 auth。
  ipcMain.handle('auth:listForSession', (_e, sid: string) => auth.listForSession(sid).map((r) => ({ hostKey: r.terminalId, level: r.level })))
  ipcMain.handle('auth:grant', (_e, sid: string, hostKey: string, level: 'read' | 'write') => auth.grant(sid, hostKey, level))
  ipcMain.handle('auth:revoke', (_e, sid: string, hostKey: string) => auth.revoke(sid, hostKey))
  ipcMain.handle('auth:getTrust', (_e, sid: string) => auth.getTrust(sid))
  ipcMain.handle('auth:setTrust', (_e, sid: string, lvl: string) => auth.setTrust(sid, lvl as TrustLevel))
  ipcMain.handle('audit:listForSession', (_e, sid: string) => auditStore.listForSession(sid))
  ipcMain.handle('audit:listRecent', () => auditStore.listRecent())
  // 用量统计：聚合在主进程做，渲染层只拿汇总
  ipcMain.handle('usage:summary', (_e, range: UsageRange) => summarizeUsage(usageStore.list(), settings.getUsagePrices(), range))
  ipcMain.handle('usage:session', (_e, sid: string) => ({ ...sessionUsage(usageStore.list(), settings.getUsagePrices(), sid), currency: settings.getUsagePrices().currency }))
  ipcMain.handle('usage:getPrices', () => settings.getUsagePrices())
  ipcMain.handle('usage:savePrices', (_e, p: UsagePrices) => settings.saveUsagePrices(p))
  // 还原 AI 改过的文件：路径只从审计记录里取。覆盖前照样备份当前内容，并记一条 restored（它也能再还原，即撤销还原）
  ipcMain.handle('audit:restore', async (_e, sid: string, at: string) => {
    const rec = auditStore.find(sid, at)
    if (!rec?.filePath || !rec.backupPath) throw new Error(tr('该记录没有可还原的备份'))
    const fa = await fileAccessOfHost(rec.hostKey)
    const max = rec.decision === 'file_edit_external' ? EXT_EDIT_MAX_BYTES : MAX_FILE_BYTES   // 外部编辑可能是大文件，按其上限还原
    const original = await fa.read(rec.backupPath, max)
    if (original === undefined) throw new Error(tr('备份文件已不存在：{path}', { path: rec.backupPath }))
    const r = await writeWithBackup(fa, rec.filePath, original, new Date(), max)
    auditRaw({
      sessionId: sid, terminalId: rec.terminalId, terminalTitle: rec.terminalTitle, hostKey: rec.hostKey,
      command: `还原 ${rec.filePath} ← ${rec.backupPath}`, decision: 'restored', filePath: rec.filePath, backupPath: r.backupPath,   // i18n-ignore 执行记录原文
    }, { logLabel: 'restore', logCommand: true })
  })
  registerModelProfiles({   // 多模型配置：测试连接 + 会话级切换模型（见 modelProfilesIpc.ts）
    handle: (ch, fn) => ipcMain.handle(ch, fn),
    stored: (id) => { const p = settings.get().modelProfiles?.find((x) => x.id === id); return p && { provider: p.provider, apiKey: settings.getProfileKey(id) } },
    setSessionModel: (sid, pid) => controller.setSessionModel(sid, pid),
    sessionModel: (sid) => controller.sessionModel(sid),
  })
  // 设置 → Skills（见 skillsIpc.ts）：<数据目录>/skills，接到 dsh 的 ctx.skills
  registerSkills({ handle: (ch, fn) => ipcMain.handle(ch, fn), root: join(paths.root, 'skills'), attach: (lib) => controller.attachSkills(lib), openPath: (p) => shell.openPath(p), log: (lv, m, d) => log(lv, 'main', 'skills', m, d),
    pickPath: async (kind) => (await dialog.showOpenDialog(win, kind === 'folder' ? { title: tr('选择 Skill 文件夹（含 SKILL.md）'), properties: ['openDirectory'] } : { title: tr('选择 Skill 包'), properties: ['openFile'], filters: [{ name: tr('Skill 包'), extensions: ['zip', 'skill'] }] })).filePaths[0] })

  // AI 对话附件：选择文件 / 目录 / 图片、带附件发送、历史回放取图、打开附件（见 attachIpc.ts）
  registerAttachments({ handle: (ch, fn) => ipcMain.handle(ch, fn), send: (sid, p, a) => controller.sendTurn(sid, p, a), readImage: (id) => controller.readImage(id), openPath: (p) => shell.openPath(p),
    clipboardFiles: () => (process.platform === 'win32' ? parseFileNameW(clipboard.readBuffer('FileNameW')) : []),
    pick: async (k) => (await dialog.showOpenDialog(win, k === 'dirs' ? { title: tr('选择目录'), properties: ['openDirectory', 'multiSelections'] } : k === 'images' ? { title: tr('选择图片'), properties: ['openFile', 'multiSelections'], filters: [IMAGE_FILTER] } : { title: tr('选择文件'), properties: ['openFile', 'multiSelections'] })).filePaths })
  // 对话：编辑重发 / 从这里分叉 / 重新生成（见 chatForkIpc.ts）
  registerChatFork({ handle: (ch, fn) => ipcMain.handle(ch, fn), fork: (sid, mid, mode) => controller.forkSession(sid, mid, mode) })

  // 左侧对话增强（见 chatPlusIpc.ts）：提问卡回答、@ 历史会话摘要、跨会话检索、输入框 `!命令`
  registerChatPlus({ handle: (ch, fn) => ipcMain.handle(ch, fn), ask: askBroker, digest: (sid) => controller.sessionDigest(sid), docs: () => controller.searchDocsAll(),
    auditEntries: () => auditStore.listRecent(5000), sessionIds: () => new Set(sessionStore.list().map((m) => m.id)),
    terminal: (id) => terminals.list().find((t) => t.id === id && !hiddenTerms.has(t.id) && t.status !== 'disconnected'),
    exec: (tid, cmd) => terminals.execCapture(tid, cmd, undefined, sys().execTimeoutSec * 1000, wireOf(vault, tid, cmd)),
    redact: (s) => redactForAi(s, true),
    audit: (e) => { auditRaw({ ...e, hostKey: termHostKey.get(e.terminalId) ?? 'local' }) } })
  // 回合末改动汇总 / 按回合撤销（见 turnUndo.ts）：从执行记录聚合，按会话当前 dsh 日志的轮次对上对话里的回合
  registerTurnUndo({ handle: (ch, fn) => ipcMain.handle(ch, fn), entries: (sid) => auditStore.listForSession(sid, 5000),
    dshIdOf: (sid) => sessionStore.list().find((m) => m.id === sid)?.dshId ?? sid, access: fileAccessOfHost, diff: unifiedDiff,
    audit: (e) => { auditRaw(e) } })

  // 一键回滚（见 rollbackIpc.ts）：经同主机的可见终端执行，过同一套规则 / 信任档 / 危险命令判定
  registerRollback({ handle: (ch, fn) => ipcMain.handle(ch, fn), find: (sid, at) => auditStore.find(sid, at), entries: (sid) => auditStore.listForSession(sid, 5000),
    terminals: () => terminals.list().filter((t) => !hiddenTerms.has(t.id) && t.status === 'running').map((t) => ({ id: t.id, title: t.title, hostKey: termHostKey.get(t.id) ?? 'local' })),
    decide: (sid, hk, cmd) => decideCmd(sid, hk, 'write', cmd), isProd: (hk) => hostOf(hk)?.env === 'prod', dangerous: (c) => dangerCheck(c) === 'dangerous',
    // 回滚命令里的密钥占位符同 AI 执行：发进终端前展开（范围不符抛错），结果里的明文换回占位符
    exec: async (tid, cmd) => { const r = await terminals.execCapture(tid, cmd, undefined, sys().execTimeoutSec * 1000, wireOf(vault, tid, cmd)); return { ...r, output: vault.maskText(r.output) } },
    audit: (e) => { auditRaw(e) } })

  // ── 常用任务模板 ──────────────────────────────────────
  const templateStore = new TemplateStore(paths.config)
  ipcMain.handle('templates:list', () => templateStore.list())
  ipcMain.handle('templates:save', (_e, input: TemplateInput) => templateStore.save(input))
  ipcMain.handle('templates:delete', (_e, id: string) => templateStore.delete(id))

  // ── MCP 服务：配置变更后整体 apply（没变的连接不动，只改免确认也不重连）──
  ipcMain.handle('mcp:list', () => mcpStore.list())
  ipcMain.handle('mcp:status', () => mcp.status())
  ipcMain.handle('mcp:save', (_e, input: McpServerInput) => { const r = mcpStore.save(input); void applyMcp(); return r })
  ipcMain.handle('mcp:delete', (_e, id: string) => { mcpStore.delete(id); void applyMcp() })
  ipcMain.handle('mcp:setAutoApprove', (_e, id: string, tools: string[]) => { mcpStore.setAutoApprove(id, tools); void applyMcp() })
  ipcMain.handle('mcp:test', async (_e, input: McpServerInput) => {
    try { return { ok: true, tools: await mcp.test(mcpStore.merge(input)) } }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
  })
  return { controller, openTerminal, mcp, decideApproval }
}
