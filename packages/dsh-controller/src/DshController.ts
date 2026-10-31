/* eslint-disable @typescript-eslint/no-explicit-any */
// DeepSeek Harness 版控制器（apps/desktop/src/main/ipc.ts 装配）。
//
// 与旧 CodeWhale 版最大的结构差别：dsh 是**进程内库**，不是外部二进制。
// 于是下面这些整类问题直接不存在，全部删除：
//   SessionProcess（spawn/健康检查）、binary.ts（定位二进制）、portSeq（端口分配）、
//   maxLiveSessions LRU 进程池、idle 看门狗 + 僵尸进程硬重启、mcp.json/config.toml 落盘。
// 一个 Cordis Context 装 N 个 agent，会话切换就是切 agent，没有进程可起可杀。
// 内存里最多留 MAX_LIVE_SESSIONS 个 agent（LRU 释放空闲的，再用时从磁盘日志恢复）。
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve, dirname, sep } from 'node:path'
import { rm } from 'node:fs/promises'
import type { SessionInfo, AgentEvent, SessionMeta, ApprovalAnswer, ApprovalTarget, McpCallView, TrustLevel, ModelProtocol } from '@lingshell/shared'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SessionStore, { buildForkSeed } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, assertUsableApiKey } from '@deepseek-ai/dsh-llm'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
// 0.2.1 起不再 default 导出类，模块命名空间本身就是插件（name/Config/apply）
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { StaticWorkingDirectory } from './workingDirectory.js'
import * as deepseek from '@deepseek-ai/dsh-llm-deepseek'
import * as piAi from '@deepseek-ai/dsh-llm-pi-ai'
import { contextWindowOf, providerMeta, tr } from '@lingshell/shared'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import type { LocalSkills } from './skills.js'
import * as LlmRetry from '@deepseek-ai/dsh-llm-retry'
import { createRelay, createStreamAdapter, contextTokensOf, requestUsageOf, searchableTexts, type DshEvent } from './relay.js'
import {
  terminalToolDefs, decideFor, commitGrant, neededForCall, describeCall, approvalView, targetTerminalsOf, planWrite, explainOf, EXPLAIN_GUIDANCE, rollbackDeny, hostsTouchedBy, fleetTargetsOf,
  type TerminalToolDeps, type UserOverride,
} from './terminalTools.js'
import { unifiedDiff } from './diff.js'
import { PlanBook, planDecision, planToolDef, sanitizeSteps, PLAN_GUIDANCE, type PlanRequest } from './plan.js'
import { installPromptSection, installTerminalsSection, installWorkDirSection, installKnowledgeSection, installFleetSection, installLanguageSection } from './prompt.js'
import { compactionConfig, effectiveLimit, DEEPSEEK_WINDOW, type CompactTarget } from './compaction.js'
import { routeOf, keyEnvOf, usesPiAi, withRoute, deepseekBaseOf, NO_KEY_PLACEHOLDER, type PiRoute } from './providers.js'
import { mcpDecision, mcpArgsView, stripExplain, MCP_GUIDANCE, type McpManager, type McpToolRef } from './mcp.js'
import { withRedaction, placeholderError, REDACT_GUIDANCE } from './redaction.js'
import { secretError } from './secretVault.js'
import { repairLegacyLog, failureSummary } from './legacyRepair.js'
import { TurnTimesStore } from './turnTimes.js'
import { LocalImageStore, readStoredImage } from './attachments.js'
import { withPathsBlock, withContextBlocks, type TurnAttachment, type ContextAttachment, type AskRequest, type AskAnswer, type ChatSearchDoc } from '@lingshell/shared'
import { askUserToolDef, ASK_GUIDANCE } from './askUser.js'
import { searchDocs, sessionDigest } from './chatIndex.js'
import { deepseekModels } from './providers.js'
import { forkPoint, forkTitle } from './fork.js'
import { installRulesSection, previewBlocks, previewBlocksMcp, recentContext, PREVIEW_DENY, PREVIEW_GUIDANCE } from './safety.js'
import type { AiReviewResult, AiReviewAction, PlanStep } from '@lingshell/shared'

/** AI 复核请求（弹授权卡前，见 DshControllerConfig.reviewCommand） */
export interface ReviewRequest {
  sessionId: string; tool: string; hostKeys: string[]
  command: string; diff?: string; explain?: string; rollback?: string
  reason: string; risk: 'safe' | 'dangerous'
  context: string           // 会话最近上下文摘要
}
// 会复核的工具：exec 类命令与写文件（读类、上传下载、MCP 不复核）
const REVIEW_TOOLS = new Set(['exec_in_terminal', 'exec_on_terminals', 'start_background', 'write_file'])

// 分叉出的新 dsh 会话的种子：源日志前缀（到 boundary 含）+ dsh 的继承标记
interface ForkSeed { seed: unknown[]; inherited: number; parent: string }

