// AppClient 的AI：会话与对话、授权、执行记录、用量、MCP、模板、Skills、附件、知识库、安全规则、改动汇总与回滚。主进程注册见 apps/desktop/src/main/ai/register.ts，渲染层实现见 apps/ui/src/client/transports/ipc/ai.ts
import type { SessionInfo, SessionMeta, ApprovalAnswer, AuthLevel, TrustLevel, AuditEntry, McpServerSummary, McpServerInput, McpServerStatus, McpToolInfo } from '../types.js'
import type { PromptTemplate, TemplateInput } from '../../ops/index.js'
import type { NlCommandRequest } from '../../terminal/index.js'
import type { UsageRange, UsageSummary, UsageTotals, UsageCurrency, UsagePrices } from '../../ai/index.js'

export interface AiApi {
  agent: {
    createSession(opts?: { title?: string }): Promise<SessionInfo>
    listSessions(): Promise<SessionInfo[]>
    sendTurn(sessionId: string, prompt: string): Promise<void>
    interruptTurn(sessionId: string): Promise<void>   // Phase 5：用户主动中断当前 turn
    // 回合进行中追问：当前步骤结束、模型下一次请求前插进对话（dsh steering）；返回消息 id（被接纳时 user_message 的 itemId 就是它）
    steer(sessionId: string, prompt: string, attachments?: import('../../ai/index.js').TurnAttachment[]): Promise<string>
    // 撤回还没插入的追问；已插入 / 已清掉返回 false
    unsteer(sessionId: string, messageId: string): Promise<boolean>
    // Phase 4 多会话：持久化会话列表 + 重连/删除/重命名
    listPersisted(): Promise<SessionMeta[]>
    reconnectSession(sessionId: string): Promise<SessionInfo>
    deleteSession(sessionId: string): Promise<void>
    renameSession(sessionId: string, title: string): Promise<void>
    // 全文搜索历史会话（用户消息 / AI 回复 / 执行过的命令），返回命中的会话与片段
    search(query: string): Promise<{ sessionId: string; snippet: string }[]>
    setWorkDir(sessionId: string, workDir: string): Promise<void>   // 绑定工作目录，重启会话应用
    // 上下文重置：作废旧 thread 换一个空的（保留 workspace/授权），seed 作为新上下文的首条消息发出
    resetContext(sessionId: string, seed?: string): Promise<void>
    // 终端里自然语言写命令：用当前模型一次性生成一条命令（不建会话、不带工具、不带终端内容）。失败抛错（中文原因）
    suggestCommand(req: NlCommandRequest): Promise<string>
    // 从某条用户消息（messageId = 界面上该消息的服务端 id）之前分叉：fork = 新会话「原标题（分叉）」，原会话保留；
    // regenerate = 本会话原地重跑这条消息（切点前的历史回放给界面）。回合进行中抛 turn_in_progress。text = 该消息原话
    forkSession(sessionId: string, messageId: string, mode: 'fork' | 'regenerate'): Promise<{ session: SessionInfo; text: string }>
  }
  // 授权按 hostKey（'local' | hostId | 'host:port'）记录：同主机所有终端共享一份授权
  auth: {
    decide(approvalId: string, ans: ApprovalAnswer): Promise<void>
    listForSession(sessionId: string): Promise<{ hostKey: string; level: AuthLevel }[]>
    grant(sessionId: string, hostKey: string, level: AuthLevel): Promise<void>
    revoke(sessionId: string, hostKey: string): Promise<void>
    getTrust(sessionId: string): Promise<TrustLevel>
    setTrust(sessionId: string, level: TrustLevel): Promise<void>
  }
  // AI 在终端上的执行记录（新在前）
  audit: {
    listForSession(sessionId: string): Promise<AuditEntry[]>
    listRecent(): Promise<AuditEntry[]>   // 所有会话的最近记录，新在前
    // 用某条记录（按 sessionId + at 定位）的 backupPath 覆盖回 filePath；覆盖前同样先备份，还原本身也可再还原
    restore(sessionId: string, at: string): Promise<void>
  }
  // 常用任务模板（内置模板首次启动写入，之后可改可删）
  templates: {
    list(): Promise<PromptTemplate[]>
    save(input: TemplateInput): Promise<PromptTemplate>
    delete(id: string): Promise<void>
  }
  // MCP 服务：env/headers 加密存储，读取只给键名。保存/删除/改免确认后主进程按新配置重连并重新注册工具
  mcp: {
    list(): Promise<McpServerSummary[]>
    save(input: McpServerInput): Promise<McpServerSummary>
    delete(id: string): Promise<void>
    status(): Promise<McpServerStatus[]>
    // 连接测试：按表单临时连一次、列出工具后断开（不注册给 AI）
    test(input: McpServerInput): Promise<{ ok: boolean; error?: string; tools?: McpToolInfo[] }>
    setAutoApprove(id: string, tools: string[]): Promise<void>
  }
  // 用量统计：每次模型请求的 tokens（usage.jsonl），花费按用户填的单价估算（没填不算钱）
  usage: {
    summary(range: UsageRange): Promise<UsageSummary>
    session(sessionId: string): Promise<UsageTotals & { currency: UsageCurrency }>   // 聊天头部「本会话 tokens」
    getPrices(): Promise<UsagePrices>
    savePrices(prices: UsagePrices): Promise<UsagePrices>
  }
  // 多模型配置（设置 → 模型设置；配置本身随 settings.get/save 读写，见 desktop/main/ai/modelProfilesIpc.ts）：
  // test 只在用户点「测试连接」时调（表单没填 Key 用已存的，Key 不回渲染层）；
  // 会话级切换模型：setSessionModel 空闲时立即生效、回合进行中返回 pending（下一回合生效）；profileId 空 = 跟随默认配置
  modelProfiles: {
    test(profile: import('../types.js').ModelProfile): Promise<import('../types.js').ModelTestResult>
    sessionModel(sessionId: string): Promise<{ profileId?: string; pending: boolean }>
    setSessionModel(sessionId: string, profileId?: string): Promise<{ pending: boolean }>
  }
  // Skills（设置 → Skills，见 desktop/main/ai/skillsIpc.ts）：<数据目录>/skills/<name>/SKILL.md。改动后立即生效（无需重启）。
  // 导入两步走：pickImport / inspect 暂存校验并返回预览（取消选择返回 null）→ 用户确认 commitImport（重名时 overwrite 或 rename）
  skills: {
    list(): Promise<import('../types.js').SkillInfo[]>
    read(name: string): Promise<import('../types.js').SkillInput>
    save(input: import('../types.js').SkillInput, oldName?: string): Promise<void>
    remove(name: string): Promise<void>
    setFlags(name: string, flags: { enabled?: boolean; modelInvocable?: boolean }): Promise<void>
    pickImport(kind: 'folder' | 'file'): Promise<import('../types.js').SkillImportPreview | null>
    inspect(path: string): Promise<import('../types.js').SkillImportPreview>
    commitImport(token: string, opts?: { overwrite?: boolean; rename?: string }): Promise<string>
    cancelImport(token: string): Promise<void>
    openDir(): Promise<void>
  }
  // AI 对话附件（输入框「+」菜单 / 粘贴 / 拖入，见 desktop/main/ai/attachIpc.ts）。pick* 取消返回 []；
  // pickImages 只返回路径；kinds 区分文件 / 目录 / 图片文件（扩展名 + 文件头）；imageFile 读图片文件为 data URL（svg 为 image/svg+xml，非图片 null）；
  // clipboardPaths 读系统剪贴板里复制的文件（粘贴兜底）；send 带附件发一轮（文件 / 目录只发路径，图片要当前模型配置开了「支持图片」）；
  // image 按存档 id 取图片副本（历史回放的缩略图 / 大图）；open 用系统程序打开文件 / 在资源管理器打开目录（不存在时返回原因）
  attachments: {
    pickFiles(): Promise<string[]>
    pickDirs(): Promise<string[]>
    pickImages(): Promise<string[]>
    kinds(paths: string[]): Promise<('file' | 'dir' | 'image' | null)[]>
    imageFile(path: string): Promise<string | null>
    clipboardPaths(): Promise<string[]>
    send(sessionId: string, prompt: string, attachments: import('../../ai/index.js').TurnAttachment[]): Promise<void>
    image(id: string): Promise<string | null>
    open(path: string): Promise<string | null>
  }
  // 回合末改动汇总 / 按回合撤销（见 desktop/main/ai/turnUndo.ts）：数据全来自执行记录。keys 缺省 = 本轮全部文件。
  // check 撤销前查文件是否已被后续改动覆盖；diff 是本轮之前 → 当前；undo 逆序逐个撤销、逐个返回结果
  turnChanges: {
    list(sessionId: string): Promise<import('../../ai/index.js').TurnChanges[]>
    check(sessionId: string, turnId: string, keys?: string[]): Promise<import('../../ai/index.js').TurnFileCheck[]>
    diff(sessionId: string, turnId: string, key: string): Promise<{ diff: string; state: import('../../ai/index.js').TurnFileState }>
    undo(sessionId: string, turnId: string, keys?: string[]): Promise<import('../../ai/index.js').TurnUndoResult[]>
  }
  // 一键回滚（见 desktop/main/ai/rollbackIpc.ts）：按执行记录（sessionId + at）取 AI 给的回滚命令。
  // check 只检查不执行（确认框展示）；run 经同主机终端执行，危险命令须 ackDanger，结果记一条 decision=rollback
  rollback: {
    check(sessionId: string, at: string): Promise<import('../../ai/index.js').RollbackCheck>
    run(sessionId: string, at: string, ackDanger: boolean): Promise<import('../../ai/index.js').RollbackResult>
  }
  // 主机知识库（见 desktop/main/ai/knowledgeIpc.ts）：list 前先把旧「主机备注」同步成卡片；save 新增 / 更新（id 有值 = 更新）
  knowledge: {
    list(): Promise<import('../../ai/index.js').KnowledgeCard[]>
    save(input: import('../../ai/index.js').KnowledgeInput): Promise<import('../../ai/index.js').KnowledgeCard>
    remove(id: string): Promise<void>
  }
  // 左侧对话增强（见 desktop/main/ai/chatPlusIpc.ts）：digest 历史会话摘要（@ 引用）；search 跨会话全文检索；
  // runShell 输入框 `!命令` 在终端里执行并取回结果（输出已按脱敏设置处理、只留末尾 4KB）；answerAsk 回答 AI 提问卡（null = 跳过）
  chatPlus: {
    digest(sessionId: string): Promise<string>
    search(query: string): Promise<import('../../ai/index.js').ChatSearchHit[]>
    runShell(terminalId: string, command: string, sessionId?: string): Promise<{ exitCode: number; output: string; truncated: boolean; terminal: string }>
    answerAsk(askId: string, answer: import('../../ai/index.js').AskAnswer | null): Promise<void>
  }
  // AI 与终端联动（见 desktop/main/ai/aiLinkIpc.ts）：预测下一条命令（无 API / 拿不准返回空串）；录像 AI 摘要（存录像旁 .summary.json，没有时 summary 返回 null）
  aiLink: {
    predictCommand(req: import('../../ai/index.js').PredictRequest): Promise<string>
    summarizeRecording(id: string): Promise<import('../../ai/index.js').RecordingSummary>
    recordingSummary(id: string): Promise<import('../../ai/index.js').RecordingSummary | null>
  }
  // 安全与流程（见 desktop/main/ai/safetyIpc.ts、shared/ai/safety.ts）：
  // rules 分组 / 主机规则（整份读，按项写，text 空 = 删除）；preview 会话级预演模式（只说不做），approvePlan 关掉预演并把勾选的步骤记为已批准计划；
  // sudo 本会话的限时提权（只在内存，重启即失效），revokeSudo 立即收回
  safety: {
    rules(): Promise<import('../../ai/index.js').LayerRules>
    setGroupRules(group: string, text: string): Promise<void>
    setHostRules(hostId: string, text: string): Promise<void>
    preview(sessionId: string): Promise<boolean>
    setPreview(sessionId: string, on: boolean): Promise<void>
    approvePlan(sessionId: string, steps: import('../types.js').PlanStep[]): Promise<void>
    sudoLeases(sessionId: string): Promise<import('../../ai/index.js').SudoLease[]>
    revokeSudo(sessionId: string, hostKey: string): Promise<void>
  }
}
