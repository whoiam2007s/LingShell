// 后端推给前端的事件（IPC / 未来 WebSocket 同构）

import type { RiskLevel, PromptReason, TerminalInfo, PlanStepView, HostKeyInfo, McpServerStatus, TermOs, SshAuthPromptInfo } from './types.js'
import type { InspectionRun } from '../ops/index.js'
import type { HostStats } from '../terminal/index.js'

export type TerminalDataEvent = { type: 'terminal:data'; terminalId: string; chunk: string }
export type TerminalCreatedEvent = { type: 'terminal:created'; info: TerminalInfo }
export type TerminalLockedEvent = { type: 'terminal:locked'; terminalId: string; locked: boolean }
export type TerminalStatusEvent = {
  type: 'terminal:status'
  terminalId: string
  status: 'running' | 'disconnected'
  reason?: string
  os?: TermOs                  // 重连成功后重新探测的系统
}
// 终端开始 / 停止录像（用户在终端上手动点；关掉系统设置里的录屏功能时会全部停止）
export type TerminalRecordingEvent = { type: 'terminal:recording'; terminalId: string; recording: boolean }
// 自动应答已发送（rule = 规则名）；disabled = 触发过多已在该终端停用（这次没发）
export type TerminalAutoReplyEvent = { type: 'terminal:autoReply'; terminalId: string; rule: string; disabled?: boolean }
// 主机状态采集结果：stats = 新样本；error = 本次失败（UI 保留旧样本标灰）；unsupported = 该系统不支持；三者都无 = 清空（采集已关/不再采该终端）
export type HostStatsEvent = { type: 'terminal:hostStats'; terminalId: string; stats?: HostStats; error?: string; unsupported?: boolean }

// ── Agent 工作流事件（防腐层：由 dsh-controller/relay 从 DeepSeek Harness 的 session 事件翻译而来）──

// item 种类（归一为 UI 关心的类别）
export type ItemKind =
  | 'user_message'      // 用户消息
  | 'agent_message'     // AI 回复文本
  | 'agent_reasoning'   // AI 思考过程
  | 'tool_call'         // 工具调用（command_execution / file_change 等）
  | 'todo'              // 任务清单（checklist_write）
  | 'auth_request'      // Phase 3：授权请求卡片
  | 'plan_request'      // 计划审批卡片（propose_plan）
  | 'host_note'         // AI 提议沉淀到知识库的卡片（propose_host_knowledge）
  | 'system_notice'     // 系统提示（不属于任何一轮，如「历史无法恢复，已开新的空会话」）
  | 'ask_request'       // AI 提问卡（ask_user）：让用户在几个方案里拍板

export type ItemStatus = 'in_progress' | 'completed' | 'failed'

export interface TodoItem { id: number | string; content: string; status: 'pending' | 'in_progress' | 'completed' }

// 工具调用的结构化信息
export interface ToolCallInfo {
  toolId: string
  name: string                 // exec_in_terminal / read_terminal / upload_file / ...
  input?: unknown              // 工具参数
  output?: string              // 执行结果/输出（completed/failed 后）
}

// turn 生命周期
export type TurnStartedEvent = { type: 'agent:turnStarted'; sessionId: string; turnId: string }
export type TurnCompletedEvent = { type: 'agent:turnCompleted'; sessionId: string; turnId: string }
// stopped = 用户主动停止（不算出错，不发「AI 出错」通知）
export type TurnFailedEvent = { type: 'agent:turnFailed'; sessionId: string; turnId: string; error: string; stopped?: boolean }

// item 生命周期：started（出现）→ delta（流式追加文本）→ updated/completed/failed
export type ItemStartedEvent = {
  type: 'agent:itemStarted'
  sessionId: string; turnId: string; itemId: string
  kind: ItemKind
  status: ItemStatus
  tool?: ToolCallInfo          // kind=tool_call 时
  at?: number                  // 事件时间（epoch ms，dsh 事件自带；拿不到不给）。工具 = 在模型流式输出里识别到它的时刻（拿不到退回 tool/call 时间）
  phase?: 'preparing'          // 工具：模型还在生成参数（只有名字、没有 input）；之后同 itemId 的 itemStarted 不带它 = 参数完整、开始执行
  callAt?: number              // 工具：参数生成完、开始执行的时刻（tool/call 事件时间）
}
export type ItemDeltaEvent = {
  type: 'agent:itemDelta'
  sessionId: string; turnId: string; itemId: string
  kind: ItemKind               // agent_message / agent_reasoning
  text: string                 // 增量文本
  at?: number
}
export type ItemUpdatedEvent = {
  type: 'agent:itemUpdated'
  sessionId: string; turnId: string; itemId: string
  kind: ItemKind
  status: ItemStatus
  text?: string                // 完整文本（completed 时）
  tool?: ToolCallInfo          // 工具结果
  todos?: TodoItem[]           // kind=todo 时的清单
  completionPct?: number       // todo 进度
  error?: string               // failed 时
  at?: number                  // 事件时间：工具结果 = 工具结束时间
  attachments?: import('../ai/index.js').MsgAttachment[]   // user_message 带的附件（文件 / 目录路径、图片）
  steered?: boolean            // user_message：本轮中途插入的追问（同一轮里第二条起的用户消息）
}

