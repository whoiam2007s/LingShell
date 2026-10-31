// 部署评审：研发给的部署文档 + 产物 → AI 解读成结构化部署清单 → 规则 / AI 找风险 → 目标主机只读预检 → 评审结论 → 报告 / 转运维手册。
// 这里只放纯函数（数据结构、规则检查、提示词与解析、报告），读文件 / 调模型 / 连主机在 desktop 的 deployReviewIpc.ts
import { dangerCheck } from '../ai/danger.js'
import { redactSecrets } from '../ai/redact.js'
import { diffLines } from '../files/diff.js'
import { guessStepKind, normalizeRunbook, type RunbookInput } from './runbook.js'
import { dateLocale, tk, tr } from '../i18n/i18n.js'

export type ReviewLevel = 'high' | 'medium' | 'low'
export type RiskDecision = 'open' | 'accept' | 'ignore' | 'rework'
export type RiskSource = 'rule' | 'ai' | 'probe'
export interface ReviewRisk {
  id: string                 // 规则 / AI / 预检各自稳定的 id：重新分析时按 id 保留评审意见
  level: ReviewLevel
  category: string
  title: string
  detail: string
  evidence?: string          // 依据：文档原文 / 预检输出
  suggestion?: string
  source: RiskSource
  decision: RiskDecision
  note?: string              // 评审备注（忽略的理由等）
}
export interface PlanPrereq { item: string; requirement: string; check?: string }   // check：一条只读检查命令
export interface DeployStep { title: string; command?: string; downtime?: boolean; rollback?: string }
export interface DeployPlan {
  summary: string
  prerequisites: PlanPrereq[]
  steps: DeployStep[]
  configChanges: string[]
  dbChanges: string[]
  verify: string[]
  rollback: string[]
}
export interface ReviewArtifact { name: string; size: number; sha256: string; entries?: string[] }
export type DeployProbeStatus = 'pass' | 'warn' | 'fail' | 'error' | 'skipped'
export interface DeployProbeRow { hostId: string; hostLabel: string; item: string; requirement: string; command: string; output: string; code?: number; status: DeployProbeStatus; note: string }
export interface DocVersion { at: string; name: string; text: string }
export type ReviewConclusion = 'pass' | 'conditional' | 'fail'
export type ReviewEnv = 'test' | 'prod'
export interface DeployReview {
  id: string
  title: string
  env: ReviewEnv
  hostIds: string[]
  docName: string
  docText: string
  docAt?: string             // 当前文档导入时间（晚于 analyzedAt = 文档改过、要重新解读）
  history: DocVersion[]      // 之前导入过的文档版本（最新的在最后）
  artifacts: ReviewArtifact[]
  plan?: DeployPlan
  analyzedAt?: string
  planTruncated?: boolean    // 文档超过模型单次读取上限，清单和 AI 风险只覆盖了前面一部分（规则检查仍看全文）
  risks: ReviewRisk[]
  probes: DeployProbeRow[]
  probedAt?: string
  conclusion?: ReviewConclusion
  reviewer: string
  opinion: string
  createdAt: string
  updatedAt: string
}
/** 界面上能改的字段（评审意见按风险 id 给） */
export interface DeployReviewPatch {
  title?: string; env?: 'test' | 'prod'; hostIds?: string[]; reviewer?: string; opinion?: string; conclusion?: ReviewConclusion | null
  decisions?: Record<string, { decision: RiskDecision; note?: string }>
}
export interface DeployReviewSummary { id: string; title: string; env: ReviewEnv; docName: string; conclusion?: ReviewConclusion; openHigh: number; risks: number; updatedAt: string }

export const REVIEW_LEVEL_LABEL: Record<ReviewLevel, string> = { high: tk('高'), medium: tk('中'), low: tk('低') }
export const RISK_DECISION_LABEL: Record<RiskDecision, string> = { open: tk('待处理'), accept: tk('已接受'), ignore: tk('忽略'), rework: tk('退回研发修改') }
export const CONCLUSION_LABEL: Record<ReviewConclusion, string> = { pass: tk('通过'), conditional: tk('有条件通过'), fail: tk('不通过') }
export const DEPLOY_PROBE_LABEL: Record<DeployProbeStatus, string> = { pass: tk('符合'), warn: tk('注意'), fail: tk('不符合'), error: tk('执行失败'), skipped: tk('未执行') }
export const DOC_MAX_CHARS = 60_000
const LEVELS: ReviewLevel[] = ['high', 'medium', 'low']

