import { createHmac } from 'node:crypto'
import { explainWebhookError, tr, tk, type InspectionRun, type InspectionSchedule, type InspectionStatus, type WebhookType } from '@lingshell/shared'
import type { ResolvedWebhook } from '@lingshell/config'

// 巡检告警推送到群机器人（钉钉 / 企业微信 / 飞书 / 通用 JSON）。主进程发送，10s 超时 + 重试 1 次；
// 失败只记日志和运行记录的 alertError，绝不影响巡检本身。消息只含计划名/状态/主机/时间/摘要，不含 URL/密钥/命令输出全文。

export const STATUS_TEXT: Record<InspectionStatus, string> = { normal: tk('正常'), abnormal: tk('异常'), failed: tk('失败'), timeout: tk('超时'), unknown: tk('无结论'), running: tk('运行中') }   // 显示处 tr()
// 钉钉「自定义关键词」按帮助设成「巡检」：英文界面的标题里没有这两个字，补在标题后面，否则钉钉拒收
const KEYWORD = '巡检'   // i18n-ignore 钉钉关键词匹配用，不翻译
const withKeyword = (title: string) => (title.includes(KEYWORD) ? title : `${title} (${KEYWORD})`)
// 摘要字节上限（UTF-8）：企微 markdown 整条 ≤4096 字节，其余留足余量
export const SUMMARY_BYTES: Record<WebhookType, number> = { dingtalk: 4000, wecom: 3000, feishu: 4000, generic: 4000 }
const SUMMARY_LINES = 20

export interface AlertInfo { scheduleName: string; status: InspectionStatus; hosts: string[]; time: string; summary: string; error?: string }

/** 钉钉加签：urlencode(base64(HMAC-SHA256(key=secret, msg=timestamp+"\n"+secret)))，timestamp 为毫秒 */
export function dingtalkSign(secret: string, tsMs: number): string {
  return encodeURIComponent(createHmac('sha256', secret).update(`${tsMs}\n${secret}`).digest('base64'))
}
/** 飞书签名校验：base64(HMAC-SHA256(key=timestamp+"\n"+secret, msg=""))，timestamp 为秒 */
export function feishuSign(secret: string, tsSec: number): string {
  return createHmac('sha256', `${tsSec}\n${secret}`).update('').digest('base64')
}

/** 摘要：取末尾若干非空行，超出字节上限时保留尾部、开头加 … */
export function tailSummary(text: string, maxBytes: number): string {
  const s = text.split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(-SUMMARY_LINES).join('\n')
  const buf = Buffer.from(s)
  if (buf.length <= maxBytes) return s
  // … 占 3 字节；跳过被切开的多字节字符的后续字节（10xxxxxx）
  let start = buf.length - (maxBytes - 3)
  while ((buf[start] & 0xc0) === 0x80) start++
  return '…' + buf.subarray(start).toString('utf8')
}

const pad = (n: number) => String(n).padStart(2, '0')
const fmtTime = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`

export function alertInfo(run: InspectionRun, hosts: string[]): AlertInfo {
  return { scheduleName: run.scheduleName, status: run.status, hosts, time: fmtTime(new Date(run.finishedAt ?? run.at)), summary: run.summary, error: run.error }
}

/** 按平台组装请求（url 可能追加签名参数） */
export function buildRequest(t: Pick<ResolvedWebhook, 'type' | 'url' | 'secret'>, a: AlertInfo, now = Date.now()): { url: string; body: unknown } {
  const st = tr(STATUS_TEXT[a.status])
  const title = withKeyword(tr('巡检「{name}」{status}', { name: a.scheduleName, status: st }))
  const hosts = a.hosts.join(tr('、')) || '-'
  const error = a.error?.slice(0, 300)
  const summary = tailSummary(a.summary, SUMMARY_BYTES[t.type])
  if (t.type === 'generic') return { url: t.url, body: { scheduleName: a.scheduleName, status: a.status, statusText: st, hosts: a.hosts, time: a.time, summary, ...(error ? { error } : {}) } }
  if (t.type === 'feishu') {
    const text = [title, tr('状态：{v}', { v: st }), tr('主机：{v}', { v: hosts }), tr('时间：{v}', { v: a.time }), ...(error ? [tr('错误：{v}', { v: error })] : []), ...(summary ? ['', summary] : [])].join('\n')
    const sec = Math.floor(now / 1000)
    return { url: t.url, body: { ...(t.secret ? { timestamp: String(sec), sign: feishuSign(t.secret, sec) } : {}), msg_type: 'text', content: { text } } }
  }
  // 钉钉/企微 markdown：摘要逐行引用，空行分隔（钉钉单换行不分行）
  const md = [`### ${title}`, '', `- ${tr('状态：{v}', { v: `**${st}**` })}`, `- ${tr('主机：{v}', { v: hosts })}`, `- ${tr('时间：{v}', { v: a.time })}`, ...(error ? [`- ${tr('错误：{v}', { v: error })}`] : []),
    ...(summary ? ['', summary.split('\n').map((l) => `> ${l}`).join('\n\n')] : [])].join('\n')
  if (t.type === 'wecom') return { url: t.url, body: { msgtype: 'markdown', markdown: { content: md } } }
  const url = t.secret ? `${t.url}${t.url.includes('?') ? '&' : '?'}timestamp=${now}&sign=${dingtalkSign(t.secret, now)}` : t.url
  return { url, body: { msgtype: 'markdown', markdown: { title, text: md } } }
}