// 上下文超过水位线 → dsh 自动压缩（较早历史摘要成检查点，任务不中断）：开始 / 结束（error 有值 = 压缩失败）
export type ContextCompactingEvent = { type: 'agent:contextCompacting'; sessionId: string }
export type ContextCompactedEvent = { type: 'agent:contextCompacted'; sessionId: string; error?: string }
// 会话步数已多、且已压缩过：建议用压缩摘要开新会话（不暂停，用户可忽略继续）
export type ResetSuggestedEvent = {
  type: 'agent:resetSuggested'; sessionId: string; steps: number; compactions: number; summary: string
}

// 上下文用量（每次模型请求后更新；重连时按历史最后一次请求给出）。limit=0 表示未设上限
export type ContextUsageEvent = {
  type: 'agent:contextUsage'; sessionId: string; inputTokens: number; limit: number
}

// 重连时会话历史读不回来（如 dsh 升级后旧日志迁移被拒且修不了）：已换成新的空会话继续用。
// reason = 原因摘要；path = 原记录（未改动）所在位置。UI 在对话区出一条系统提示
export type HistoryUnrecoverableEvent = {
  type: 'agent:historyUnrecoverable'; sessionId: string; reason: string; path?: string
}

// 一轮的时间点（epoch ms，只带已知的字段）：开始 / 模型首次返回 / 结束。实时与历史回放都发（回放不发 turnStarted/Completed，只发它）。
// firstAt 不在 dsh 日志里（流式帧不落盘），由主进程补记到侧车文件，回放时取回；旧会话没有就不给
export type TurnTimingEvent = { type: 'agent:turnTiming'; sessionId: string; turnId: string; startedAt?: number; firstAt?: number; endedAt?: number }

export type AgentEvent =
  | TurnStartedEvent | TurnCompletedEvent | TurnFailedEvent
  | ItemStartedEvent | ItemDeltaEvent | ItemUpdatedEvent
  | ContextCompactingEvent | ContextCompactedEvent | ResetSuggestedEvent | ContextUsageEvent
  | HistoryUnrecoverableEvent
  | TurnTimingEvent

export type AuthRequestEvent = {
  type: 'auth:request'
  approvalId: string
  sessionId: string
  terminalId: string
  needed: 'read' | 'write'
  reason: PromptReason
  risk: RiskLevel
  tool: string                 // 发起的工具名；exec_in_terminal 的命令可在卡片上改
  command?: string
  diff?: string                // write_file：unified diff（原文 → 新内容），卡片上展示它
  explain?: string             // AI 对命令的通俗说明（可能缺），卡片上显示在命令上方
  targets?: ApprovalTarget[]   // exec_on_terminals：同一条命令要在这些终端上执行（一张卡批全部）
  mcp?: McpCallView            // MCP 工具调用：卡片展示服务、工具、参数 JSON
  deadlineMs: number
  rule?: string                // 命中的命令规则（「总是询问」等），卡片上注明「按规则：…」
  rollback?: string            // exec_in_terminal：AI 给的回滚命令，卡片上与「执行」并排
  rollbackNote?: string        // 回滚说明（为什么这样回滚 / 「不可回滚」及原因）
  rollbackMissing?: boolean    // 变更命令却没给回滚方案：卡片标黄「AI 未提供回滚方案」
  review?: import('../ai/index.js').AiReviewResult   // AI 复核结果：卡片上显示「AI 复核：风险 · 理由」
  sudo?: boolean               // 需要 root 的命令：卡片上可选「本主机 N 分钟内允许提权」
}

// MCP 调用授权卡的展示数据：args 是格式化好的参数 JSON（已截断）
export interface McpCallView { server: string; tool: string; args: string }