export function emptyReview(id: string, now = new Date().toISOString()): DeployReview {
  return { id, title: '', env: 'test', hostIds: [], docName: '', docText: '', history: [], artifacts: [], risks: [], probes: [], reviewer: '', opinion: '', createdAt: now, updatedAt: now }
}

export function reviewSummary(r: DeployReview): DeployReviewSummary {
  return { id: r.id, title: r.title || r.docName || tr('未命名评审'), env: r.env, docName: r.docName, ...(r.conclusion ? { conclusion: r.conclusion } : {}), openHigh: r.risks.filter((x) => x.level === 'high' && (x.decision === 'open' || x.decision === 'rework')).length, risks: r.risks.length, updatedAt: r.updatedAt }
}

/** 稳定短 hash（风险 id 用：同一条风险重新分析后 id 不变，评审意见能保留） */
export function reviewHash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

const lineNo = (text: string, i: number) => text.slice(0, i).split('\n').length
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const PLACEHOLDER_RE = /\$\{[^}\n]*\}|\{\{[^}\n]*\}\}|<[^<>\s]{1,40}>|%[A-Za-z_]\w*%/g
const SQL_FILE_RE = /[\w-]\.sql(?=$|[\s"'`)，。、；])/m   // 只认 xxx.sql 文件名，不认 hibernate.SQL=INFO 这类配置键
const VERSION_RE = /\d+\.\d+(?:\.\d+)*(?:[-_.]?(?:rc|beta|alpha|snapshot|release)\.?\d*)?/i

/** 文档里的命令：代码块里的每一行 + 清单里步骤的命令 */
export function docCommands(text: string, plan?: DeployPlan): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/```[\w-]*[ \t]*\n([\s\S]*?)```/g)) {
    for (const line of m[1].split('\n')) {
      const c = line.replace(/^\s*[$#]\s+/, '').trim()
      if (c && !c.startsWith('#') && !c.startsWith('//')) out.push(c)
    }
  }
  for (const s of plan?.steps ?? []) if (s.command) out.push(...s.command.split('\n').map((x) => x.trim()).filter(Boolean))
  return [...new Set(out)]
}

/**
 * 确定性规则检查（不靠模型，结果稳定）：明文密码、高危命令、没回滚、改库没备份、没验证、停机没说明、产物和文档对不上
 */
export function ruleRisks(r: Pick<DeployReview, 'docText' | 'artifacts'> & { plan?: DeployPlan }): ReviewRisk[] {
  const doc = r.docText, plan = r.plan
  const out: ReviewRisk[] = []
  // 证据是文档原文，会进报告：一律脱敏
  const add = (key: string, level: ReviewLevel, category: string, title: string, detail: string, evidence?: string, suggestion?: string) =>
    out.push({ id: `rule-${key}`, level, category, title, detail, ...(evidence ? { evidence: redactSecrets(evidence) } : {}), ...(suggestion ? { suggestion } : {}), source: 'rule', decision: 'open' })

  // 明文密码 / token（证据里也是脱敏后的）
  // 占位符（${DB_PWD}、{{pwd}}、<密码>、%PWD%）不是明文：抹掉后还有密码才算
  const secretLines = doc.split('\n').flatMap((l, i) => (redactSecrets(l.replace(PLACEHOLDER_RE, '')) !== l.replace(PLACEHOLDER_RE, '') ? [tr('第 {n} 行：{text}', { n: i + 1, text: redactSecrets(l).trim().slice(0, 160) })] : []))
  if (secretLines.length) add('secret', 'high', tr('安全'), tr('文档里有 {n} 处明文密码 / 密钥', { n: secretLines.length }), tr('部署文档会在多人之间流转、进工单和聊天记录，明文凭据容易泄露。'), secretLines.slice(0, 8).join('\n'), tr('改成从密钥保险箱 / 环境变量 / 配置中心读取，文档里只写占位符'))

  // 高危命令
  const danger = docCommands(doc, plan).filter((c) => dangerCheck(c) === 'dangerous')
  if (danger.length) add('danger', 'medium', tr('高危操作'), tr('有 {n} 条高危命令', { n: danger.length }), tr('删除、覆盖、重启、改权限等操作执行错了难以挽回，需逐条确认目标路径 / 对象是否正确、是否有备份。'), danger.slice(0, 10).join('\n'), tr('确认每条命令的目标；能用 mv 改名代替 rm 的就改名，删除前先备份'))

  // 回滚
  const hasRollback = /回滚|回退|rollback|roll back|恢复旧版本|还原/i.test(doc) || !!plan?.rollback.length || !!plan?.steps.some((s) => s.rollback)
  if (!hasRollback) add('rollback', 'high', tr('回滚'), tr('没有回滚方案'), tr('部署失败时无法快速恢复到上一版本，只能现场排查，故障时间不可控。'), undefined, tr('补充回滚步骤：旧版本产物 / 配置 / 数据的保留位置，以及按什么顺序恢复'))

  // 改数据库但没提备份
  const dbM = /\b(alter\s+table|drop\s+(table|column|index|database)|truncate\s+table|create\s+table|flyway|liquibase|migrat\w*)\b|数据库(变更|迁移|升级)|执行\s*sql/i.exec(doc) ?? SQL_FILE_RE.exec(doc)
  const dbChange = !!plan?.dbChanges.length || !!dbM
  if (dbChange && !/备份|backup|mysqldump|pg_dump|xtrabackup|快照|snapshot/i.test(doc)) {
    add('db-backup', 'high', tr('数据库'), tr('有数据库变更，但没提到先备份'), tr('表结构 / 数据变更一旦出错（或需要回滚）没有备份就无法恢复。'), dbM ? tr('第 {n} 行：{text}', { n: lineNo(doc, dbM.index), text: doc.split('\n')[lineNo(doc, dbM.index) - 1].trim().slice(0, 160) }) : plan?.dbChanges.slice(0, 3).join('\n'), tr('变更前先全量备份涉及的库 / 表，并写明备份文件位置和恢复命令'))
  }

  // 验证步骤
  if (!plan?.verify.length && !/验证|校验|检查是否|健康检查|health|curl\s|冒烟|smoke/i.test(doc)) add('verify', 'medium', tr('验证'), tr('没有部署后的验证步骤'), tr('不知道怎样算部署成功，问题可能到用户反馈才发现。'), undefined, tr('补充验证方法：健康检查接口、关键页面 / 接口、日志关键字、监控指标'))

  // 停机
  if (plan?.steps.some((s) => s.downtime) && !/停机|维护窗口|影响时长|中断|downtime|不可用/i.test(doc)) {
    add('downtime', 'medium', tr('停机'), tr('有中断服务的步骤，但没说明停机时间和影响'), tr('没有提前通知业务方和安排维护窗口，线上会出现意外中断。'), plan.steps.filter((s) => s.downtime).map((s) => s.title).slice(0, 6).join('\n'), tr('写明预计停机时长、影响范围，安排维护窗口'))
  }

  // 产物：校验值、文档里有没有提到、版本号一致不一致
  if (r.artifacts.length) {
    const hashes = new Set([...doc.matchAll(/\b[a-f0-9]{64}\b/gi)].map((m) => m[0].toLowerCase()))
    if (!hashes.size) add('checksum-missing', 'low', tr('产物'), tr('文档没有给出产物的校验值'), tr('无法确认拿到的产物就是研发构建、测试过的那一份。'), undefined, tr('在文档里附上每个产物的 sha256'))
    for (const a of r.artifacts) {
      const k = reviewHash(a.name)
      if (hashes.size && !hashes.has(a.sha256.toLowerCase())) add(`checksum-${k}`, 'high', tr('产物'), tr('「{name}」的 sha256 和文档里写的都对不上', { name: a.name }), tr('产物可能被替换、损坏，或者拿错了版本。'), tr('实际：{v}', { v: a.sha256 }), tr('找研发确认正确的产物，重新下载后再核对'))
      const v = VERSION_RE.exec(a.name)
      const prefix = v ? a.name.slice(0, v.index).replace(/[-_.]$/, '') : ''
      const mentioned = doc.toLowerCase().includes(a.name.toLowerCase())
      if (v && prefix.length >= 2) {
        const others = [...doc.matchAll(new RegExp(`${reEsc(prefix)}[-_.]?(${VERSION_RE.source})`, 'gi'))].map((m) => m[1]).filter((x) => x.toLowerCase() !== v[0].toLowerCase())
        if (!mentioned && others.length) { add(`version-${k}`, 'high', tr('产物'), tr('「{name}」的版本和文档不一致', { name: a.name }), tr('产物版本是 {v}，文档里写的是 {others}。', { v: v[0], others: [...new Set(others)].join(tr('、')) }), undefined, tr('确认要部署的版本，统一文档和产物')); continue }
      }
      if (!mentioned && !(prefix && doc.toLowerCase().includes(prefix.toLowerCase()))) add(`unmentioned-${k}`, 'medium', tr('产物'), tr('文档里没提到产物「{name}」', { name: a.name }), tr('这个产物不知道该怎么部署，或者文档漏写了步骤 / 产物给多了。'), undefined, tr('确认它的用途并在文档里补上对应步骤'))
    }
  }
  return out
}

/** 重新分析后合并：同 id 的保留评审意见；新结果里没有了的旧风险丢掉（已经不成立） */
export function mergeRisks(prev: ReviewRisk[], fresh: ReviewRisk[]): ReviewRisk[] {
  const old = new Map(prev.map((x) => [x.id, x]))
  const seen = new Set<string>()
  return fresh.filter((x) => !seen.has(x.id) && seen.add(x.id)).map((x) => {
    const o = old.get(x.id)
    return o ? { ...x, decision: o.decision, ...(o.note ? { note: o.note } : {}) } : x
  }).sort((a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level))
}

// ── AI 解读 ──

export function buildPlanPrompt(r: { docText: string; docName: string; artifacts: ReviewArtifact[]; env: ReviewEnv }): { system: string; user: string; truncated: boolean } {
  const truncated = r.docText.length > DOC_MAX_CHARS
  // 以下是发给模型的提示词，不翻译
  const system = [
    '你是资深运维，正在评审研发提交的部署文档，部署前要提前识别风险。请把文档整理成结构化的部署清单，并找出问题。',   // i18n-ignore 提示词
    '只输出一个 JSON 对象（不要代码块、不要其他文字），字段：',   // i18n-ignore 提示词
    '{"summary":"一两句话说明这次部署了什么、怎么部署",',   // i18n-ignore 提示词
    ' "prerequisites":[{"item":"检查项，如 JDK 版本","requirement":"文档要求，如 17 及以上","check":"在目标 Linux 主机上验证它的一条只读命令，如 java -version 2>&1"}],',   // i18n-ignore 提示词
    ' "steps":[{"title":"步骤说明","command":"要执行的命令（多条用换行分隔，没有就空字符串）","downtime":是否会中断服务,"rollback":"这一步怎么撤回，文档没写就空字符串"}],',   // i18n-ignore 提示词
    ' "configChanges":["要改的配置文件和参数"],"dbChanges":["数据库变更"],"verify":["部署后的验证方法"],"rollback":["整体回滚步骤"],',   // i18n-ignore 提示词
    ' "risks":[{"level":"high|medium|low","category":"分类，如 顺序/依赖/配置/数据库/权限/资源/兼容性/描述不清","title":"一句话问题","detail":"为什么是问题、可能的后果","evidence":"引用文档原文","suggestion":"建议怎么改"}]}',   // i18n-ignore 提示词
    '要求：',   // i18n-ignore 提示词
    '1. 清单忠实于文档，不要编造文档里没有的步骤；文档没写的字段给空数组。',   // i18n-ignore 提示词
    '2. prerequisites 覆盖文档提到的系统 / 依赖版本、端口、磁盘与内存、目录与权限、账号、外部依赖（数据库、缓存、消息队列、域名等）的连通性。',   // i18n-ignore 提示词
    '   check 必须是只读命令：不改任何东西、不用 sudo、不重启服务、不交互，适合直接在 bash 里跑并尽快返回（连通性用 timeout 3 bash -c "</dev/tcp/主机/端口" 这类写法）；想不出安全的检查命令就给空字符串。',   // i18n-ignore 提示词
    '3. risks 重点找：步骤顺序不合理（如没停服务就迁库、先切流量后验证）、依赖缺失或版本冲突、配置项缺失或前后矛盾、描述含糊没法照着执行、缺少回滚 / 备份 / 验证、停机影响没说明、权限过大、硬编码环境相关的值。',   // i18n-ignore 提示词
    '4. 这些已由规则检查覆盖，不要再报（除非有规则看不出的具体问题，如 Flyway 随启动自动迁移的时机）：明文密码 / 密钥、缺少回滚方案、改数据库前没提备份、缺少部署后验证、停机影响没说明、高危命令、产物校验值 / 版本与文档不一致。',   // i18n-ignore 提示词
    `5. 目标环境是${r.env === 'prod' ? '生产环境，风险要从严判断' : '测试环境'}。`,   // i18n-ignore 提示词
  ].join('\n')
  // i18n-ignore-next 提示词
  const arts = r.artifacts.length ? `\n\n随文档提供的产物：\n${r.artifacts.map((a) => `- ${a.name}（${a.size} 字节，sha256 ${a.sha256}）${a.entries?.length ? `，包内文件：${a.entries.slice(0, 40).join('，')}${a.entries.length > 40 ? ' 等' : ''}` : ''}`).join('\n')}` : ''
  // i18n-ignore-next 提示词
  return { system, user: `部署文档《${r.docName}》：\n${r.docText.slice(0, DOC_MAX_CHARS)}${truncated ? '\n…（文档过长，后面的内容已截断）' : ''}${arts}`, truncated }
}

const str = (v: unknown, max = 2000) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v)).trim().slice(0, max)
const strs = (v: unknown) => (Array.isArray(v) ? v.map((x) => str(typeof x === 'object' && x ? Object.values(x).join(' ') : x, 1000)).filter(Boolean) : [])
const objs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : [])
function jsonOf(raw: string, open: '{' | '['): unknown {
  const s = raw.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '').replace(/```(?:json)?/g, '').trim()
  const i = s.indexOf(open), j = s.lastIndexOf(open === '{' ? '}' : ']')
  if (i < 0 || j < i) return undefined
  try { return JSON.parse(s.slice(i, j + 1)) } catch { return undefined }
}
const levelOf = (v: unknown): ReviewLevel => (v === 'high' || v === 'low' ? v : 'medium')

export function parsePlanReply(raw: string): { plan: DeployPlan; risks: ReviewRisk[] } | { error: string } {
  const o = jsonOf(raw, '{')
  if (!o || typeof o !== 'object') return { error: tr('模型没有按格式返回，请重试') }
  const j = o as Record<string, unknown>
  const plan: DeployPlan = {
    summary: str(j.summary),
    prerequisites: objs(j.prerequisites).map((p) => ({ item: str(p.item, 200), requirement: str(p.requirement, 500), ...(str(p.check, 500) ? { check: str(p.check, 500) } : {}) })).filter((p) => p.item),
    steps: objs(j.steps).map((s) => ({ title: str(s.title, 300), ...(str(s.command, 4000) ? { command: str(s.command, 4000) } : {}), ...(s.downtime === true ? { downtime: true } : {}), ...(str(s.rollback, 1000) ? { rollback: str(s.rollback, 1000) } : {}) })).filter((s) => s.title || s.command),
    configChanges: strs(j.configChanges), dbChanges: strs(j.dbChanges), verify: strs(j.verify), rollback: strs(j.rollback),
  }
  if (!plan.summary && !plan.steps.length && !plan.prerequisites.length) return { error: tr('模型没有整理出部署清单，请重试') }
  const risks = objs(j.risks).map((x): ReviewRisk => {
    const title = str(x.title, 200), category = str(x.category, 40) || tr('其他')
    return { id: `ai-${reviewHash(category + title)}`, level: levelOf(x.level), category, title, detail: str(x.detail), ...(str(x.evidence) ? { evidence: str(x.evidence) } : {}), ...(str(x.suggestion) ? { suggestion: str(x.suggestion) } : {}), source: 'ai', decision: 'open' }
  }).filter((x) => x.title)
  return { plan, risks }
}

// ── 环境预检 ──

const MARK = '@@LS-PROBE'
/** 一台主机上跑的预检脚本：每条检查前后打标记，一次 exec 拿全部结果 */
export function deployProbeScript(checks: string[]): string {
  // 不用 PIPESTATUS：登录 shell 可能是 dash
  return checks.map((c, i) => `echo '${MARK} ${i}@@'; o=$( ( ${c}\n) 2>&1 </dev/null ); r=$?; printf '%s\\n' "$o" | head -c 4000; echo; echo "${MARK}-RC $r@@"`).join('\n')
}
export function parseDeployProbe(out: string, n: number): { output: string; code?: number }[] {
  const res: { output: string; code?: number }[] = Array.from({ length: n }, () => ({ output: '' }))
  const re = new RegExp(`${MARK} (\\d+)@@\\n([\\s\\S]*?)${MARK}-RC (\\d+)@@`, 'g')
  for (const m of out.replace(/\r\n/g, '\n').matchAll(re)) {
    const i = Number(m[1])
    if (i < n) res[i] = { output: m[2].replace(/\n+$/, ''), code: Number(m[3]) }
  }
  return res
}

export function buildProbeJudgePrompt(rows: DeployProbeRow[]): { system: string; user: string } {
  const system = [
    '你是资深运维。下面是部署前在目标主机上执行只读检查得到的结果，请逐条判断主机是否满足部署文档的要求。',   // i18n-ignore 提示词
    '只输出 JSON 数组（不要代码块、不要其他文字）：[{"i":序号,"status":"pass|warn|fail","note":"一句话结论，如 实际 JDK 11，要求 17"}]',   // i18n-ignore 提示词
    'pass = 满足；fail = 明确不满足（版本过低、端口被占、磁盘不够、连不上等）；warn = 无法确定或接近临界值。',   // i18n-ignore 提示词
  ].join('\n')
  // i18n-ignore-next 提示词
  const user = rows.map((r, i) => `#${i} 主机 ${r.hostLabel}｜检查项：${r.item}｜要求：${r.requirement}\n命令：${r.command}\n退出码：${r.code ?? '无'}\n输出：\n${r.output.slice(0, 1500) || '（无输出）'}`).join('\n\n')
  return { system, user }
}
/** 预检判定分批：主机多时行数远超一次模型调用能稳稳吃下的量（每行输出最多 1500 字），拆开调用；某批失败只影响这批 */
export function chunkProbeRows(rows: DeployProbeRow[], maxRows = 24, maxChars = 30_000): { start: number; rows: DeployProbeRow[] }[] {
  const out: { start: number; rows: DeployProbeRow[] }[] = []
  let start = 0, cur: DeployProbeRow[] = [], n = 0
  rows.forEach((r, i) => {
    const sz = r.item.length + r.requirement.length + r.command.length + Math.min(r.output.length, 1500) + 120
    if (cur.length && (cur.length >= maxRows || n + sz > maxChars)) { out.push({ start, rows: cur }); start = i; cur = []; n = 0 }
    cur.push(r); n += sz
  })
  if (cur.length) out.push({ start, rows: cur })
  return out
}

