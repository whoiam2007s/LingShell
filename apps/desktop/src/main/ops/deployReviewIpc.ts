// 部署评审（见 shared/ops/deployReview.ts）：一份评审一个 JSON，存 <数据目录>/deploy-reviews/<id>.json
//  - 导入文档（md / txt / docx / pdf…，或直接粘贴）、产物（算 sha256、列压缩包内文件）
//  - analyze：规则检查 + 一次性模型调用把文档整理成部署清单并找风险（文档按设置脱敏后才发给模型）
//  - probe：清单里的前置条件检查命令，只读的才在目标主机上跑（并发同批量执行，有在线终端复用其连接），再让模型判定是否满足
//  - 评审意见 / 结论 / 报告导出 PDF / 转运维手册
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { setMaxListeners } from 'node:events'
import { readJson, writeJson } from '@lingshell/config'
import {
  FLEET_CONCURRENCY, applyProbeJudge, dangerCheck, buildPlanPrompt, buildProbeJudgePrompt, chunkProbeRows, deployProbeScript, emptyReview, mergeRisks, parseDeployProbe, parsePlanReply,
  probeRisks, reviewSummary, reviewToRunbook, ruleRisks, runPool,
  type DeployProbeRow, type DeployReview, type DeployReviewPatch, type DeployReviewSummary, type FleetHost, type HostSummary, type RiskDecision, type Runbook, type RunbookInput, tr,
} from '@lingshell/shared'
import { runBatchHost, type Runner } from './batchExec.js'
import { DOC_EXTS, DOC_TEXT_MAX_CHARS, artifactInfo, docToText } from '../files/index.js'

export interface DeployReviewDeps {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  dir: string
  pickFiles(o: { title: string; filters: { name: string; extensions: string[] }[]; multi: boolean }): Promise<string[]>
  complete(system: string, user: string, signal: AbortSignal): Promise<string>
  redact(text: string): string
  hosts(): HostSummary[]
  open(h: FleetHost): () => Promise<Runner>
  isReadOnly(cmd: string): boolean
  saveRunbook(input: RunbookInput): Runbook
  savePdf(html: string, defaultName: string): Promise<string | undefined>
  log?(level: 'info' | 'warn', message: string, data?: unknown): void
}