export interface SendOpts { timeoutMs?: number; retries?: number; now?: () => number }

// 只读回包的前 64KB：群机器人正常回包很小；对端（或中间代理）返回超大 / 不结束的 body 时不能把主进程内存或连接拖住
const RESP_MAX = 64 * 1024
async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Buffer[] = []
  let n = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) { chunks.push(Buffer.from(value)); n += value.length }
      if (n >= max) { await reader.cancel().catch(() => {}); break }
    }
  } catch { /* 读一半断开：用已经拿到的部分判断 */ }
  return Buffer.concat(chunks).subarray(0, max).toString('utf8')
}

async function postOnce(url: string, body: unknown, checkCode: boolean, timeoutMs: number): Promise<void> {
  let res: Response
  try {
    res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    // 报错文案不带 URL（含 token）
    const err = e as Error & { cause?: { code?: string } }
    throw new Error(err.name === 'TimeoutError' || err.name === 'AbortError' ? tr('超时（{s}s）', { s: timeoutMs / 1000 }) : tr('网络错误 {err}', { err: err.cause?.code ?? err.message }))
  }
  if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new Error(`HTTP ${res.status}`) }
  if (!checkCode) { await res.body?.cancel().catch(() => {}); return }
  const text = await readCapped(res, RESP_MAX)
  // 钉钉/企微 {errcode,errmsg}，飞书 {code,msg} / {StatusCode}：HTTP 200 也可能是业务失败（签名错、关键词不匹配等）
  let j: Record<string, unknown>
  try { j = JSON.parse(text) as Record<string, unknown> } catch { return }
  const code = j.errcode ?? j.code ?? j.StatusCode
  if (typeof code === 'number' && code !== 0) throw new Error(`${code} ${String(j.errmsg ?? j.msg ?? j.StatusMessage ?? '')}`.trim().slice(0, 200))
}

/** 发一条：失败重试 retries 次（签名每次重算），仍失败抛最后一次的错（认得的错误码附上解释） */
export async function sendWebhook(t: ResolvedWebhook, a: AlertInfo, opts: SendOpts = {}): Promise<void> {
  const retries = opts.retries ?? 1
  for (let i = 0; ; i++) {
    const req = buildRequest(t, a, opts.now?.() ?? Date.now())
    try { return await postOnce(req.url, req.body, t.type !== 'generic', opts.timeoutMs ?? 10_000) }
    catch (e) {
      if (i < retries) continue
      const m = (e as Error).message, hint = explainWebhookError(m)
      throw hint ? new Error(tr('{msg}（{hint}）', { msg: m, hint })) : e
    }
  }
}

/** 测试消息：标题同样带「巡检」，钉钉「自定义关键词=巡检」也能收到 */
export const testAlert = (): AlertInfo => ({ scheduleName: tr('测试消息'), status: 'normal', hosts: [tr('本地')], time: fmtTime(new Date()), summary: tr('这是一条来自灵壳 LingShell 的测试消息，收到说明配置正确。') })

/** 本次运行要推给哪些机器人：problem（默认）只推非正常结果；notifyWebhooks 不设 = 所有启用的 */
export function selectWebhooks(s: Pick<InspectionSchedule, 'notifyWebhooks' | 'notifyOn'>, status: InspectionStatus, all: ResolvedWebhook[]): ResolvedWebhook[] {
  if (status === 'running' || (status === 'normal' && s.notifyOn !== 'always')) return []
  return all.filter((w) => w.enabled && w.url && (!s.notifyWebhooks || s.notifyWebhooks.includes(w.id)))
}

/** 并发推送；返回失败汇总（全成功返回 undefined） */
export async function pushAlerts(targets: ResolvedWebhook[], a: AlertInfo, opts?: SendOpts): Promise<string | undefined> {
  const rs = await Promise.allSettled(targets.map((t) => sendWebhook(t, a, opts)))
  const errs = rs.flatMap((r, i) => r.status === 'rejected' ? [tr('{name}：{err}', { name: targets[i].name, err: (r.reason as Error)?.message ?? String(r.reason) })] : [])
  return errs.length ? errs.join(tr('；')) : undefined
}