export function applyProbeJudge(rows: DeployProbeRow[], raw: string): DeployProbeRow[] {
  const arr = jsonOf(raw, '[')
  const by = new Map(objs(arr).map((x) => [Number(x.i), x]))
  return rows.map((r, i) => {
    const j = by.get(i)
    if (!j || r.status === 'error' || r.status === 'skipped') return r
    const status: DeployProbeStatus = j.status === 'pass' || j.status === 'fail' ? j.status : 'warn'
    return { ...r, status, note: str(j.note, 300) || r.note }
  })
}

export function probeRisks(rows: DeployProbeRow[]): ReviewRisk[] {
  const out: ReviewRisk[] = []
  for (const st of ['fail', 'error'] as const) {
    const by = new Map<string, DeployProbeRow[]>()
    for (const r of rows.filter((x) => x.status === st)) by.set(r.item, [...(by.get(r.item) ?? []), r])
    for (const [item, rs] of by) {
      out.push({
        id: `probe-${st}-${reviewHash(item)}`, level: st === 'fail' ? 'high' : 'medium', category: tr('环境'), source: 'probe', decision: 'open',
        title: st === 'fail' ? tr('{n} 台主机不满足：{item}', { n: rs.length, item }) : tr('{n} 台主机没能检查：{item}', { n: rs.length, item }),
        detail: tr('要求：{v}', { v: rs[0].requirement }),
        evidence: rs.map((r) => `${r.hostLabel}${tr('：')}${r.note || r.output.split('\n')[0]}`).join('\n').slice(0, 2000),
        suggestion: st === 'fail' ? tr('部署前先把环境调整到符合要求，或和研发确认要求是否可以放宽') : tr('登录主机手动确认'),
      })
    }
  }
  return out
}