const HISTORY_MAX = 10
const PROBE_TIMEOUT_MS = 90_000
const DECISIONS: RiskDecision[] = ['open', 'accept', 'ignore', 'rework']
// 「连这个端口试试」：模型最常给的连通性检查，只读但 readonly 判定不认 bash -c / 重定向，单独放行这一种固定形态
// 查版本（java -version / node -v / docker --version …）、ulimit、SELinux 状态也是预检的主力，通用判定不放行，这里只认这几种固定形态
// 只匹配单行：\s 会吞换行，`crontab\n-v` 这种会放行「crontab 本体」（无参数时读 stdin 覆盖 crontab）
export const PROBE_ALLOW = [
  /^timeout[ \t]+\d+[ \t]+bash[ \t]+-c[ \t]+(["'])<[ \t]*\/dev\/tcp\/[\w.-]+\/\d+\1([ \t]*&&[ \t]*echo[ \t]+[\w-]+)?([ \t]*\|\|[ \t]*echo[ \t]+[\w-]+)?$/,
  /^[\w.+-]+[ \t]+(-v|-V|--version|-version|version)([ \t]+2>&1)?([ \t]*\|[ \t]*head([ \t]+-n)?[ \t]+-?\d+)?$/,
  /^ulimit[ \t]+-[a-zA-Z]+$/, /^(getenforce|sestatus)$/,
]
// 版本形态对少数程序 -v 不是「版本」（reboot / kill 之类），这些一律不放
const PROBE_BLOCK = /^(init|telinit|kill\w*|pkill|rm|dd|mkfs\S*|halt|reboot|shutdown|poweroff)\b/
const SINGLE_LINE = /^[^\r\n]+$/

/** 预检命令是否只读：固定形态（单行）+ 通用只读白名单 */
export function probeReadOnly(c: string, fallback: (c: string) => boolean): boolean {
  const t = c.trim()
  return (SINGLE_LINE.test(t) && PROBE_ALLOW.some((re) => re.test(t)) && dangerCheck(t) === 'safe' && !PROBE_BLOCK.test(t)) || fallback(c)
}

export function registerDeployReview(d: DeployReviewDeps) {
  mkdirSync(d.dir, { recursive: true })
  const fileOf = (id: string) => {
    if (!/^dr_[\w-]+$/.test(id)) throw new Error(tr('评审不存在'))
    return join(d.dir, `${id}.json`)
  }
  const load = (id: unknown): DeployReview => {
    const r = typeof id === 'string' ? readJson<DeployReview>(fileOf(id)) : undefined
    if (!r) throw new Error(tr('评审不存在'))
    return { ...emptyReview(r.id), ...r }
  }
  const save = (r: DeployReview): DeployReview => { const x = { ...r, updatedAt: new Date().toISOString() }; writeJson(fileOf(r.id), x); return x }
  // 长时间操作（解读 / 预检 / 产物算哈希）期间评审可能已被删除：不要在收尾时把它写回来
  const saveExisting = (r: DeployReview): DeployReview => { if (!existsSync(fileOf(r.id))) throw new Error(tr('评审已被删除')); return save(r) }
  // 期间用户可能改过处理意见 / 标题 / 脚本等：收尾时基于最新内容合并，别用开始时的快照整个覆盖
  const reload = (r: DeployReview): DeployReview => {
    const x = readJson<DeployReview>(fileOf(r.id))
    if (!x) throw new Error(tr('评审已被删除'))
    return { ...emptyReview(x.id), ...x }
  }
  const readOnly = (c: string) => probeReadOnly(c, d.isReadOnly)

  d.handle('deployReview:list', (): DeployReviewSummary[] => readdirSync(d.dir).filter((f) => /^dr_[\w-]+\.json$/.test(f))
    .flatMap((f) => { const r = readJson<DeployReview>(join(d.dir, f)); return r ? [reviewSummary({ ...emptyReview(r.id), ...r })] : [] })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
  d.handle('deployReview:get', (_e, id) => load(id))
  d.handle('deployReview:create', () => save(emptyReview(`dr_${randomUUID().slice(0, 8)}`)))
  d.handle('deployReview:delete', (_e, id) => { if (typeof id === 'string') rmSync(fileOf(id), { force: true }) })

  d.handle('deployReview:update', (_e, id, patch) => {
    const r = load(id), p: DeployReviewPatch = patch && typeof patch === 'object' ? patch : {}
    if (typeof p.title === 'string') r.title = p.title.slice(0, 120)
    if (p.env === 'test' || p.env === 'prod') r.env = p.env
    if (Array.isArray(p.hostIds)) r.hostIds = [...new Set(p.hostIds.filter((x): x is string => typeof x === 'string'))]
    if (typeof p.reviewer === 'string') r.reviewer = p.reviewer.slice(0, 60)
    if (typeof p.opinion === 'string') r.opinion = p.opinion.slice(0, 10_000)
    if (p.conclusion === null) delete r.conclusion
    else if (p.conclusion === 'pass' || p.conclusion === 'conditional' || p.conclusion === 'fail') r.conclusion = p.conclusion
    if (p.decisions && typeof p.decisions === 'object') {
      r.risks = r.risks.map((x) => {
        const v = p.decisions![x.id]
        if (!v || !DECISIONS.includes(v.decision)) return x
        const note = typeof v.note === 'string' ? v.note.trim().slice(0, 1000) : x.note
        // 备注被清空时要真的清掉，不能因为展开 x 又把旧值带回来
        const next: DeployReview['risks'][number] = { ...x, decision: v.decision }
        if (note) next.note = note
        else delete next.note
        return next
      })
    }
    return save(r)
  })

  const setDoc = (r: DeployReview, name: string, text: string): DeployReview => {
    r = reload(r)   // 读文件 / 转文字期间评审可能已被删除，或标题等已被改过
    if (r.docText.trim() && r.docText !== text) r.history = [...r.history, { at: r.docAt ?? r.createdAt, name: r.docName, text: r.docText }].slice(-HISTORY_MAX)
    r.docName = name; r.docText = text; r.docAt = new Date().toISOString()
    if (!r.title) r.title = name.replace(/\.[^.]+$/, '').slice(0, 120)
    return saveExisting(r)
  }
  d.handle('deployReview:importDoc', async (_e, id) => {
    const r = load(id)
    const [path] = await d.pickFiles({ title: tr('选择部署文档'), multi: false, filters: [{ name: tr('部署文档'), extensions: DOC_EXTS }, { name: tr('所有文件'), extensions: ['*'] }] })
    if (!path) return undefined
    const doc = await docToText(path)
    return setDoc(r, doc.name, doc.text)
  })
  d.handle('deployReview:pasteDoc', (_e, id, name, text) => {
    if (typeof text !== 'string' || !text.trim()) throw new Error(tr('文档内容是空的'))
    if (text.length > DOC_TEXT_MAX_CHARS) throw new Error(tr('文档文字过长（超过 {n} 万字），请拆分，或只保留与部署相关的内容', { n: DOC_TEXT_MAX_CHARS / 10_000 }))
    return setDoc(load(id), typeof name === 'string' && name.trim() ? name.trim().slice(0, 120) : tr('粘贴的文档'), text.replace(/\r\n/g, '\n'))
  })

  d.handle('deployReview:addArtifacts', async (_e, id) => {
    const r = load(id)
    const paths = await d.pickFiles({ title: tr('选择部署产物（可多选）'), multi: true, filters: [{ name: tr('所有文件'), extensions: ['*'] }] })
    if (!paths.length) return undefined
    const infos = await Promise.all(paths.map((p) => artifactInfo(p)))
    const cur = reload(r)   // 大文件算哈希期间评审可能已被删除，或处理意见已被改过
    cur.artifacts = [...cur.artifacts.filter((a) => !infos.some((x) => x.name === a.name)), ...infos]
    return saveExisting(cur)
  })
  d.handle('deployReview:removeArtifact', (_e, id, name) => { const r = load(id); r.artifacts = r.artifacts.filter((a) => a.name !== name); return save(r) })

  d.handle('deployReview:analyze', async (_e, id) => {
    const r = load(id)
    if (!r.docText.trim()) throw new Error(tr('先导入部署文档'))
    const p = buildPlanPrompt({ docText: d.redact(r.docText), docName: r.docName, artifacts: r.artifacts, env: r.env })
    const reply = parsePlanReply(await d.complete(p.system, p.user, AbortSignal.timeout(240_000)))
    if ('error' in reply) throw new Error(reply.error)
    // 解读 1–2 分钟：收尾时基于最新内容合并，期间改过的处理意见（连同被删的情况）不能被开始时的快照覆盖
    const cur = reload(r)
    cur.plan = reply.plan
    cur.analyzedAt = new Date().toISOString()
    cur.planTruncated = p.truncated
    cur.risks = mergeRisks(cur.risks, [...ruleRisks({ docText: cur.docText, artifacts: cur.artifacts, plan: cur.plan }), ...reply.risks, ...probeRisks(cur.probes)])
    d.log?.('info', '部署评审 解读完成', { id: cur.id, steps: cur.plan.steps.length, risks: cur.risks.length, truncated: p.truncated })   // i18n-ignore 日志
    return saveExisting(cur)
  })

  d.handle('deployReview:probe', async (_e, id) => {
    const r = load(id)
    if (!r.plan) throw new Error(tr('先「AI 解读」得到前置条件和检查命令'))
    const checks = r.plan.prerequisites.filter((x) => x.check)
    if (!checks.length) throw new Error(tr('部署清单的前置条件里没有检查命令，请按「部署清单」手动检查'))
    const hosts = d.hosts().filter((h) => r.hostIds.includes(h.id))
    if (!hosts.length) throw new Error(tr('先选择目标主机'))
    const runnable = checks.filter((c) => readOnly(c.check!))
    // 没有可执行的检查时不连主机：只把其余项标「未执行」，省掉一轮无谓连接（生产主机也是）
    const script = runnable.length ? deployProbeScript(runnable.map((c) => c.check!)) : ''
    const signal = new AbortController().signal
    setMaxListeners(100, signal)
    const perHost: DeployProbeRow[][] = []
    await runPool(hosts.length, FLEET_CONCURRENCY, async (i) => {
      const h = hosts[i]
      const base = (c: (typeof checks)[number]) => ({ hostId: h.id, hostLabel: h.label, item: c.item, requirement: c.requirement, command: c.check! })
      const res = runnable.length ? await runBatchHost(d.open({ id: h.id, label: h.label, ...(h.group ? { group: h.group } : {}) }), script, PROBE_TIMEOUT_MS, signal) : undefined
      const outs = res?.output !== undefined ? parseDeployProbe(res.output, runnable.length) : []
      perHost[i] = checks.map((c): DeployProbeRow => {
        const k = runnable.indexOf(c)
        if (k < 0) return { ...base(c), output: '', status: 'skipped', note: tr('不是只读命令，没有执行，请人工检查') }
        if (!res || res.status === 'conn_error' || res.status === 'canceled') return { ...base(c), output: '', status: 'error', note: res?.error ?? tr('连接失败') }
        const o = outs[k]
        if (o.code === undefined) return { ...base(c), output: o.output, status: 'error', note: res.status === 'timeout' ? tr('检查超时') : tr('没拿到结果') }
        return { ...base(c), output: o.output, code: o.code, status: 'warn', note: '' }
      })
    })
    let rows = perHost.flat()
    const judged = rows.filter((x) => x.status === 'warn')
    if (judged.length) {
      // 主机 × 检查项可能很多，一次调用会超出上下文：按行数 / 字符数分批判定，某批失败只影响这批
      const chunks = chunkProbeRows(judged)
      const verdicts = judged.slice()
      await runPool(chunks.length, 3, async (ci) => {
        const { start, rows: chunk } = chunks[ci]
        try {
          // 输出里可能有密码之类：同文档一样按设置脱敏后再发
          const jp = buildProbeJudgePrompt(chunk.map((x) => ({ ...x, output: d.redact(x.output) })))
          const done = applyProbeJudge(chunk, await d.complete(jp.system, jp.user, AbortSignal.timeout(120_000)))
          done.forEach((x, k) => { verdicts[start + k] = x })
        } catch (e) {
          d.log?.('warn', '部署评审 预检判定失败', { error: String(e), rows: chunk.length })   // i18n-ignore 日志
          chunk.forEach((x, k) => { if (!x.note) verdicts[start + k] = { ...x, note: tr('模型判定失败，请看输出人工确认') } })
        }
      })
      rows = rows.map((x) => { const k = judged.indexOf(x); return k >= 0 ? verdicts[k] : x })
    }
    const cur = reload(r)   // 预检期间评审可能已被删除，或处理意见已被改过
    cur.probes = rows
    cur.probedAt = new Date().toISOString()
    cur.risks = mergeRisks(cur.risks, [...cur.risks.filter((x) => x.source !== 'probe'), ...probeRisks(rows)])
    d.log?.('info', '部署评审 预检完成', { id: cur.id, hosts: hosts.length, rows: rows.length })   // i18n-ignore 日志
    return saveExisting(cur)
  })

  d.handle('deployReview:toRunbook', (_e, id) => d.saveRunbook(reviewToRunbook(load(id))).id)
  d.handle('deployReview:exportPdf', (_e, html, name) => {
    if (typeof html !== 'string' || typeof name !== 'string') throw new Error(tr('参数不对'))
    return d.savePdf(html, name)
  })
}