export type LogFn = (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void

export interface ApprovalRequest {
  sessionId: string; terminalId: string
  needed: 'read' | 'write'
  reason: 'first_access' | 'elevation' | 'dangerous_command'
  risk: 'safe' | 'dangerous'
  tool: string
  command?: string
  diff?: string     // write_file：原文 → 新内容的 unified diff，授权卡上代替命令展示
  explain?: string  // 模型给的命令说明（exec 类），卡片上显示在命令上方
  targets?: ApprovalTarget[]   // exec_on_terminals：一张卡列出全部目标主机
  mcp?: McpCallView            // MCP 工具调用：服务 / 工具 / 参数 JSON
  rule?: string                // 命中的命令规则描述（卡片上注明「按规则：…」）
  rollback?: string            // exec_in_terminal：AI 给的回滚命令（卡片上与执行命令并排）
  rollbackNote?: string        // 回滚说明
  rollbackMissing?: boolean    // 变更命令却没给回滚方案（非生产照常执行，卡片标黄提醒）
  review?: AiReviewResult      // AI 复核结果（卡片上显示「AI 复核：风险 · 理由」）
}

export interface DshControllerConfig extends TerminalToolDeps {
  baseDir: string                       // 会话数据根目录（jsonl 持久化落在其下）
  // 取一套模型配置（profileId 缺省 / 找不到 = 默认配置；返回的 profileId 是实际用的那套）。
  // 建/重连会话、每回合开始、一次性调用时现读，改了配置下一回合即生效（key/baseUrl 见 applySettings）
  // contextWindow：用户覆盖的上下文窗口（0/缺省 = 按 provider/模型自动）
  // protocol：接口协议（缺省按 protocolOf：DeepSeek = anthropic，其它 = openai）；切协议 = 换路由，下一回合生效
  // multimodal：这套配置开了「支持图片」（附图片的消息只在开了时才发；路由按它声明模型的输入模态）
  resolveSettings(profileId?: string): { profileId?: string; provider: string; model: string; apiKey: string; baseUrl: string; contextWindow?: number; protocol?: ModelProtocol; multimodal?: boolean }
  requestApproval(req: ApprovalRequest): Promise<ApprovalAnswer>
  // 计划审批卡（propose_plan）；缺省则该工具报不可用
  requestPlan?(req: PlanRequest): Promise<ApprovalAnswer>
  // AI 提问卡（ask_user）：等用户回答，null = 没回答（超时 / 跳过 / signal 中止）；缺省则该工具报不可用
  requestAsk?(req: AskRequest, signal?: AbortSignal): Promise<AskAnswer | null>
  sessionStore?: {
    upsert(m: SessionMeta): void
    remove(id: string): void
    list(): SessionMeta[]
    touch(id: string, at: string): void
  }
  listTerminals?(): { id: string; title: string; type: string; os?: string }[]
  contextLimitTokens?(): number
  contextResetSteps?(): number
  // 全局自定义规则（系统设置），每次模型请求现读注入系统提示词
  customRules?(): string
  // 主机知识库：这些主机（hostKey）相关的知识卡注入文本（已截断），没有返回 ''。每次模型请求现求值
  hostKnowledge?(hostKeys: string[]): string
  // MCP：连接管理器（boot 时把已连上的服务工具注册进来）；授权要看会话信任档与是否无人值守巡检
  mcp?: McpManager
  trustOf?(sessionId: string): TrustLevel
  isUnattended?(sessionId: string): boolean
  // 每次模型请求的用量（实时事件才报，重连回放不报）→ 用量统计
  recordUsage?(u: { sessionId: string; provider: string; model: string; input: number; cacheRead: number; output: number; unattended?: boolean; source?: string }): void
  log?: LogFn
  // 分层规则（分组 → 主机 → 工作目录）：本会话用到过的主机 + 会话工作目录 → 注入文本（已截断），没有返回 ''。每次模型请求现求值
  layeredRules?(hostKeys: string[], workDir?: string): string
  // AI 复核：弹授权卡前调（主进程判断是否在范围内、调复核模型、按设置给出处理方式）；undefined = 不复核
  reviewCommand?(req: ReviewRequest): Promise<{ review: AiReviewResult; action: AiReviewAction } | undefined>
}

type Settings = ReturnType<DshControllerConfig['resolveSettings']>

interface Live {
  info: SessionInfo
  dshId: string           // 当前对应的 dsh 会话 id（首次返回时间侧车按它存）
  window: number         // 本会话模型的上下文窗口（进度条上限按它夹）
  provider: string        // 本会话当前生效的 provider / 模型（用量统计按它记）
  model: string
  profileId?: string      // 会话选的模型配置（缺省 = 默认配置）；回合进行中改了要等下一回合才生效
  applied?: string        // 当前生效的配置 id（= resolveSettings 实际用的那套）
  route: { provider: string; model: string }   // 当前生效的 dsh 路由，agent/request 每步按它改写
  handle: { agent: any; dispose(): Promise<void> }
  relay: (ev: DshEvent) => void
  ctxTokens: number
  steps: number           // 本会话（含重连回放的历史）执行过的模型步数
  compactions: number     // 已完成的自动压缩次数
  lastSummary?: string    // 最近一次压缩的摘要（建议开新会话时当交接总结）
  suggested?: boolean     // 已弹过「建议开新会话」，同一会话不再重复打扰
  lastUsed: number        // 最近使用时间（LRU 释放用）
  turning: boolean        // 有一轮正在跑
  turn?: unknown          // 正在跑的 dsh 轮次（turn/start 记、turn/end 清）：执行记录据此标 turnId（按回合撤销）
}

// 内存里最多保留的会话数；超出时释放最久没用且空闲（不在跑、无待授权）的。被释放的会话再用时自动从磁盘日志恢复。
export const MAX_LIVE_SESSIONS = 5

export class DshController {
  private ctx?: Context
  private booting?: Promise<Context>
  // DeepSeek 路由 → 地址（适配器的 options 每次请求现读它，改地址不用重新注册）
  private dsRoutes = new Map<string, { baseURL: string; model: string; multimodal: boolean }>()
  private get attachmentRoot(): string { return join(this.cfg.baseDir, 'attachments') }
  private piAiFiber?: { update(config: any): unknown }
  private piRoutes: Record<string, PiRoute> = {}
  private compactionFiber?: { update(config: any): unknown }
  private compactKey = ''
  private compactTargets: CompactTarget[] = []
  private keyEnvs = new Set<string>()
  private sessions = new Map<string, Live>()
  private starting = new Map<string, Promise<SessionInfo>>()
  private listeners = new Set<(ev: AgentEvent) => void>()
  private times: TurnTimesStore

  constructor(private cfg: DshControllerConfig) {
    this.times = new TurnTimesStore(cfg.baseDir ? join(cfg.baseDir, 'chat-times') : undefined)
    // 执行记录统一补上所属 dsh 会话与轮次（回合末改动汇总 / 按回合撤销据此聚合，见 shared/ai/turnChanges.ts）
    this.cfg = { ...cfg, audit: (rec) => cfg.audit({ ...rec, ...this.turnTag(rec.sessionId) }) }
  }
  private turnTag(sessionId: string): { dshId?: string; turnId?: string } {
    const live = this.sessions.get(sessionId)
    return live?.turn === undefined ? {} : { dshId: live.dshId, turnId: `turn_${live.turn}` }
  }
  /** 会话当前正在跑的轮（没在跑返回 undefined）：变更保险按轮记快照 */
  turnOf(sessionId: string): { dshId: string; turnId: string } | undefined {
    const t = this.turnTag(sessionId)
    return t.dshId && t.turnId ? { dshId: t.dshId, turnId: t.turnId } : undefined
  }

  onEvent(h: (ev: AgentEvent) => void): () => void { this.listeners.add(h); return () => this.listeners.delete(h) }
  private emit(ev: AgentEvent) { this.listeners.forEach((h) => h(ev)) }

  // ── 引导：整个应用一个 Context，懒启动 ─────────────────
  private boot(): Promise<Context> {
    if (this.ctx) return Promise.resolve(this.ctx)
    return this.booting ??= (async () => {
      const ctx = new Context()
      // Cordis 的注入是**静默等待**：缺依赖既不报错也不启动，服务就是 undefined。
      // ToolRuntime.inject=['systemPrompt']；AgentLoop.inject=['agents','sessions','llm','tools','systemPrompt']。
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(SessionStore)
      // 0.2 起 AgentLoop / TokenMeter / LlmRetry 都依赖会话投影服务（sessionProjections）
      await ctx.plugin(SessionProjections)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(ApprovalService)
      await ctx.plugin(ToolRuntime, { mode: 'native' })
      await ctx.plugin(JsonlPersistence as any, { root: join(this.cfg.baseDir, 'dsh-sessions') })
      // 图片附件存档（ctx.attachments）：用户消息里的图片块只存引用，适配器发请求时经它读字节（见 attachments.ts）
      await ctx.plugin(LocalImageStore as any, { root: this.attachmentRoot })
      // provider 适配器不是 default 导出——模块命名空间本身就是插件（导出 name/apply/inject）。
      // DeepSeek 不挂插件（它只能注册唯一路由），用到哪套配置由 applySettings 按配置注册适配器实例。
      // OpenAI 兼容端点（千问/Kimi/Ollama/自定义）：先空路由「休眠」挂载，用到哪套配置再由 applySettings 加路由
      this.piAiFiber = await ctx.plugin(piAi as any, { providers: {} })
      // 自动压缩：上下文超阈值时在步边界把较早历史摘要成检查点，任务不中断（模型侧真溢出也会自动压缩重试）。
      // pruner 先于压缩引擎加载：超大工具结果先剪掉，剪完够用就不用调模型写摘要
      await ctx.plugin(TokenMeter)
      await ctx.plugin(ToolResultPruner)
      const cc = compactionConfig(this.cfg.contextLimitTokens?.() ?? 0)
      this.compactKey = JSON.stringify(cc)
      this.compactionFiber = await ctx.plugin(BasicCompactionEngine, cc as any)
      await ctx.plugin(AgentLoop, { agents: [] })
      // Skills：ctx.skills 注册表 + 给模型的 skill 工具 / 会话技能目录 / 用户 `/名字` 显式调用注入（dsh-tool-skill）。
      // 技能来源是我们自己的本地库（见 skills.ts，attachSkills 时注册 provider）
      await ctx.plugin(SkillRegistry)
      // 0.2.1 起 ToolSkill 注入 workingDirectory，缺了会静默不启动（见 workingDirectory.ts）
      await ctx.plugin(StaticWorkingDirectory as any)
      await ctx.plugin(ToolSkill as any)
      this.registerSkillProvider(ctx)
      // 模型请求瞬时失败（限流 / 5xx / 超时 / 断流）在步边界自动重试（默认 5 次指数退避）；0.2 起 pi-ai 不再自带重试
      await ctx.plugin(LlmRetry as any)

      const deps: TerminalToolDeps & { isPreview(sid: string): boolean } = {
        ...this.cfg,
        sessionIdOf: (agentId) => this.dshToOurs.get(agentId) ?? agentId,
        takeUserOverride: (callId) => { const o = this.overrides.get(callId); this.overrides.delete(callId); return o },
        isPreview: (sid: string) => this.preview.has(sid),   // 预演模式：propose_plan 不弹审批，只出「方案步骤」
      }
      // 发给 AI 前脱敏：终端工具在 terminalToolDefs 里已包好；plan / MCP 在这里包（见 redaction.ts）
      const secrets = () => this.cfg.aiSecrets?.()
      const vault = this.cfg.secretVault
      const mask = vault ? (s: string) => vault.mask(s) : undefined   // 密钥保险箱明文回写（不受脱敏开关影响）
      for (const def of terminalToolDefs(deps)) ctx.tools.register(defineTool(def as any))
      ctx.tools.register(defineTool(withRedaction(planToolDef(deps, this.plans), secrets, undefined, mask) as any))
      ;(ctx as any).systemPrompt.section({ name: 'lingshell:plan', order: 150, text: PLAN_GUIDANCE })
      ;(ctx as any).systemPrompt.section({ name: 'lingshell:explain', order: 151, text: EXPLAIN_GUIDANCE })
      // 提问卡：需要用户在几个明确方案里拍板时用（见 askUser.ts）
      ctx.tools.register(defineTool(askUserToolDef({ requestAsk: this.cfg.requestAsk && ((r, s) => this.cfg.requestAsk!(r, s)), sessionIdOf: deps.sessionIdOf }) as any))
      ;(ctx as any).systemPrompt.section({ name: 'lingshell:ask', order: 155, text: ASK_GUIDANCE })
      // MCP 外部工具：已连上的立即注册，之后连上/重连/配置变更由管理器增删
      if (this.cfg.mcp) {
        ;(ctx as any).systemPrompt.section({ name: 'lingshell:mcp', order: 152, text: MCP_GUIDANCE })
        this.cfg.mcp.bind((def) => ctx.tools.register(withRedaction(def, secrets, undefined, mask)), (exec, ref, args, run) => this.mcpAround(exec, ref, args, run))
      }
      // 脱敏开着才告诉模型占位符的含义（每次请求现求值）
      ;(ctx as any).systemPrompt.section({ name: 'lingshell:redact', order: 153, text: () => (secrets() ? REDACT_GUIDANCE : '') })
      // 密钥保险箱：可用密钥的名称 / 说明 / 范围（没有值）。文本里有 {{secret:…}}，不能让 dsh 当模板插值
      if (vault) (ctx as any).systemPrompt.section({ name: 'lingshell:secrets', order: 154, interpolate: false, text: () => vault.prompt() })
      // 全局段：主机备注用法 + 用户自定义规则（每次组装现读，改设置不用重启会话）
      installPromptSection(ctx, () => this.cfg.customRules?.() ?? '')
      // 界面语言提示：英文界面才出现（中文界面为空段，提示词不变）
      installLanguageSection(ctx)
      installTerminalsSection(ctx, () => this.cfg.terminals.list().map((t) => {
        const cwd = this.cfg.terminalCwd?.(t.id)
        return { ...t, env: this.cfg.hostMeta?.(t.id)?.env, ...(cwd ? { cwd } : {}) }
      }))
      installWorkDirSection(ctx, (agentId) => this.getWorkDir(this.dshToOurs.get(agentId) ?? agentId))
      // 主机知识库（按会话：只注入本会话用到过的主机）+ 跨主机提问的用法与主机清单
      installKnowledgeSection(ctx, (agentId) => {
        const keys = this.touched.get(this.dshToOurs.get(agentId) ?? agentId)
        return keys?.size ? this.cfg.hostKnowledge?.([...keys]) ?? '' : ''
      })
      installFleetSection(ctx, () => this.cfg.fleetHosts?.() ?? [])
      // 分层规则（分组 / 主机按本会话用到过的主机，工作目录按会话绑定的目录）+ 预演模式的做法（只在开着时出现）
      installRulesSection(ctx, (agentId) => {
        const sid = this.dshToOurs.get(agentId) ?? agentId
        return this.cfg.layeredRules?.([...(this.touched.get(sid) ?? [])], this.getWorkDir(sid)) ?? ''
      })
      ;(ctx as any).systemPrompt.section({ name: 'lingshell:preview', order: 155, text: (c: any) => {
        const id = String(c?.agent?.id ?? '')
        return this.preview.has(this.dshToOurs.get(id) ?? id) ? PREVIEW_GUIDANCE : ''
      } })
      this.installAuthGate(ctx)
      this.ctx = ctx
      this.cfg.log?.('info', 'dsh runtime booted (in-process)')
      return ctx
    })().catch((e) => { this.booting = undefined; throw e })
  }

  // ── Skills：本地库接到 ctx.skills（boot 前后调用都行）；库里有改动 → 失效通知，下一步就用新目录，无需重启 ──
  private skills?: LocalSkills
  private skillInvalidate?: () => void
  attachSkills(s: LocalSkills): void {
    this.skills = s
    s.onChange(() => this.skillInvalidate?.())
    if (this.ctx) this.registerSkillProvider(this.ctx)
  }
  private registerSkillProvider(ctx: Context): void {
    if (!this.skills || this.skillInvalidate) return
    const p = this.skills.provider()
    ;(ctx as any).skills.registerProvider((control: { invalidate(): void }) => { this.skillInvalidate = () => control.invalidate(); return p })
  }

  // 每套配置的 key 进自己的环境变量（路由只引用自己那个，不会串到别的端点）
  private setKey(s: Settings): void {
    if (providerMeta(s.provider).needsApiKey && !s.apiKey) throw new Error('api_key_not_configured')
    const env = keyEnvOf(s.profileId)
    process.env[env] = s.apiKey || NO_KEY_PLACEHOLDER
    this.keyEnvs.add(env)
  }

  // 一套配置的 key / baseUrl / 模型 / 窗口在每次用到它（建会话、每回合开始、一次性调用）时现读并落到引擎：
  // key —— 适配器每次请求都现读 process.env，更新 env 即可；
  // pi-ai 路由表 —— 插件按 config 缓存，只能用新 config 重启这个插件（不动 Context 和其他会话）；只增不删模型；
  // DeepSeek —— 每套配置一个适配器实例，地址经 options 现读。
  // 返回该模型的上下文窗口。
  private async applySettings(s: Settings): Promise<number> {
    this.setKey(s)
    const route = routeOf(s.provider, s.profileId, s.protocol)
    const window = contextWindowOf(s.provider, s.model, s.contextWindow)
    const pi = usesPiAi(s.provider, s.protocol)
    if (pi) {
      const next = withRoute(this.piRoutes, s)
      if (JSON.stringify(next) !== JSON.stringify(this.piRoutes)) {
        await this.updateFiber(this.piAiFiber, { providers: next })
        this.piRoutes = next
        this.cfg.log?.('info', 'pi-ai routes updated', { route, model: s.model, baseURL: next[route].baseURL })
      }
    } else this.deepseekRoute(route, s)
    // 压缩：每个用过的路由+模型一条按其窗口换算的策略；阈值或目标变了就用新 config 重启压缩插件
    const adapterWindow = pi ? window : DEEPSEEK_WINDOW
    // 已有的原位更新（不挪到末尾）：一次性调用（如 AI 复核用另一套配置）与会话交替用两套配置时，顺序不变就不必反复重启压缩插件
    const target = { provider: route, model: s.model, contextWindow: window, adapterWindow }
    const at = this.compactTargets.findIndex((t) => t.provider === route && t.model === s.model)
    this.compactTargets = at < 0 ? [...this.compactTargets, target] : this.compactTargets.map((t, i) => (i === at ? target : t))
    const cc = compactionConfig(this.cfg.contextLimitTokens?.() ?? 0, this.compactTargets)
    const key = JSON.stringify(cc)
    if (key !== this.compactKey) {
      await this.updateFiber(this.compactionFiber, cc)
      this.compactKey = key
      this.cfg.log?.('info', 'compaction restarted with new config', { targets: this.compactTargets.length })
    }
    return window
  }

  // Cordis 4.0.4 的 fiber.update 只是排队重启、不返回 promise：要等 await() 落定，否则紧接着的请求会撞上
  // 「no adapter registered」（重启期间路由已撤）
  private async updateFiber(fiber: { update(config: any): unknown; await?(): Promise<unknown> } | undefined, config: unknown): Promise<void> {
    if (!fiber) return
    await fiber.update(config)
    await fiber.await?.()
  }

  // DeepSeek 配置：首次用到时注册一个官方适配器实例到它自己的路由；之后只改地址（options 每次请求现读，在途请求不受影响）。
  // key 经 apiKeyEnv 指向本配置的环境变量（setKey 写入）
  private userId?: string
  private deepseekRoute(route: string, s: Settings): void {
    const baseURL = deepseekBaseOf(s)
    const cur = this.dsRoutes.get(route)
    if (cur) { Object.assign(cur, { baseURL, model: s.model, multimodal: !!s.multimodal }); return }
    const holder = { baseURL, model: s.model, multimodal: !!s.multimodal }
    let cache: { key: string; opts: unknown } | undefined
    // 模型目录按「支持图片」改写本配置所用模型的输入模态（见 providers.deepseekModels）
    const options = () => {
      const key = JSON.stringify(holder)
      if (cache?.key !== key) {
        const opts = deepseek.resolveAdapterOptions({ baseURL: holder.baseURL } as any, undefined as any) as any
        cache = { key, opts: { ...opts, models: deepseekModels(opts.models, holder.model, holder.multimodal) } }
      }
      return cache.opts
    }
    // 0.2 起官方适配器走 Anthropic Messages 协议（{base}/v1/messages），认证改为 resolveAuth 返回请求头（API key 用 x-api-key）
    const env = keyEnvOf(s.profileId)
    const adapter = new deepseek.DeepSeekAdapter({
      options,
      resolveAuth: async () => ({ headers: { 'x-api-key': assertUsableApiKey(process.env[env] ?? '', 'llm-deepseek', env) } }),
      resolveUserId: () => (this.userId ??= getOrCreateAnonymousUserId()),
      resolveAttachments: () => (this.ctx as any)?.get?.('attachments'),
      // 以下三个 0.2 起必填（官方 registerDeepSeekProvider 里的默认实现）：不挂 API 扩展插件 → 无扩展字段
      prepareExtensions: () => Promise.resolve({ fields: {}, accept: () => Promise.resolve() }),
      onExtensionsOmitted: (e: any) => this.cfg.log?.('warn', 'deepseek request extensions omitted', { fields: e?.fields }),
      onReplayDegrade: (e: any) => this.cfg.log?.('warn', 'deepseek replay degraded', { model: e?.model, reason: String(e?.reason).slice(0, 200) }),
    } as any)
    ;(this.ctx as any).llm.registerAdapter([route], adapter)
    this.dsRoutes.set(route, holder)
    this.cfg.log?.('info', 'deepseek route registered', { route, baseURL })
  }

  // ── 授权网关：AuthRegistry 的三态直接落在 tools/pre-execute 上 ──
  // ask 的应答走 approval/request（弹我们自己的授权卡）。注意两条实测约束：
  //  1) ask 只在执行带 agent 时才真的问，agent-less 一律退化成 deny；
  //  2) ask 必须在打开的 turn 内发起，turn 外调会报 "outside an open turn"。
  // 我们的调用天然都在 turn 内、由 agent 发起，两条都满足。
  private installAuthGate(ctx: Context): void {
    ctx.on('tools/pre-execute' as any, (async (exec: any, next: any) => {
      const agentId = String(exec?.agent?.id ?? '')
      if (!agentId) return next()
      const sessionId = this.dshToOurs.get(agentId) ?? agentId
      this.touch(sessionId, exec.name, exec.arguments)
      const mcp = this.cfg.mcp?.lookup(String(exec.name))
      // 预演模式：写类工具一律拦（原因进模型，让它改成列计划），只读照常。最先判，计划 / 规则放行都不突破
      if (this.preview.has(sessionId) && (mcp ? previewBlocksMcp(mcp.autoApproved) : previewBlocks(String(exec.name), exec.arguments, this.cfg.isReadOnly))) {
        if (mcp) this.mcpAudit(sessionId, mcp, exec.arguments, 'deny:preview_mode')
        else {
          const tids = targetTerminalsOf(exec.name, exec.arguments)
          for (const tid of tids.length ? tids : ['']) this.cfg.audit({ sessionId, terminalId: tid, command: describeCall(exec.name, exec.arguments), decision: 'deny:preview_mode' })
        }
        return { kind: 'deny', reason: tr(PREVIEW_DENY) }
      }
      if (mcp) {
        const d = mcpDecision({ autoApproved: mcp.autoApproved, trust: this.cfg.trustOf?.(sessionId), unattended: this.cfg.isUnattended?.(sessionId) })
        if (d.kind === 'allow') return next()
        if (d.kind === 'deny') { this.mcpAudit(sessionId, mcp, exec.arguments, `deny:${d.reason}`); return d }
        this.pendingAsk.set(String(exec.callId), { sessionId, name: exec.name, args: exec.arguments, reason: d.reason })
        return { kind: 'ask', reason: d.reason }
      }
      // 入参带脱敏占位符：不弹卡，放行到工具体直接报错（原因进模型）；记成 fail，执行前用户关了脱敏也照样拒。
      // 只管要授权的工具（它们的工具体先取 override）；propose_* 无需授权，由 withRedaction 拦
      const refused = !String(exec.name).startsWith('propose_') && this.cfg.aiSecrets?.()
        ? placeholderError(String(exec.name), exec.arguments) : undefined
      if (refused) { this.overrides.set(String(exec.callId), { sessionId, fail: refused }); return next() }
      // 密钥保险箱：引用了不存在 / 不在范围内的密钥 → 不弹卡，同上放行到工具体报错（原因进模型），记一条拒绝；计划内也拒
      const se = secretError(this.cfg.secretVault, String(exec.name), exec.arguments)
      if (se) {
        const tids = targetTerminalsOf(exec.name, exec.arguments)
        for (const tid of tids.length ? tids : ['']) this.cfg.audit({ sessionId, terminalId: tid, command: describeCall(exec.name, exec.arguments), decision: `deny:${se.slice(0, 200)}` })
        this.overrides.set(String(exec.callId), { sessionId, fail: se })
        return next()
      }
      // 生产主机上缺回滚方案的变更命令：计划内也拒（原因进模型让它补，见 rollbackDeny）
      const rb = rollbackDeny(this.cfg, exec.name, exec.arguments)
      if (rb) return rb
      // 已批准计划内的步骤免卡（只读信任档、命令规则「禁止」照样拒，见 planDecision）
      if (planDecision(this.cfg, this.plans, sessionId, exec.name, exec.arguments)) return next()
      const d = decideFor(this.cfg, sessionId, exec.name, exec.arguments)
      if (d.kind === 'allow') {
        if (d.rule) this.overrides.set(String(exec.callId), { sessionId, rule: d.rule })   // 执行记录里注明按哪条规则放行
        return next()
      }
      if (d.kind === 'deny') return d
      // 记住这次 ask 的上下文，approval/request 里拿不到入参
      this.pendingAsk.set(String(exec.callId), { sessionId, name: exec.name, args: exec.arguments, reason: d.reason, rule: d.rule })
      return { kind: 'ask', reason: d.reason }
    }) as any)

    ctx.on('approval/request' as any, (async (req: any) => {
      const key = String(req.callId ?? '')
      const pend = this.pendingAsk.get(key)
      this.pendingAsk.delete(key)
      if (!pend) return 'unavailable'
      const mcp = this.cfg.mcp?.lookup(pend.name)
      if (mcp) return this.askMcp(key, pend.sessionId, mcp, pend.args)
      const terminalId = (pend.args as any)?.terminal_id ?? 'local'
      const original = (pend.args as any)?.command as string | undefined
      // write_file：读原文算 diff 给用户看；读/算失败（old_text 没命中等）不必打扰用户，放行到工具体直接抛错
      let diff: string | undefined
      let base: string | null | undefined
      if (pend.name === 'write_file') {
        try {
          const plan = await planWrite(this.cfg, pend.args)
          base = plan.old ?? null
          diff = unifiedDiff(plan.old ?? '', plan.next, String((pend.args as any).path)) || tr('（内容无变化）')
        } catch (e) {
          this.overrides.set(key, { sessionId: pend.sessionId, fail: e instanceof Error ? e.message : String(e) })
          return 'allowed-once'
        }
      }
      const view = approvalView(this.cfg, pend.name, pend.args)   // terminalId(hostKey) / command / explain / targets
      const risk = pend.reason === 'dangerous_command' ? 'dangerous' as const : 'safe' as const
      // AI 复核：命中范围的先让第二个模型审一遍（主进程判范围 / 限时 15 秒）；拦截 → 不弹卡直接拒（理由进模型），自动放行 → 同用户点了允许
      const rv = REVIEW_TOOLS.has(pend.name) && view.command ? await this.cfg.reviewCommand?.({
        sessionId: pend.sessionId, tool: pend.name, hostKeys: view.targets?.map((t) => t.hostKey) ?? [view.terminalId],
        command: view.command, diff, explain: view.explain, rollback: 'rollback' in view ? view.rollback : undefined,
        reason: pend.reason ?? 'first_access', risk, context: this.contextOf(pend.sessionId),
      }).catch((e) => { this.cfg.log?.('warn', 'ai review failed', { err: String(e).slice(0, 200) }); return undefined }) : undefined
      const review = rv?.review
      // 这次调用的授权记录 / 执行记录都带上复核结果
      const withReview = review ? { ...this.cfg, audit: (r: Parameters<TerminalToolDeps['audit']>[0]) => this.cfg.audit({ ...r, review }) } : this.cfg
      if (rv?.action === 'deny') {
        const tids = targetTerminalsOf(pend.name, pend.args)
        for (const tid of tids.length ? tids : [terminalId]) withReview.audit({ sessionId: pend.sessionId, terminalId: tid, command: describeCall(pend.name, pend.args), decision: `deny:ai_review:${rv.review.reason}`.slice(0, 300) })
        this.overrides.set(key, { sessionId: pend.sessionId, fail: tr('ai_review_blocked: AI 复核判定拦截，未执行。理由：{reason}。不要换个写法绕过；先向用户说明风险，或改用更安全的做法。', { reason: rv.review.reason }) })
        return 'allowed-once'
      }
      if (rv?.action === 'allow') {
        if (base !== undefined) this.overrides.set(key, { sessionId: pend.sessionId, base })
        this.overrides.set(key, { ...this.overrides.get(key), sessionId: pend.sessionId, review, ...(pend.rule ? { rule: pend.rule } : {}) })
        commitGrant(withReview, pend.sessionId, pend.name, pend.args, pend.reason, pend.rule ? `${pend.rule} · ${tr('AI 复核通过')}` : tr('AI 复核通过'))
        return 'allowed-once'
      }
      const ans = await this.cfg.requestApproval({
        sessionId: pend.sessionId,
        needed: neededForCall(this.cfg, pend.name, pend.args),
        reason: (pend.reason as any) ?? 'first_access',
        risk,
        tool: pend.name,
        ...view,
        diff,
        ...(pend.rule ? { rule: pend.rule } : {}),
        ...(review ? { review } : {}),
      })
      const note = ans.note?.trim()
      if (ans.decision === 'deny') {
        // 多主机工具逐台落审计
        const tids = targetTerminalsOf(pend.name, pend.args)
        const decision = note ? `deny:user:${note}` : 'deny:user'
        if (pend.name === 'run_on_hosts') {
          for (const h of fleetTargetsOf(this.cfg, pend.args)) this.cfg.audit({ sessionId: pend.sessionId, terminalId: '', hostKey: h.id, terminalTitle: h.label, command: describeCall(pend.name, pend.args), decision })
        } else for (const tid of tids.length ? tids : [terminalId]) {
          withReview.audit({ sessionId: pend.sessionId, terminalId: tid, command: describeCall(pend.name, pend.args), decision })
        }
        if (!note) return 'rejected'
        // 带原因的拒绝：放行到工具体再抛错，原因才能进模型（不落授权记录）
        this.overrides.set(key, { sessionId: pend.sessionId, deny: note })
        return 'allowed-once'
      }
      const edited = pend.name === 'exec_in_terminal' && ans.command?.trim() && ans.command.trim() !== original?.trim()
        ? ans.command.trim() : undefined
      if (edited) this.overrides.set(key, { sessionId: pend.sessionId, command: edited })
      if (base !== undefined) this.overrides.set(key, { sessionId: pend.sessionId, base })
      if (pend.rule) this.overrides.set(key, { ...this.overrides.get(key), sessionId: pend.sessionId, rule: pend.rule })
      if (review) this.overrides.set(key, { ...this.overrides.get(key), sessionId: pend.sessionId, review })
      commitGrant(withReview, pend.sessionId, pend.name, edited ? { ...(pend.args as any), command: edited } : pend.args, pend.reason, pend.rule)
      return 'allowed-once'
    }) as any)
  }
  private pendingAsk = new Map<string, { sessionId: string; name: string; args: unknown; reason?: string; rule?: string }>()

  // 会话用到过的主机（hostKey）：AI 打开 / 使用了该主机的终端、或 run_on_hosts 访问了它。知识库段据此注入（只在内存，重启后再用到再记）
  private touched = new Map<string, Set<string>>()
  private touch(sessionId: string, name: string, args: unknown): void {
    const keys = hostsTouchedBy(this.cfg, String(name), args)
    if (!keys.length) return
    const s = this.touched.get(sessionId) ?? new Set<string>()
    for (const k of keys) s.add(k)
    this.touched.set(sessionId, s)
  }

  // ── 预演模式（只说不做）：会话级，只在内存（重启后回到正常模式）──
  private preview = new Set<string>()
  setPreview(sessionId: string, on: boolean): void { if (on) this.preview.add(sessionId); else this.preview.delete(sessionId) }
  isPreview(sessionId: string): boolean { return this.preview.has(sessionId) }
  /** 「执行选中步骤」：关掉预演，把勾选的步骤记为已批准计划（下一轮里逐字一致的命令免逐条授权，同 propose_plan 批准） */
  approvePlan(sessionId: string, steps: PlanStep[]): number {
    this.preview.delete(sessionId)
    const ok = sanitizeSteps(steps)
    if (ok.length) this.plans.approve(sessionId, ok.map((s) => ({ hostKey: this.cfg.resolveHostKey(s.terminal_id), command: s.command, path: s.path })))
    return ok.length
  }
  /** 会话最近上下文摘要（AI 复核的提示里用） */
  private contextOf(sessionId: string): string {
    const session = (this.sessions.get(sessionId)?.handle.agent as any)?.session
    const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : []
    return Array.isArray(events) ? recentContext(events as DshEvent[]) : ''
  }

  // ── MCP：授权卡 / 工具体外包一层 / 审计 ──
  private async askMcp(callId: string, sessionId: string, ref: McpToolRef, args: unknown): Promise<string> {
    const explain = explainOf(args)
    const ans = await this.cfg.requestApproval({
      sessionId, terminalId: `mcp:${ref.server}`, needed: 'write', reason: 'first_access', risk: 'safe',
      tool: ref.publicName, command: `${ref.server} · ${ref.tool}`, ...(explain ? { explain } : {}),
      mcp: { server: ref.server, tool: ref.tool, args: mcpArgsView(args) },
    })
    if (ans.decision === 'allow') return 'allowed-once'   // 一次性：MCP 不落授权记录，下次照样问
    const note = ans.note?.trim()
    this.mcpAudit(sessionId, ref, args, note ? `deny:user:${note}` : 'deny:user')
    if (!note) return 'rejected'
    this.overrides.set(callId, { sessionId, deny: note })   // 带原因：放行到工具体再抛错，原因才进得了模型
    return 'allowed-once'
  }

  private async mcpAround(exec: any, ref: McpToolRef, args: unknown, run: () => Promise<string>): Promise<string> {
    const agentId = String(exec?.agent?.id ?? '')
    const sessionId = this.dshToOurs.get(agentId) ?? agentId
    const key = String(exec?.callId ?? '')
    const o = this.overrides.get(key)
    this.overrides.delete(key)
    if (o?.deny !== undefined) throw new Error(tr('用户拒绝执行。原因：{reason}', { reason: o.deny }))
    try {
      const out = await run()
      this.mcpAudit(sessionId, ref, args, 'mcp_call', 0)
      return out
    } catch (e) {
      this.mcpAudit(sessionId, ref, args, 'mcp_call', 1)
      throw e
    }
  }

  private mcpAudit(sessionId: string, ref: McpToolRef, args: unknown, decision: string, exitCode?: number): void {
    const a = JSON.stringify(stripExplain(args))
    this.cfg.audit({
      sessionId, terminalId: '', decision, exitCode, mcpServer: ref.server, mcpTool: ref.tool,
      command: `${ref.tool} ${a.length > 300 ? `${a.slice(0, 300)}…` : a}`,
    })
  }
  // callId → 用户在授权卡上的改动，工具体执行时取走（见 terminalTools.userOverride）
  private overrides = new Map<string, UserOverride & { sessionId: string }>()
  // 已批准的计划（本轮有效，turn/end 时清）
  private plans = new PlanBook()

  // dsh 会话 id → 我方会话 id（上下文重置后两者不再相同）
  private dshToOurs = new Map<string, string>()

  // ── 会话 ────────────────────────────────────────────
  // 随机 id，删除后不复用：复用会撞上 dsh 磁盘上的旧日志（拒绝新建），还会继承旧会话的授权。
  async createSession(opts?: { title?: string }): Promise<SessionInfo> {
    const id = `sess_${randomUUID().slice(0, 8)}`
    const createdAt = new Date().toISOString()
    const workDir = homedir()
    // 新会话钉住当时的默认配置（之后改默认不影响它；要换在会话里切）
    const modelProfileId = this.cfg.resolveSettings().profileId
    const meta: SessionMeta = { id, title: opts?.title ?? id, threadId: id, createdAt, lastActiveAt: createdAt, workDir, ...(modelProfileId ? { modelProfileId } : {}) }
    const info = await this.spawn(id, meta)
    this.cfg.sessionStore?.upsert({ ...meta, title: info.title })
    return info
  }

  // 起一个 agent。dsh 的 sessionId 默认就是我方 id；上下文重置后换成 meta.dshId
  // （dsh 拒绝在已有日志的 id 上新建，所以重置必须换 id）。
  // fork：带着源会话日志前缀新建（分叉 / 重新生成），建好后同 resume 一样回放给界面
  private async spawn(id: string, meta: SessionMeta, resume = false, fork?: ForkSeed): Promise<SessionInfo> {
    const ctx = await this.boot()
    const s = this.cfg.resolveSettings(meta.modelProfileId)
    const window = await this.applySettings(s)
    let dshId = meta.dshId ?? id
    this.dshToOurs.set(dshId, id)
    // 实时：本轮模型首次返回 / 工具在流里被识别 → 记侧车（dsh 不落盘这些时间，重启回放要用）。dshId 可能在下面恢复时换掉，现取
    const relay = createRelay(id, (ev) => this.emit(ev), {
      onFirst: (turn, at) => { void this.times.record(dshId, turn, at) },
      onToolSeen: (callId, at) => { void this.times.recordTool(dshId, callId, at) },
      onReasoning: (key, start, end) => { void this.times.recordReasoning(dshId, key, start, end) },
    })
    const agentOptions = { provider: routeOf(s.provider, s.profileId, s.protocol), model: s.model }
    // create 与 resume 的入参形状**不一样**：resume 要 resumeSessionId 且不收 meta
    // （cwd 从持久化的会话头恢复）。传错的表现是 jsonl 持久化里
    // encodeSegment(undefined) → "Cannot read properties of undefined (reading 'length')"。
    const createAs = (sid: string) => ctx.agents.create({ sessionId: sid as any, agentOptions, meta: { cwd: meta.workDir || homedir() } } as any)
    const resumeAs = (sid: string) => ctx.agents.resume({ resumeSessionId: sid as any, agentOptions } as any)
    // 种子（继承前缀 + 继承标记）随新会话头一起落盘，之后重启照常 resume
    const forkAs = (sid: string, f: ForkSeed) => ctx.agents.create({
      sessionId: sid as any, agentOptions, seed: f.seed as any, inheritedEventCount: f.inherited as any,
      meta: { cwd: meta.workDir || homedir(), parentSession: f.parent as any, isSeeded: true },
    } as any)
    let handle
    let restored = resume || !!fork   // 是否带着历史（决定要不要回放）
    let notice: { reason: string; path?: string } | undefined
    if (resume) {
      try { handle = await resumeAs(dshId) }
      catch (e) {
        this.cfg.log?.('warn', 'resume failed', { sessionId: id, dshId, err: String(e).slice(0, 300) })
        const r = await this.recoverResume(id, dshId, e, resumeAs, createAs)
        handle = r.handle
        restored = r.restored
        notice = r.notice
        // 换了 dsh 会话：映射 + 写回会话记录（下次直接用新 id，不再重复修复/新建）
        this.dshToOurs.set(r.dshId, id)
        dshId = r.dshId
        const cur = this.cfg.sessionStore?.list().find((m) => m.id === id) ?? meta
        this.cfg.sessionStore?.upsert({ ...cur, dshId: r.dshId })
      }
    } else handle = await (fork ? forkAs(dshId, fork) : createAs(dshId))
    const info: SessionInfo = { id, title: meta.title, createdAt: meta.createdAt }
    const live: Live = {
      info, dshId, window, provider: s.provider, model: s.model, profileId: meta.modelProfileId, applied: s.profileId, route: agentOptions,
      handle: handle as any, relay, ctxTokens: 0, steps: 0, compactions: 0, lastUsed: Date.now(), turning: false,
    }
    this.sessions.set(id, live)
    await this.evictIdle(id)

    // 会话级切换模型：每步请求的路由 / 模型按 live.route 改写（AgentOptions 只管首个请求，之后 dsh 沿用持久化的请求头）。
    // live.route 只在回合之间更新（applyProfile），所以回合进行中切换要到下一回合才生效。
    // 推理强度是按路由解析的，换了路由就丢掉沿用的值，让新适配器按自己的默认来
    handle.agent.ctx.on('agent/request' as any, (async (_p: unknown, next: () => Promise<any>) => {
      const r = await next()
      if (r?.provider === live.route.provider && r?.model === live.route.model) return r
      const { reasoningEffort: _e, ...rest } = r ?? {}
      return { ...rest, provider: live.route.provider, model: live.route.model }
    }) as any)

    // 该 agent 的会话事件 → 我方 AgentEvent，顺带记上下文用量 / 步数 / 压缩
    handle.agent.ctx.on('session/event' as any, ((...a: any[]) => {
      const ev = a.find((x: any) => x && typeof x === 'object' && typeof x.type === 'string') as DshEvent | undefined
      if (!ev) return
      if (ev.type === 'turn/start') { live.turning = true; live.turn = ev.data?.turn }
      if (ev.type === 'turn/end') { live.turning = false; live.turn = undefined; live.lastUsed = Date.now(); this.plans.clear(id) }   // 计划只在本轮有效（纯内存操作，不碰 dsh）
      relay(ev)
      this.track(id, live, ev, true)
    }) as any)

    // 0.2 起流式文本 / 推理增量走 agent/assistant-stream 帧（不进 session/event），翻成旧词汇交给同一个 relay
    const fromFrame = createStreamAdapter()
    handle.agent.ctx.on('agent/assistant-stream' as any, ((p: any) => {
      const ev = fromFrame(p?.frame)
      if (ev) relay(ev)
    }) as any)

    // resume 时 dsh 把历史作为**构造种子**载入（Session 文档明确：不会重发到 session/event firehose），
    // 而 relay 只订阅 session/event，于是重启后重连前端收不到任何历史 item。这里把持久化事件日志
    // 手动灌进 relay 让前端重建对话。仿 CodeWhale 版 since_seq=0 重放：item.* 正常 relay 重建内容，
    // turn.* 跳过，避免「上次进程被杀留下的孤儿 turn/start」让前端 busy 永久卡死。
    if (restored) this.replayHistory(id, live, true)
    // 历史恢复不了：对话区出一条系统提示（不是错误页），会话照常可用
    if (notice) this.emit({ type: 'agent:historyUnrecoverable', sessionId: id, ...notice })
    return info
  }

  // resume 失败后的恢复（dsh 0.2 读不了 0.1.1 的旧日志等）：
  //  1) 旧格式能修的（见 legacyRepair.ts）→ 修复副本写到新 dsh id，resume 它，历史完整回放；原日志不动；
  //  2) 修不了 → 用新 dsh id 开空会话，并告知前端（原记录路径一并给出）。
  // 绝不在原 id 上新建：磁盘上有同 id 日志时 dsh 会拒绝（SessionAlreadyExistsError）。
  // 原 id 根本没有日志（旧 CodeWhale 时代的会话，历史已另行归档）→ 安静地开新的，不提示。
  private async recoverResume(id: string, dshId: string, err: unknown, resumeAs: (sid: string) => Promise<any>, createAs: (sid: string) => Promise<any>):
    Promise<{ handle: any; dshId: string; restored: boolean; notice?: { reason: string; path?: string } }> {
    const store = (this.ctx as any)?.sessionPersistence
    const found = await store?.findLog(dshId).catch(() => undefined)
    const newId = () => `${id}_${randomUUID().slice(0, 8)}`
    if (found) {
      const fixId = newId()
      try {
        const fix = await repairLegacyLog(store, dshId, fixId)
        if (fix) {
          try {
            const handle = await resumeAs(fixId)
            this.cfg.log?.('info', 'legacy session log repaired', { sessionId: id, from: dshId, to: fixId, changes: fix.changes.slice(0, 20), total: fix.changes.length })
            return { handle, dshId: fixId, restored: true }
          } catch (e) {
            this.cfg.log?.('warn', 'repaired log still not resumable', { sessionId: id, err: String(e).slice(0, 300) })
            await rm(dirname(fix.path), { recursive: true, force: true }).catch(() => {})   // 副本是我们写的，删掉；原日志不动
          }
        }
      } catch (e) { this.cfg.log?.('warn', 'legacy repair failed', { sessionId: id, err: String(e).slice(0, 300) }) }
    }
    const fresh = newId()
    const handle = await createAs(fresh)
    this.cfg.log?.('warn', 'history unrecoverable, started an empty session', { sessionId: id, from: dshId, to: fresh })
    const path = typeof found === 'string' ? found : found?.sourcePath
    return { handle, dshId: fresh, restored: false, notice: found ? { reason: failureSummary(err), ...(path ? { path } : {}) } : undefined }
  }

  // 把会话完整事件日志灌给 relay，让前端重建对话。回放模式下 turn.* 只翻成时间（turnTiming），
  // 不发 turnStarted/Completed（孤儿 turn/start 会让前端 busy 卡死）。
  // count=true 时顺带累计用量/步数（resume 冷启动）；渲染页重载后的重放只重建界面，不重复累计。
  private replayHistory(id: string, live: Live, count: boolean): void {
    // 0.2 起 session 不再暴露 events 数组，只有 snapshotEvents()（官方标了 deprecated 但仍是同步读全量的唯一入口）
    const session = (live.handle.agent as any)?.session
    const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : session?.events
    if (Array.isArray(events)) {
      // 回放用独立的翻译器：实时那个记着本轮已完成的块，会把回放的同一批块当重复跳过
      const firsts = this.times.firstOf(live.dshId)
      const tools = this.times.toolsOf(live.dshId)
      const reasoning = this.times.reasoningOf(live.dshId)
      const relay = createRelay(id, (ev) => this.emit(ev), { replay: true, firstAtOf: (t) => firsts[t], toolAtOf: (c) => tools[c], reasoningAtOf: (k) => reasoning[k] })
      for (const ev of events as DshEvent[]) {
        relay(ev)
        if (count) this.track(id, live, ev, false)   // 回放只累计，不发通知（重连不该弹压缩提示/建议）
      }
    }
    if (live.ctxTokens > 0) this.emitUsage(id, live)
  }

  // 渲染页重载（Ctrl+R / 崩溃恢复 / 开发热重载）后界面的对话全丢了，但会话还活在主进程里：
  // 标记全部活会话，下次界面 reconnect 时重放一遍历史
  private replayPending = new Set<string>()
  markRendererReloaded(): void { for (const id of this.sessions.keys()) this.replayPending.add(id) }

  // ── 上下文：用量 / 步数 / 自动压缩 ────────────────────
  // 压缩本身由 dsh-compaction-basic 在步边界自动做（超阈值 → 较早历史摘要成检查点，任务继续）。
  // 这里只观测：用量给 UI 进度条；压缩开始/结束给 UI 提示；步数多了且压缩过 → 建议开新会话（一次）。
  // live=true 是实时事件，false 是重连回放（只累计不通知）。
  private track(id: string, s: Live, ev: DshEvent, live: boolean): void {
    const tokens = contextTokensOf(ev)
    if (tokens !== undefined) {
      s.ctxTokens = tokens
      if (live) {
        const u = requestUsageOf(ev)
        // 先落用量再发 contextUsage：UI 收到事件去刷「本会话 tokens」时能读到这条
        if (u) this.cfg.recordUsage?.({ sessionId: id, provider: s.provider, model: s.model, ...u, ...(this.cfg.isUnattended?.(id) ? { unattended: true } : {}) })
        this.emitUsage(id, s)
      }
    }
    if (ev.type === 'step/start') { s.steps++; if (live) this.maybeSuggestReset(id, s) }
    else if (ev.type === 'compaction/start' && live) this.emit({ type: 'agent:contextCompacting', sessionId: id })
    else if (ev.type === 'compaction/summary') s.lastSummary = textBlocks(ev.data?.summary) || s.lastSummary
    else if (ev.type === 'compaction/end') {
      const error = ev.data?.error ? String(ev.data.error) : undefined
      if (!error) s.compactions++
      if (!live) return
      if (error) this.cfg.log?.('warn', 'compaction failed', { sessionId: id, error: error.slice(0, 200) })
      this.emit({ type: 'agent:contextCompacted', sessionId: id, ...(error ? { error } : {}) })
      this.maybeSuggestReset(id, s)
    }
  }

  private maybeSuggestReset(id: string, s: Live): void {
    const steps = this.cfg.contextResetSteps?.() ?? 100
    if (s.suggested || s.compactions === 0 || steps <= 0 || s.steps < steps) return
    s.suggested = true
    this.emit({ type: 'agent:resetSuggested', sessionId: id, steps: s.steps, compactions: s.compactions, summary: s.lastSummary ?? '' })
  }

  // dsh 的 usage 按**请求**给，inputTokens+cacheReadTokens 就是这次请求的真实提示词长度。
  // 上限按本会话模型窗口夹（小窗口模型上 60 万的阈值没有意义）
  private emitUsage(sessionId: string, s: Live): void {
    this.emit({ type: 'agent:contextUsage', sessionId, inputTokens: s.ctxTokens, limit: effectiveLimit(this.cfg.contextLimitTokens?.() ?? 0, s.window) })
  }

  // ── turn ────────────────────────────────────────────
  // attachments：文件 / 目录只把路径追加到消息末尾（见 shared/ai/attachments.ts 的路径块）；
  // 图片存进附件存档，作为图片内容块随消息发送——会话所用配置没开「支持图片」时拒绝（不悄悄丢图）
  async sendTurn(sessionId: string, prompt: string, attachments: TurnAttachment[] = []): Promise<void> {
    this.drive(sessionId, await this.userContent(sessionId, prompt, attachments))
  }

  /**
   * 回合进行中追问（steering）：进收件箱的 next-step，当前步骤结束、模型下一次请求前插进对话，本轮接着跑；
   * 空闲时 dsh 会直接开一轮。返回消息 id：被接纳时 user/message 事件的 id 就是它（界面据此把「等待插入」气泡落位），撤回也用它
   */
  async steer(sessionId: string, prompt: string, attachments: TurnAttachment[] = []): Promise<string> {
    return this.drive(sessionId, await this.userContent(sessionId, prompt, attachments), 'steer')
  }

  /** 撤回还没插入的追问；已经被接纳（或已随停止清掉）返回 false */
  unsteer(sessionId: string, messageId: string): boolean {
    const live = this.sessions.get(sessionId)
    if (!live) return false
    try { return live.handle.agent.inbox.remove(messageId as any) } catch { return false }
  }

  // 用户消息内容块：恢复被释放的会话、回合之间应用所选配置、脱敏、附件（路径块 / 图片存档）
  private async userContent(sessionId: string, prompt: string, attachments: TurnAttachment[]): Promise<unknown[]> {
    // 会话可能已被 LRU 释放（界面还停在它上面）：先从磁盘恢复再发
    if (!this.sessions.has(sessionId)) {
      const meta = this.cfg.sessionStore?.list().find((m) => m.id === sessionId)
      if (meta) await this.reconnectSession(meta)
    }
    // 回合之间：按会话所选配置现读（切过模型 / 改过配置都在这一回合生效）
    const live = this.sessions.get(sessionId)
    if (live && !live.turning) await this.applyProfile(live)
    const images = attachments.filter((a) => a.kind === 'image')
    if (images.length && !this.cfg.resolveSettings(live?.profileId).multimodal) throw new Error(tr('当前模型不支持图片，可在模型设置里开启「支持图片」或切换模型'))
    const paths = attachments.flatMap((a) => (a.kind === 'file' || a.kind === 'dir' ? [{ kind: a.kind, path: a.path }] : []))
    // 用户贴进来的终端输出里若带密钥保险箱的明文，进模型前同样换回占位符（@ 引用 / 终端块同样）
    const mask = (s: string) => this.cfg.secretVault?.mask(s) ?? s
    const ctxs = attachments.filter((a): a is ContextAttachment => a.kind === 'context').map((c) => ({ ...c, text: mask(c.text) }))
    const text = withPathsBlock(withContextBlocks(mask(prompt), ctxs), paths, process.platform)
    const refs = images.length
      ? await ((await this.boot()) as any).attachments.saveImages(images.map((i) => ({ data: new Uint8Array(Buffer.from(i.data, 'base64')), mediaType: i.mediaType, name: i.name })))
      : []
    return [...(text ? [{ type: 'text', text }] : []), ...refs.map((attachment: unknown) => ({ type: 'image', attachment }))]
  }

  /** 按存档 id 取图片（data URL），界面回放缩略图 / 大图用；找不到返回 null */
  readImage(id: string): Promise<string | null> { return readStoredImage(this.attachmentRoot, id) }

  // 把会话所选配置落到引擎并作为本会话之后请求的路由
  private async applyProfile(live: Live): Promise<void> {
    const s = this.cfg.resolveSettings(live.profileId)
    live.window = await this.applySettings(s)
    live.route = { provider: routeOf(s.provider, s.profileId, s.protocol), model: s.model }
    live.provider = s.provider
    live.model = s.model
    live.applied = s.profileId
  }

  /**
   * 会话级切换模型（持久化在会话元数据）。空闲时立即生效；回合进行中只记下，下一回合开始时生效（pending=true）。
   * profileId 为空 = 跟随默认配置。
   */
  async setSessionModel(sessionId: string, profileId?: string): Promise<{ pending: boolean }> {
    const m = this.cfg.sessionStore?.list().find((x) => x.id === sessionId)
    if (!m) throw new Error('session_not_found')
    const s = this.cfg.resolveSettings(profileId)
    if (providerMeta(s.provider).needsApiKey && !s.apiKey) throw new Error(tr('api_key_not_configured: 该模型配置还没填 API Key'))
    const { modelProfileId: _old, ...rest } = m
    this.cfg.sessionStore?.upsert(profileId ? { ...rest, modelProfileId: profileId } : rest)
    const live = this.sessions.get(sessionId)
    if (!live) return { pending: false }
    live.profileId = profileId || undefined
    if (live.turning) return { pending: true }
    await this.applyProfile(live)
    return { pending: false }
  }

  /** 会话所选配置 + 是否还没生效（回合进行中切换的） */
  sessionModel(sessionId: string): { profileId?: string; pending: boolean } {
    const live = this.sessions.get(sessionId)
    const profileId = live ? live.profileId : this.cfg.sessionStore?.list().find((x) => x.id === sessionId)?.modelProfileId
    const want = this.cfg.resolveSettings(profileId).profileId
    return { profileId, pending: !!live && live.applied !== want }
  }

  // 超过上限时释放最久没用的空闲会话（keep = 刚用到的那个，不释放）。
  // 在跑的、有待授权的、无人值守巡检的都不动；全都忙就暂时超限，等下次再收。
  private async evictIdle(keep: string): Promise<void> {
    while (this.sessions.size > MAX_LIVE_SESSIONS) {
      const busy = new Set([...this.pendingAsk.values()].map((v) => v.sessionId))
      let victim: [string, Live] | undefined
      for (const e of this.sessions) {
        const [sid, l] = e
        if (sid === keep || l.turning || busy.has(sid) || this.starting.has(sid) || this.cfg.isUnattended?.(sid)) continue
        if (!victim || l.lastUsed < victim[1].lastUsed) victim = e
      }
      if (!victim) return
      this.cfg.log?.('info', 'evict idle session', { sessionId: victim[0], live: this.sessions.size })
      await this.closeSession(victim[0])
    }
  }

  // followup 排队一轮并唤醒驱动器。**发出即返回，不等这轮跑完** —— 上层（UI 的乐观气泡、
  // 对外 API 的 taskId）都靠 turnStarted/turnCompleted 事件推进，若在这里 await whenIdle，
  // 一次 sendTurn 会把 IPC 调用挂住整轮（实测把对外 API 直接卡死）。
  // UserMessage 必须用 createUserMessage 造（要 id + source），手搓对象会被**静默丢弃**、turn 空转。
  // mode = steer：进 next-step（见 steer()）
  private drive(sessionId: string, content: unknown[], mode: 'followup' | 'steer' = 'followup'): string {
    const live = this.sessions.get(sessionId)
    if (!live) throw new Error('session_not_found')
    live.lastUsed = Date.now()
    const msg = createUserMessage({ content: content as any, source: { kind: 'user' } }) as any
    if (mode === 'steer') live.handle.agent.steer(msg)
    else live.handle.agent.followup(msg)
    // 消息已经发出去了，更新「最近活跃」失败不能让 sendTurn 报错（否则 UI 显示发送失败，AI 却在跑）
    try { this.cfg.sessionStore?.touch(sessionId, new Date().toISOString()) }
    catch (e) { this.cfg.log?.('warn', 'touch session failed', { sessionId, err: String(e).slice(0, 200) }) }
    return String(msg.id)
  }


  // 进程内直接有 turn 级取消 —— sdk/client 那条 "No mid-turn cancel" 是 stdio 线协议的限制。
  // 在途 exec 由 dsh 经 exec.signal 中止（Terminal.execCapture 收到 abort 发 Ctrl-C）。
  // 不自己发 turnFailed：dsh 取消后会发真实的 turn/end，带正确 turnId，由 relay 转出。
  async interruptTurn(sessionId: string): Promise<void> {
    const live = this.sessions.get(sessionId)
    // cause 是对象（0.2 的 AgentCancelCause）。0.1.1 时代这里传字符串 'user'，被原样写进 turn/end，
    // 0.2 的迁移器读不回来（升级后旧会话打不开的根因，见 legacyRepair.ts）；0.2 下传字符串也不认（kind 缺失）
    if (live) { try { live.handle.agent.cancel({ kind: 'user' }) } catch { /* 无活跃 turn 时是 no-op */ } }
    this.dropPendingAsks(sessionId)
  }

  // ask 之后若 approval/request 没触发（turn 被取消等），条目会一直留着
  private dropPendingAsks(sessionId: string): void {
    for (const [k, v] of this.pendingAsk) if (v.sessionId === sessionId) this.pendingAsk.delete(k)
    for (const [k, v] of this.overrides) if (v.sessionId === sessionId) this.overrides.delete(k)
    this.plans.clear(sessionId)
  }

  // ── 一次性补全（终端里自然语言写命令）───────────────────
  // 不建会话、不带工具、不落日志：直接走 llm.stream，用默认配置（路由 / key / baseUrl 与新会话同一套，见 applySettings）。
  // 不传 temperature / maxTokens：有的端点（推理模型）拒非默认温度，推理模型的思考也算 max_tokens，截短了反而没输出
  // source：用量统计里的来源标签（不属于任何会话的一次性调用，sessionId 记为空）
  // profileId：用哪套模型配置（AI 复核可选更便宜的；缺省 / 已删 = 默认配置）
  async complete(system: string, user: string, signal?: AbortSignal, source = 'one-shot', profileId?: string): Promise<string> {
    const ctx = await this.boot()
    const s = this.cfg.resolveSettings(profileId)
    await this.applySettings(s)
    let text = ''
    const stream = (ctx as any).llm.stream({
      provider: routeOf(s.provider, s.profileId, s.protocol), model: s.model, system, signal,
      messages: [createUserMessage({ content: [{ type: 'text', text: user }], source: { kind: 'user' } })],
    }) as AsyncIterable<{ type: string; text?: string; usage?: { inputTokens?: number; cacheReadTokens?: number; outputTokens?: number }; reason?: { kind: string; failure?: { message: string } } }>
    for await (const c of stream) {
      if (c.type === 'text-delta') text += c.text ?? ''
      else if (c.type === 'usage' && typeof c.usage?.inputTokens === 'number') {
        const u = c.usage
        this.cfg.recordUsage?.({ sessionId: '', source, provider: s.provider, model: s.model, input: u.inputTokens ?? 0, cacheRead: u.cacheReadTokens ?? 0, output: u.outputTokens ?? 0 })
      }
      else if (c.type === 'finish' && (c.reason?.kind === 'error' || c.reason?.kind === 'aborted')) throw new Error(c.reason.failure?.message || c.reason.kind)
    }
    return text
  }

  // ── 历史搜索 ────────────────────────────────────────
  // dsh 日志是私有分帧的 zstd，标准解压读不了，只能经它自己的持久化插件读。
  // 每个日志按 revision（文件 stat 派生）缓存抽好的文本，没变的不重复解压。
  // ponytail: 首次搜索要把所有会话日志各解一遍（大日志几 MB），之后走缓存；会话多到慢了再上倒排索引。
  private searchCache = new Map<string, { rev: string; texts: string[] }>()

  async searchSessions(query: string): Promise<{ sessionId: string; snippet: string }[]> {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const store = (await this.boot() as any).sessionPersistence
    const metas = this.cfg.sessionStore?.list() ?? []
    // 一个我方会话可能对应多个 dsh 日志（上下文重置过：sess_x、sess_x_<rand>…），旧日志也一起搜
    const ourIdOf = (dshId: string) => metas.find((m) => m.id === dshId || m.dshId === dshId || dshId.startsWith(`${m.id}_`))?.id
    const hits = new Map<string, string>()
    for (const h of await store.list()) {
      const dshId = String(h?.header?.id ?? h?.id ?? '')
      const sid = ourIdOf(dshId)
      if (!sid || hits.has(sid)) continue
      try {
        for (const t of await this.textsOf(store, dshId, String(h?.revision ?? ''))) {
          const i = t.toLowerCase().indexOf(q)
          if (i >= 0) { hits.set(sid, snippetAround(t, i, q.length)); break }
        }
      } catch (e) { this.cfg.log?.('warn', 'search: read log failed', { dshId, err: String(e).slice(0, 200) }) }
    }
    return [...hits].map(([sessionId, snippet]) => ({ sessionId, snippet }))
  }

  // 0.2 的持久化服务：list() 带 revision；读日志经只读句柄 open(id,'read').read()（旧版的 loadStored 已移除）
  private async textsOf(store: any, dshId: string, rev: string): Promise<string[]> {
    const hit = this.searchCache.get(dshId)
    if (hit && rev && hit.rev === rev) return hit.texts
    const reader = await store.open(dshId, 'read')
    let events: DshEvent[] = []
    try { events = ((await reader.read())?.events ?? []) as DshEvent[] } finally { await reader.close() }
    const texts = searchableTexts(events)
    this.searchCache.set(dshId, { rev, texts })
    return texts
  }

  private async eventsOf(store: any, dshId: string): Promise<DshEvent[]> {
    const reader = await store.open(dshId, 'read')
    try { return ((await reader.read())?.events ?? []) as DshEvent[] } finally { await reader.close() }
  }

  // 跨会话检索的全部文本（用户提问 / AI 回复 / 执行过的命令，带条目 id）。同 searchSessions：按日志 revision 缓存，
  // 上下文重置过的会话旧日志也算（条目 id 在当前对话里找不到时界面只打开会话）
  private docsCache = new Map<string, { rev: string; docs: ChatSearchDoc[] }>()
  async searchDocsAll(): Promise<ChatSearchDoc[]> {
    const store = (await this.boot() as any).sessionPersistence
    const metas = this.cfg.sessionStore?.list() ?? []
    const ourIdOf = (dshId: string) => metas.find((m) => m.id === dshId || m.dshId === dshId || dshId.startsWith(`${m.id}_`))?.id
    const out: ChatSearchDoc[] = []
    for (const h of await store.list()) {
      const dshId = String(h?.header?.id ?? h?.id ?? '')
      const sid = ourIdOf(dshId)
      if (!sid) continue
      const rev = String(h?.revision ?? '')
      try {
        let hit = this.docsCache.get(dshId)
        if (!hit || !rev || hit.rev !== rev) { hit = { rev, docs: searchDocs(sid, await this.eventsOf(store, dshId)) }; this.docsCache.set(dshId, hit) }
        out.push(...hit.docs)
      } catch (e) { this.cfg.log?.('warn', 'search docs: read log failed', { dshId, err: String(e).slice(0, 200) }) }
    }
    return out
  }

  /** 会话摘要（@ 引用历史会话）：在内存的取快照，否则读当前 dsh 日志 */
  async sessionDigest(sessionId: string): Promise<string> {
    const meta = this.cfg.sessionStore?.list().find((m) => m.id === sessionId)
    if (!meta) throw new Error('session_not_found')
    const session = (this.sessions.get(sessionId)?.handle.agent as any)?.session
    if (typeof session?.snapshotEvents === 'function') return sessionDigest(session.snapshotEvents())
    const store = (await this.boot() as any).sessionPersistence
    try { return sessionDigest(await this.eventsOf(store, meta.dshId ?? sessionId)) } catch { return '' }
  }

  // ── 生命周期 ────────────────────────────────────────
  listSessions(): SessionInfo[] { return [...this.sessions.values()].map((l) => ({ ...l.info })) }
  // 正在跑的 dsh 轮次（turn_<n>）：渲染页重载后据此恢复忙状态 / 停止按钮。没在跑返回 undefined
  activeTurn(sessionId: string): string | undefined {
    const l = this.sessions.get(sessionId)
    return l?.turning && l.turn !== undefined ? `turn_${String(l.turn)}` : undefined
  }
  getWorkDir(sessionId: string): string | undefined {
    return this.cfg.sessionStore?.list().find((m) => m.id === sessionId)?.workDir
  }

  // 重连历史会话：resume 同一 sessionId，jsonl 持久化把历史投影回来。
  // 并发去重同 CodeWhale 版（StrictMode 双跑 / 快速重复点击）。
  async reconnectSession(meta: SessionMeta): Promise<SessionInfo> {
    const live = this.sessions.get(meta.id)
    if (live) {
      live.lastUsed = Date.now()
      if (this.replayPending.delete(meta.id)) this.replayHistory(meta.id, live, false)
      return { ...live.info }
    }
    const inFlight = this.starting.get(meta.id)
    if (inFlight) return inFlight
    const p = this.spawn(meta.id, meta, true).finally(() => this.starting.delete(meta.id))
    this.starting.set(meta.id, p)
    return p
  }

  async deleteSession(sessionId: string): Promise<void> {
    const meta = this.cfg.sessionStore?.list().find((m) => m.id === sessionId)
    await this.closeSession(sessionId)
    this.preview.delete(sessionId)
    this.cfg.sessionStore?.remove(sessionId)
    // 连同磁盘上的 dsh 日志一起删（含上下文重置前的旧日志 <id>_xxx），否则删掉的会话日志永远留着占空间。
    // 删日志失败不影响删会话（记录已删、界面已看不到）
    try { await this.removeSessionLogs(sessionId, meta?.dshId) }
    catch (e) { this.cfg.log?.('warn', 'remove session logs failed', { sessionId, err: String(e).slice(0, 200) }) }
  }

  private async removeSessionLogs(sessionId: string, dshId?: string): Promise<void> {
    const store = (await this.boot() as any).sessionPersistence
    const root = resolve(this.cfg.baseDir, 'dsh-sessions')
    const ids = new Set([sessionId, ...(dshId ? [dshId] : [])])
    for (const h of await store.list()) { const d = String(h?.header?.id ?? h?.id ?? ''); if (d.startsWith(`${sessionId}_`)) ids.add(d) }
    for (const id of ids) {
      // 0.2 起 findLog 返回 { sourcePath, currentPath }（按格式版本分代的日志文件，同在会话目录下）
      const found = await store.findLog(id)
      const log: string | undefined = typeof found === 'string' ? found : found?.sourcePath
      if (!log) continue
      const dir = dirname(resolve(log))
      if (!dir.startsWith(root + sep)) continue   // 只删 dsh-sessions 下的会话目录，路径不对就不碰
      await rm(dir, { recursive: true, force: true })
    }
    for (const id of ids) await this.times.remove(id)   // 首次返回时间侧车
  }

  renameSession(sessionId: string, title: string): void {
    const live = this.sessions.get(sessionId)
    if (live) live.info.title = title
    const m = this.cfg.sessionStore?.list().find((x) => x.id === sessionId)
    if (m) this.cfg.sessionStore?.upsert({ ...m, title })
  }

  /**
   * 换工作目录。**这是 dsh 相对 CodeWhale 最大的体验差别**：什么都不用重启。
   *
   * CodeWhale 那边工作目录是 thread 的 workspace，创建时定死改不了，换目录 =
   * 作废 thread（丢整段对话历史）+ 杀进程重启。
   *
   * 这里根本没人关心 agent 的 cwd：我方终端的 cwd 是 createLocalTerminal 时从
   * SessionStore 现读的，dsh 自己的 fs/shell 工具我们压根没 mount。所以换目录
   * 就是改一条记录，对话历史、正在跑的 turn、已开的终端全不受影响。
   */
  async setWorkDir(sessionId: string, workDir: string): Promise<void> {
    const m = this.cfg.sessionStore?.list().find((x) => x.id === sessionId)
    if (!m) throw new Error('session_not_found')
    this.cfg.sessionStore?.upsert({ ...m, workDir })
  }

  /** 上下文重置：换一个新的 dsh 会话（旧日志留在磁盘上不再引用），可选把交接总结当首条消息发出。 */
  async resetContext(sessionId: string, seed?: string): Promise<void> {
    const old = this.cfg.sessionStore?.list().find((x) => x.id === sessionId)
    if (!old) throw new Error('session_not_found')
    const m = { ...old, dshId: `${sessionId}_${randomUUID().slice(0, 8)}` }
    await this.closeSession(sessionId)
    await this.spawn(sessionId, m)          // 不 resume = 新的空会话
    this.cfg.sessionStore?.upsert(m)
    if (seed?.trim()) await this.sendTurn(sessionId, seed)
  }

  /**
   * 从某条用户消息之前分叉（切点见 fork.ts）。回合进行中不行。
   *  - mode='fork'：新会话「原标题（分叉）」，工作目录 / 模型配置照搬（授权不继承，同新建会话），原会话不动；
   *    返回新会话与这条消息的原话（界面据此发改后的内容 / 填进输入框）。
   *  - mode='regenerate'：原地重跑——本会话换成分叉出的 dsh 会话（同上下文重置，旧日志留在磁盘、可搜到），
   *    回放切点之前的历史，再把这条消息原样（含附件）重发。
   */
  async forkSession(sessionId: string, messageId: string, mode: 'fork' | 'regenerate'): Promise<{ session: SessionInfo; text: string }> {
    const src = this.cfg.sessionStore?.list().find((m) => m.id === sessionId)
    if (!src) throw new Error('session_not_found')
    if (!this.sessions.has(sessionId)) await this.reconnectSession(src)
    const live = this.sessions.get(sessionId)
    if (!live) throw new Error('session_not_found')
    // 重新生成时界面已先清空：没动成也要能把历史补回来（界面失败后 reconnect 会重放）
    const bail = (msg: string) => { if (mode === 'regenerate') this.replayPending.add(sessionId); return new Error(msg) }
    if (live.turning) throw bail(tr('turn_in_progress: 本轮还在进行，等它结束（或先停止）再操作'))
    const session = (live.handle.agent as any)?.session
    const events: DshEvent[] = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : []
    let p: ReturnType<typeof forkPoint>
    try { p = forkPoint(events, messageId) } catch (e) { throw bail(e instanceof Error ? e.message : String(e)) }
    const fork: ForkSeed | undefined = p.boundary === undefined ? undefined
      : { seed: buildForkSeed(events as any, p.boundary as any), inherited: p.boundary + 1, parent: live.dshId }
    const now = new Date().toISOString()
    if (mode === 'fork') {
      const id = `sess_${randomUUID().slice(0, 8)}`
      const { dshId: _d, ...rest } = src
      const meta: SessionMeta = { ...rest, id, threadId: id, title: forkTitle(src.title), createdAt: now, lastActiveAt: now }
      await this.times.copy(live.dshId, id, p.turns, p.calls)
      const info = await this.spawn(id, meta, false, fork)
      this.cfg.sessionStore?.upsert(meta)
      return { session: info, text: p.text }
    }
    const meta = { ...src, dshId: `${sessionId}_${randomUUID().slice(0, 8)}` }
    await this.times.copy(live.dshId, meta.dshId, p.turns, p.calls)
    await this.closeSession(sessionId)
    try { await this.spawn(sessionId, meta, false, fork) }
    catch (e) {
      // 新的没起来：回到原来的 dsh 会话，标记待重放（界面清空后 reconnect 补回历史）
      await this.reconnectSession(src).catch(() => {})
      throw bail(e instanceof Error ? e.message : String(e))
    }
    this.cfg.sessionStore?.upsert(meta)
    this.drive(sessionId, JSON.parse(JSON.stringify(p.content)))
    return { session: { ...this.sessions.get(sessionId)!.info }, text: p.text }
  }

  async closeSession(sessionId: string): Promise<void> {
    const live = this.sessions.get(sessionId)
    if (!live) return
    this.sessions.delete(sessionId)
    this.replayPending.delete(sessionId)
    this.dropPendingAsks(sessionId)
    try { await live.handle.dispose() } catch (e) { this.cfg.log?.('warn', 'dispose failed', { sessionId, err: String(e) }) }
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.closeSession(id)
    for (const env of this.keyEnvs) delete process.env[env]
  }
}

// 命中处前后各取一段，压成一行
function snippetAround(text: string, at: number, len: number, pad = 40): string {
  const from = Math.max(0, at - pad), to = Math.min(text.length, at + len + pad)
  return `${from > 0 ? '…' : ''}${text.slice(from, to).replace(/\s+/g, ' ').trim()}${to < text.length ? '…' : ''}`
}

// compaction/summary 的 summary 是 ContentBlock[]，只取文本块
function textBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  return blocks.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n').trim()
}