// ── 结论、报告、转手册、文档对比 ──

export function suggestConclusion(r: Pick<DeployReview, 'risks'>): ReviewConclusion {
  const live = r.risks.filter((x) => x.decision === 'open' || x.decision === 'rework')
  if (live.some((x) => x.level === 'high') || r.risks.some((x) => x.decision === 'rework')) return 'fail'
  return live.length ? 'conditional' : 'pass'
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
const fence = (s: string) => `\`\`\`\n${s.replace(/```/g, "'''")}\n\`\`\``

export function reviewMarkdown(r: DeployReview, hostLabels: Record<string, string> = {}): string {
  const p = r.plan
  const count = (lv: ReviewLevel) => r.risks.filter((x) => x.level === lv).length
  const L: string[] = [
    `# ${tr('部署评审报告：{title}', { title: r.title || r.docName || tr('未命名') })}`, '',
    `| ${tr('项目')} | ${tr('内容')} |`, '|---|---|',
    `| ${tr('部署文档')} | ${cell(r.docName || '—')}${r.history.length ? tr('（第 {n} 版）', { n: r.history.length + 1 }) : ''} |`,
    `| ${tr('目标环境')} | ${r.env === 'prod' ? tr('生产环境') : tr('测试环境')} |`,
    `| ${tr('目标主机')} | ${cell(r.hostIds.map((id) => hostLabels[id] ?? id).join(tr('、')) || '—')} |`,
    `| ${tr('评审人')} | ${cell(r.reviewer || '—')} |`,
    `| ${tr('评审结论')} | **${r.conclusion ? tr(CONCLUSION_LABEL[r.conclusion]) : tr('未给出')}** |`,
    `| ${tr('风险')} | ${tr('高 {high} · 中 {medium} · 低 {low}（待处理 {open}）', { high: count('high'), medium: count('medium'), low: count('low'), open: r.risks.filter((x) => x.decision === 'open').length })} |`,
    `| ${tr('生成时间')} | ${new Date().toLocaleString(dateLocale(), { hour12: false })} |`, '',
  ]
  if (r.opinion.trim()) L.push(`## ${tr('评审意见')}`, '', r.opinion.trim(), '')
  if (p?.summary) L.push(`## ${tr('部署概述')}`, '', p.summary, '')
  L.push(`## ${tr('风险清单')}`, '')
  if (!r.risks.length) L.push(tr('未发现风险。'), '')
  else {
    L.push(`| # | ${tr('等级')} | ${tr('分类')} | ${tr('问题')} | ${tr('处理')} | ${tr('来源')} |`, '|---|---|---|---|---|---|')
    const srcLabel = { rule: tr('规则'), ai: 'AI', probe: tr('环境预检') }
    r.risks.forEach((x, i) => L.push(`| ${i + 1} | ${tr(REVIEW_LEVEL_LABEL[x.level])} | ${cell(x.category)} | ${cell(x.title)} | ${tr(RISK_DECISION_LABEL[x.decision])}${x.note ? `${tr('：')}${cell(x.note)}` : ''} | ${srcLabel[x.source]} |`))
    L.push('')
    r.risks.forEach((x, i) => {
      L.push(`### ${i + 1}. [${tr(REVIEW_LEVEL_LABEL[x.level])}] ${x.title}`, '', x.detail)
      // 依据可能来自文档原文 / 预检输出，报告会外发：统一再按样式脱敏（幂等）
      if (x.evidence) L.push('', tr('依据：'), '', fence(redactSecrets(x.evidence)))
      if (x.suggestion) L.push('', tr('建议：{v}', { v: x.suggestion }))
      L.push('')
    })
  }
  if (r.probes.length) {
    L.push(`## ${tr('环境预检')}`, '', tr('检查时间：{t}（只读命令）', { t: r.probedAt ? new Date(r.probedAt).toLocaleString(dateLocale(), { hour12: false }) : '—' }), '', `| ${tr('主机')} | ${tr('检查项')} | ${tr('要求')} | ${tr('结果')} | ${tr('说明')} |`, '|---|---|---|---|---|')
    for (const x of r.probes) L.push(`| ${cell(x.hostLabel)} | ${cell(x.item)} | ${cell(x.requirement)} | ${tr(DEPLOY_PROBE_LABEL[x.status])} | ${cell(redactSecrets(x.note || x.output.split('\n')[0] || ''))} |`)
    L.push('')
  }
  if (p) {
    L.push(`## ${tr('部署清单')}`, '')
    if (r.planTruncated) L.push(tr('> 文档过长，AI 只解读了前 {n} 万字；后面的内容没有进入清单和 AI 风险检查，请人工核对（规则检查覆盖全文）。', { n: DOC_MAX_CHARS / 10_000 }), '')
    if (p.prerequisites.length) { L.push(`### ${tr('前置条件')}`, '', `| ${tr('检查项')} | ${tr('要求')} | ${tr('检查命令')} |`, '|---|---|---|'); for (const x of p.prerequisites) L.push(`| ${cell(x.item)} | ${cell(x.requirement)} | ${x.check ? `\`${cell(x.check)}\`` : '—'} |`); L.push('') }
    if (p.steps.length) {
      L.push(`### ${tr('部署步骤')}`, '')
      p.steps.forEach((s, i) => {
        L.push(`${i + 1}. ${s.title}${s.downtime ? tr('（中断服务）') : ''}`)
        if (s.command) L.push('', fence(s.command).split('\n').map((l) => `   ${l}`).join('\n'))
        if (s.rollback) L.push(`   ${tr('回滚：{v}', { v: s.rollback })}`)
      })
      L.push('')
    }
    for (const [t, xs] of [[tr('配置变更'), p.configChanges], [tr('数据库变更'), p.dbChanges], [tr('验证方法'), p.verify], [tr('回滚方案'), p.rollback]] as const) if (xs.length) L.push(`### ${t}`, '', ...xs.map((x) => `- ${x}`), '')
  }
  if (r.artifacts.length) { L.push(`## ${tr('产物')}`, '', `| ${tr('文件')} | ${tr('大小')} | sha256 |`, '|---|---|---|'); for (const a of r.artifacts) L.push(`| ${cell(a.name)} | ${a.size} | \`${a.sha256}\` |`); L.push('') }
  return L.join('\n')
}