// 多主机授权卡的一项：终端 id + 授权粒度 hostKey + 给人看的名字（终端标题）
export interface ApprovalTarget { terminalId: string; hostKey: string; label: string }

// 计划审批卡（propose_plan）。用户决定走 auth.decide(approvalId, { steps })，结束同样发 auth:resolved
export type PlanRequestEvent = {
  type: 'plan:request'
  approvalId: string
  sessionId: string
  title: string
  steps: PlanStepView[]
  deadlineMs: number
}

export type AuthResolvedEvent = {
  type: 'auth:resolved'
  approvalId: string
  result: 'allow' | 'deny' | 'timeout'
}

// AI 调 propose_host_knowledge：不直接写，UI 在时间线出卡片（可改），用户点「保存」才经 knowledge.save 写入
export type KnowledgeProposalEvent = {
  type: 'knowledge:proposal'
  proposalId: string
  sessionId: string
  draft: import('../ai/index.js').KnowledgeInput   // id 有值 = 更新已有卡片
  targetLabel: string                              // 归属给人看：主机「web-1」/ 分组「web」/ 全局
  previous?: { title: string; content: string }    // 更新时的原卡内容（卡片上对照）
}

// ── 阶段三：资源上传/下载进度 ────────────────────────────
export type TransferProgressEvent = {
  type: 'transfer:progress'
  taskId: string
  kind: 'upload' | 'download'
  files: string[]
  stage: 'pack' | 'transfer' | 'extract' | 'done' | 'error'
  stagePercent: number     // 0-100；脉冲阶段可为 -1 表示不确定
  overallPercent: number   // 0-100
  error?: string
  // 目录/多文件下载：已完成/总文件数；cancellable 时浮层给「取消」（transfer.cancel(taskId)）
  fileDone?: number
  fileTotal?: number
  cancellable?: boolean
  // ── 传输队列 ──
  state: TransferState
  target?: string          // 目标位置（展示用）：user@host:/dir 或本地目录
  reveal?: TransferReveal  // 完成后可定位的位置
  bytesDone?: number
  bytesTotal?: number
  speed?: number           // 字节/秒（平滑后）
  etaSec?: number          // 剩余时间估算（秒），算不出时缺省
  createdAt: number
  queuePos?: number        // 排队中：在等待队列里的位置（1 = 下一个开始）
  resumable?: boolean      // 逐个文件直传的任务：可暂停，「继续」从断点接着传（.lingshell-part 临时文件）
  paused?: boolean         // 已暂停（state 为 cancelled）：可「继续」或「放弃」（删掉半截文件）
  restored?: boolean       // 上次运行留下的历史记录（只读，不能重试）
  skipped?: number         // 同名跳过的项数
}
export type TransferState = 'queued' | 'running' | 'done' | 'error' | 'cancelled'
// 调整排队顺序：top = 优先传输（移到队首），up / down 移一位
export type TransferMove = 'top' | 'up' | 'down'
// 本地：打开所在文件夹并选中；远程（仅已保存主机）：在资源管理器中定位到该目录
export type TransferReveal = { local: string } | { hostId: string; path: string }

// 端口转发状态被动变化（断线 → 重连中 → 恢复/停止）；UI 收到后重新 list（用户主动停止不发）
export type PortForwardChangedEvent = { type: 'portForward:changed'; id: string }
// ── 定时巡检：运行记录变化（开跑/结束）；点系统通知 → 让 UI 打开该巡检会话 ──
export type InspectionRunEvent = { type: 'inspection:run'; run: InspectionRun }
export type InspectionOpenSessionEvent = { type: 'inspection:openSession'; sessionId: string }

// ── SSH 主机指纹 ──
// 首次连接未知主机：等用户 knownHosts.decide(requestId, trust)；超时/已决发 hostKey:resolved 让 UI 关弹窗
export type HostKeyUnknownEvent = { type: 'hostKey:unknown'; requestId: string; info: HostKeyInfo; deadlineMs: number }
export type HostKeyResolvedEvent = { type: 'hostKey:resolved'; requestId: string }
// 指纹与记录不符，连接已拒绝（可能中间人攻击）。UI 醒目告警，用户确认换钥后 knownHosts.acceptChanged(hostPort)
export type HostKeyMismatchEvent = { type: 'hostKey:mismatch'; info: HostKeyInfo }

// MCP 服务连接状态变化（连接中/已连/失败/工具列表），设置页实时刷新
export type McpStatusEvent = { type: 'mcp:status'; servers: McpServerStatus[] }

