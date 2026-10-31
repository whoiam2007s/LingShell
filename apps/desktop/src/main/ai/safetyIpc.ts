// 安全与流程（见 shared/ai/safety.ts）：
//  - 分层规则：分组 / 主机规则存 <配置目录>/rules.json；会话工作目录里的 AGENTS.md / .lingshell/rules.md 按修改时间缓存读取；
//    给引擎的 layeredRules 只出本会话用到过的主机（DshController.touched）+ 工作目录的规则
//  - AI 复核：命中范围的命令弹授权卡前一次性调复核模型（限时 15 秒，超时 = 未复核），按设置给出 拦截 / 自动放行 / 照常弹卡
//  - 预演模式：开关 / 「执行选中步骤」（状态在 DshController，只在内存）
//  - sudo 限时提权：授权卡选了「N 分钟内允许提权」→ AuthRegistry 记到期时间；期间同主机需要提权的命令免卡（leaseDecide）
import { statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJson, writeJson } from '@lingshell/config'
import {
  buildLayeredRules, ruleLayersFor, normalizeRuleText, WORKDIR_RULE_FILES, RULE_TEXT_MAX,
  DEFAULT_AI_REVIEW, AI_REVIEW_TIMEOUT_MS, aiReviewApplies, buildReviewPrompt, parseReviewReply, reviewAction,
  needsElevation, applySudoLease, dangerCheck,
  type LayerRules, type HostSummary, type SystemSettings, type AiReviewResult, type AiReviewAction, type ApprovalAnswer,
  type TrustLevel, type PlanStep, type SafetyChangedEvent, tr,
} from '@lingshell/shared'
import type { ReviewRequest, ApprovalRequest } from '@lingshell/dsh-controller'
import { knowledgeHosts } from './knowledgeIpc.js'

export interface SafetyDeps {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  dir: string                                    // 配置目录（rules.json）
  hosts(): HostSummary[]
  sys(): SystemSettings
  auth: {
    getTrust(sid: string): TrustLevel
    grantSudo(sid: string, hostKey: string, minutes: number): number
    sudoUntil(sid: string, hostKey: string): number | undefined
    listSudo(sid: string): { hostKey: string; until: number }[]
    revokeSudo(sid: string, hostKey: string): boolean
  }
  isReadOnly(cmd: string): boolean
  knowledgeTitles(hostKey: string): string[]
  complete(system: string, user: string, signal: AbortSignal, source: string, profileId?: string): Promise<string>
  profileName(profileId?: string): string
  preview: { get(sid: string): boolean; set(sid: string, on: boolean): void; approve(sid: string, steps: PlanStep[]): number }
  unattended?(sid: string): boolean
  send(ev: SafetyChangedEvent): void
  redact?(text: string): string                  // 发给复核模型前脱敏（命令 / diff / 说明 / 上下文）
  log?(level: 'info' | 'warn', message: string, data?: unknown): void
}

const EMPTY: LayerRules = { groups: {}, hosts: {} }
const SUDO_TOOLS = new Set(['exec_in_terminal', 'start_background'])