/** 评审通过后转成运维手册：前置检查 → 部署步骤 → 验证 */
export function reviewToRunbook(r: DeployReview): RunbookInput {
  const p = r.plan
  const steps = [
    ...(p?.prerequisites ?? []).filter((x) => x.check).map((x) => ({ title: tr('检查：{item}（要求 {req}）', { item: x.item, req: x.requirement }), command: x.check!, kind: 'check' as const })),
    ...(p?.steps ?? []).map((s) => ({ title: s.title + (s.downtime ? tr('（中断服务）') : ''), ...(s.command ? { command: s.command } : {}), ...(s.rollback ? { expect: tr('回滚：{v}', { v: s.rollback }) } : {}), kind: s.command ? guessStepKind(s.command) : ('change' as const) })),
    ...(p?.verify ?? []).map((v) => ({ title: tr('验证：{v}', { v }), kind: 'check' as const })),
  ]
  return normalizeRunbook({ name: tr('部署：{name}', { name: r.title || r.docName || tr('未命名') }).slice(0, 80), description: [p?.summary, p?.rollback.length ? tr('回滚：{v}', { v: p.rollback.join(tr('；')) }) : ''].filter(Boolean).join('\n'), params: [], steps })
}

/** 新旧两版文档的对比（重新导入后看改了什么） */
export function docDiff(prev: string, cur: string): { added: number; removed: number; lines: { t: ' ' | '-' | '+'; s: string }[] } {
  const ops = diffLines(prev.split('\n'), cur.split('\n'))
  return { added: ops.filter((o) => o.t === '+').length, removed: ops.filter((o) => o.t === '-').length, lines: ops }
}