// ── 自动更新 ──
// disabled = 未配置更新源（或开发模式），updater 完全不启用、不联网
export type UpdateState = 'disabled' | 'checking' | 'none' | 'available' | 'downloading' | 'downloaded' | 'error'
export interface UpdateStatus { state: UpdateState; version?: string; percent?: number; error?: string }
export type UpdateStatusEvent = { type: 'update:status' } & UpdateStatus

// 应用锁状态变化（手动锁 / 空闲 / 系统锁屏 / 解锁）
export type AppLockEvent = { type: 'app:lock'; locked: boolean }

export type AppEvent =
  | UpdateStatusEvent
  | AppLockEvent
  | TerminalDataEvent | TerminalCreatedEvent | TerminalLockedEvent | TerminalStatusEvent | TerminalRecordingEvent | TerminalAutoReplyEvent | HostStatsEvent
  | AgentEvent
  | AuthRequestEvent | AuthResolvedEvent | PlanRequestEvent
  | KnowledgeProposalEvent
  | TransferProgressEvent
  | PortForwardChangedEvent
  | InspectionRunEvent | InspectionOpenSessionEvent
  | HostKeyUnknownEvent | HostKeyResolvedEvent | HostKeyMismatchEvent
  | McpStatusEvent
  | SshAuthPromptEvent | SshAuthResolvedEvent
  | SshUrlOpenEvent
  | WatchdogStateEvent
  | HostChangesEvent
  | AskRequestEvent | AskResolvedEvent
  | AppSummonEvent
  | SafetyChangedEvent
  | TrayActionEvent | WatchdogPausedEvent | BackgroundChangedEvent

// ssh:// 链接唤起（见 desktop/main/app/sshUrl.ts）：已在运行时由主进程推送；冷启动时 UI 挂载后用 sshUrl.takePending() 取
export type SshUrlOpenEvent = { type: 'sshUrl:open'; target: import('../terminal/index.js').SshUrlTarget }

// SSH keyboard-interactive（OTP / 堡垒机）：等用户 sshAuth.answer(requestId, answers)；超时/已决发 sshAuth:resolved 关弹窗
export type SshAuthPromptEvent = { type: 'sshAuth:prompt'; requestId: string; info: SshAuthPromptInfo; deadlineMs: number }
export type SshAuthResolvedEvent = { type: 'sshAuth:resolved'; requestId: string }

// 看门狗状态变化（每次检查后）：设置 → 定时巡检里的看门狗列表实时刷新
export type WatchdogStateEvent = { type: 'watchdog:state'; state: import('../ops/index.js').WatchdogState }
// AI 一轮结束后的主机变更报告已生成（见 desktop/main/ops/hostCheck.ts）：对话里该轮末尾刷新「本轮主机变化」
export type HostChangesEvent = { type: 'hostChanges:turn'; sessionId: string; turnId: string }
// AI 调 ask_user：对话里出提问卡，用户 chatPlus.answerAsk(askId, answer | null) 回答；回答 / 跳过 / 超时都发 ask:resolved 收卡
export type AskRequestEvent = { type: 'ask:request'; askId: string; deadlineMs: number } & import('../ai/index.js').AskRequest
export type AskResolvedEvent = { type: 'ask:resolved'; askId: string; result: 'answered' | 'skipped' | 'timeout'; answer?: import('../ai/index.js').AskAnswer }
// 连按两下 Alt 呼出（见 desktop/main/app/globalHotkey.ts）：窗口被热键唤到前台，UI 把焦点交给当前终端（锁定中不发）
export type AppSummonEvent = { type: 'app:summon' }
// 安全与流程（见 safety.ts）：会话的预演模式开关 / 限时提权（授予、收回、到期）变化，界面据此刷新
export type SafetyChangedEvent = { type: 'safety:changed'; sessionId: string; what: 'preview' | 'sudo' }
// 托盘 / 悬浮球菜单的动作：主进程已把主窗口显示出来，界面接着做（新建会话 / 连主机 / 开仪表盘…，见 desktop/main/app/background.ts）
export type TrayActionEvent = { type: 'tray:action'; action: import('../ui/index.js').TrayUiAction }
// 看门狗全局暂停状态变化（设置页 / 托盘 / 悬浮球任一处切换）
export type WatchdogPausedEvent = { type: 'watchdog:paused'; paused: boolean }
// 托盘 / 悬浮球改了启动与后台的开关（悬浮球、透明度等）：设置页的开关跟着变，不显示旧状态
export type BackgroundChangedEvent = { type: 'background:changed'; status: import('../ui/index.js').BackgroundStatus }