export function registerSafety(d: SafetyDeps) {
  const file = join(d.dir, 'rules.json')
  const readRules = (): LayerRules => {
    const r = readJson<Partial<LayerRules>>(file)
    return { groups: { ...EMPTY.groups, ...(r?.groups ?? {}) }, hosts: { ...EMPTY.hosts, ...(r?.hosts ?? {}) } }
  }
  const setRule = (kind: 'groups' | 'hosts', k: unknown, text: unknown) => {
    if (typeof k !== 'string' || !k.trim()) throw new Error(kind === 'groups' ? tr('分组名为空') : tr('主机 id 为空'))
    const r = readRules()
    const t = normalizeRuleText(text)
    if (t) r[kind][k.trim()] = t; else delete r[kind][k.trim()]
    writeJson(file, r)
  }

  // 工作目录规则文件：按 (路径, 修改时间) 缓存，每次模型请求只 stat 不重读
  const cache = new Map<string, { mtime: number; text: string }>()
  const readRuleFile = (p: string): string => {
    try {
      const st = statSync(p)
      if (!st.isFile()) return ''
      const hit = cache.get(p)
      if (hit && hit.mtime === st.mtimeMs) return hit.text
      const text = st.size > RULE_TEXT_MAX * 4 ? readFileSync(p, 'utf8').slice(0, RULE_TEXT_MAX * 2) : readFileSync(p, 'utf8')
      cache.set(p, { mtime: st.mtimeMs, text })
      return text
    } catch { cache.delete(p); return '' }
  }
  const workdirRules = (workDir?: string) => (workDir ? WORKDIR_RULE_FILES.map((f) => ({ file: f, text: readRuleFile(join(workDir, f)) })).filter((w) => w.text.trim()) : [])
  const hostLayers = (hostKeys: string[]) => knowledgeHosts(d.hosts()).filter((h) => hostKeys.includes(h.hostKey))

  // ── sudo 限时提权 ──
  const hostOf = (k: string) => d.hosts().find((h) => h.id === k)
  const elevation = (hostKey: string, command?: string) =>
    needsElevation(command, { rootUser: hostOf(hostKey)?.username === 'root', readOnly: command ? d.isReadOnly(command) : true })
  const changed = (sessionId: string, what: SafetyChangedEvent['what']) => d.send({ type: 'safety:changed', sessionId, what })

  d.handle('safety:rules', () => readRules())
  d.handle('safety:setGroupRules', (_e, g, t) => setRule('groups', g, t))
  d.handle('safety:setHostRules', (_e, id, t) => setRule('hosts', id, t))
  d.handle('safety:preview', (_e, sid) => typeof sid === 'string' && d.preview.get(sid))
  d.handle('safety:setPreview', (_e, sid, on) => {
    if (typeof sid !== 'string' || !sid) return
    d.preview.set(sid, on === true)
    changed(sid, 'preview')
  })
  d.handle('safety:approvePlan', (_e, sid, steps) => {
    if (typeof sid !== 'string' || !sid) return
    d.preview.approve(sid, Array.isArray(steps) ? steps as PlanStep[] : [])
    changed(sid, 'preview')
  })
  d.handle('safety:sudoLeases', (_e, sid) => (typeof sid === 'string' ? d.auth.listSudo(sid) : []))
  d.handle('safety:revokeSudo', (_e, sid, hk) => {
    if (typeof sid !== 'string' || typeof hk !== 'string') return
    d.auth.revokeSudo(sid, hk)
    changed(sid, 'sudo')
  })

  return {
    /** 引擎每次模型请求现求值：本会话用到过的主机（分组 → 主机）+ 工作目录的规则 */
    layeredRules: (hostKeys: string[], workDir?: string): string =>
      buildLayeredRules(ruleLayersFor(readRules(), hostLayers(hostKeys), workdirRules(workDir))),

    /** AI 复核：不在范围 / 没开 → undefined */
    async review(req: ReviewRequest): Promise<{ review: AiReviewResult; action: AiReviewAction } | undefined> {
      const cfg = { ...DEFAULT_AI_REVIEW, ...(d.sys().aiReview ?? {}) }
      if (!cfg.enabled || d.unattended?.(req.sessionId)) return undefined
      const prod = req.hostKeys.some((k) => hostOf(k)?.env === 'prod')
      const write = req.tool === 'write_file' || !d.isReadOnly(req.command)
      const dangerous = req.risk === 'dangerous' || dangerCheck(req.command) === 'dangerous'
      if (!aiReviewApplies(cfg.scope, { prod, write, dangerous })) return undefined
      const hs = hostLayers(req.hostKeys)
      const clean = d.redact ?? ((s: string) => s)
      const p = buildReviewPrompt({
        tool: req.tool, command: clean(req.command), diff: req.diff && clean(req.diff), explain: req.explain && clean(req.explain),
        rollback: req.rollback && clean(req.rollback),
        hosts: hs.map((h) => ({ label: h.label, env: hostOf(h.hostKey)?.env })), context: clean(req.context),
        rules: buildLayeredRules(ruleLayersFor(readRules(), hs)), knowledge: req.hostKeys.flatMap(d.knowledgeTitles),
      })
      const ac = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_r, reject) => { timer = setTimeout(() => { ac.abort(); reject(new Error('timeout')) }, AI_REVIEW_TIMEOUT_MS) })
      let review: AiReviewResult
      try { review = parseReviewReply(await Promise.race([d.complete(p.system, p.user, ac.signal, 'ai-review', cfg.profileId), timeout])) }
      catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        review = { verdict: 'unreviewed', reason: ac.signal.aborted ? tr('复核超时（{n} 秒），按未复核处理', { n: AI_REVIEW_TIMEOUT_MS / 1000 }) : tr('复核失败：{err}', { err: msg.slice(0, 120) }) }
      } finally { clearTimeout(timer) }
      review.model = d.profileName(cfg.profileId)
      d.log?.('info', 'ai review', { sessionId: req.sessionId, tool: req.tool, verdict: review.verdict })
      return { review, action: reviewAction(review, { onBlock: cfg.onBlock, autoAllowSafe: cfg.autoAllowSafe, prod, trust: d.auth.getTrust(req.sessionId), dangerous }) }
    },

    /** 授权决策叠上限时提权（AI 工具网关用） */
    leaseDecide: <D extends { kind: string; reason?: string; rule?: string }>(sid: string, hostKey: string, command: string | undefined, dec: D) =>
      applySudoLease(dec, { active: d.auth.sudoUntil(sid, hostKey) !== undefined, elevation: elevation(hostKey, command) }),

    /** 授权卡：需要提权的单主机命令带 sudo 标记（卡上给「N 分钟内允许提权」） */
    decorate: <R extends ApprovalRequest>(req: R): R & { sudo?: boolean } =>
      SUDO_TOOLS.has(req.tool) && !req.targets?.length && elevation(req.terminalId, req.command) ? { ...req, sudo: true } : req,

    /** 用户的回答：允许 + 选了提权时长 → 记限时提权，到期发事件让界面刷新 */
    onAnswer(req: ApprovalRequest & { sudo?: boolean }, ans: ApprovalAnswer): void {
      if (ans.decision !== 'allow' || !req.sudo || !ans.sudoMinutes) return
      const until = d.auth.grantSudo(req.sessionId, req.terminalId, ans.sudoMinutes)
      d.log?.('info', 'sudo lease granted', { sessionId: req.sessionId, hostKey: req.terminalId, minutes: ans.sudoMinutes })
      changed(req.sessionId, 'sudo')
      setTimeout(() => changed(req.sessionId, 'sudo'), until - Date.now() + 500).unref?.()
    },
  }
}
