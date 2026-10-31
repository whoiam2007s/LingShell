// ── 常用任务模板 + 定时巡检 ──────────────────────────────

// 提示词模板。prompt 里可含占位符 {{名字}}，发送前由用户填写
import { tk, tr } from '../i18n/i18n.js'

export interface PromptTemplate { id: string; name: string; prompt: string }
export interface TemplateInput { id?: string; name: string; prompt: string }

// 巡检时间：每 N 小时 / 每天 HH:mm（本地时间）
export type ScheduleWhen = { kind: 'interval'; hours: number } | { kind: 'daily'; time: string }

export interface InspectionSchedule {
  id: string
  name: string
  prompt: string            // 巡检任务描述；{{主机}} 运行时替换为目标主机名
  targets: string[]         // 'local' | 已保存主机 id
  when: ScheduleWhen
  enabled: boolean
  createdAt: string
  lastRunAt?: string        // 上次开跑时间（调度锚点）
  notifyWebhooks?: string[] // 推送到哪些群机器人；不设 = 所有启用的，[] = 不推送
  notifyOn?: NotifyOn       // 何时推送；不设 = problem
}
export interface ScheduleInput { id?: string; name: string; prompt: string; targets: string[]; when: ScheduleWhen; enabled: boolean; notifyWebhooks?: string[]; notifyOn?: NotifyOn }

// ── 巡检告警推送：群机器人 Webhook ─────────────────────
// problem = 仅异常/失败/超时/无结论；always = 每次运行
export type NotifyOn = 'problem' | 'always'
export type WebhookType = 'dingtalk' | 'wecom' | 'feishu' | 'generic'
// 给 UI 的摘要：URL（含 access_token/key）与签名密钥都不回传
export interface WebhookSummary { id: string; name: string; type: WebhookType; enabled: boolean; urlHint: string; hasSecret: boolean }
// url/secret 留空 = 保留已存的；clearSecret 清掉已存密钥
export interface WebhookInput { id?: string; name: string; type: WebhookType; url?: string; secret?: string; clearSecret?: boolean; enabled: boolean }

/** Webhook 地址校验：必须 https；http 只允许本机（测试用）。返回错误文案，合法返回 undefined */
export function checkWebhookUrl(url: string): string | undefined {
  let u: URL
  try { u = new URL(url) } catch { return tr('地址格式不对') }
  if (u.protocol === 'https:') return undefined
  if (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return undefined
  return tr('只允许 https 地址（http 仅限 127.0.0.1/localhost 测试）')
}

/** 按地址识别平台：钉钉/企微/飞书(含 Lark)的机器人地址；其它合法地址 = generic；不合法 = undefined */
export function detectWebhookType(url: string): WebhookType | undefined {
  if (checkWebhookUrl(url)) return undefined
  const u = new URL(url)
  const https = u.protocol === 'https:'
  if (https && u.hostname === 'oapi.dingtalk.com' && u.pathname.startsWith('/robot/send')) return 'dingtalk'
  if (https && u.hostname === 'qyapi.weixin.qq.com' && u.pathname.startsWith('/cgi-bin/webhook/send')) return 'wecom'
  if (https && ['open.feishu.cn', 'open.larksuite.com'].includes(u.hostname) && u.pathname.startsWith('/open-apis/bot/v2/hook/')) return 'feishu'
  return 'generic'
}

// 常见平台业务错误码 → 人话（errmsg 用于区分钉钉 310000 的几种情况）
const WEBHOOK_CODES: Record<string, string> = {
  '300001': tk('地址里的 token 无效，机器人可能已被删除，请重新复制地址'),
  '300005': tk('地址里的 token 无效，机器人可能已被删除，请重新复制地址'),
  '310000': tk('签名或关键词不匹配：选了加签就填对密钥；选了自定义关键词需包含「巡检」'),
  '130101': tk('发送太频繁（每分钟最多 20 条），稍后再试'),
  '45009': tk('发送太频繁（每分钟最多 20 条），稍后再试'),
  '93000': tk('地址无效，机器人可能已被移除，请重新复制地址'),
  '19001': tk('地址无效，机器人可能已被移除，请重新复制地址'),
  '19021': tk('签名校验失败：密钥不对，或本机时间偏差太大'),
  '19022': tk('本机 IP 不在机器人的 IP 白名单内'),
  '19024': tk('关键词不匹配：自定义关键词需包含「巡检」'),
  '11232': tk('发送太频繁，稍后再试'),
}

/** 发送失败原因的解释（错误文案形如「310000 keywords not in content」「HTTP 404」）；认不出返回 undefined */
export function explainWebhookError(msg: string): string | undefined {
  const code = /^(\d+)\b/.exec(msg)?.[1]
  if (code === '310000') {
    if (/keyword/i.test(msg)) return tr('关键词不匹配：自定义关键词需包含「巡检」')
    if (/sign/i.test(msg)) return tr('签名不匹配：密钥填错了，或本机时间偏差太大')
    if (/ip/i.test(msg)) return tr('本机 IP 不在机器人的 IP 白名单内')
  }
  if (code && WEBHOOK_CODES[code]) return tr(WEBHOOK_CODES[code])
  if (/^HTTP 404\b/.test(msg)) return tr('地址不存在，请检查是否复制完整')
  if (/^超时/.test(msg)) return tr('连不上平台，检查网络或代理')
  return undefined
}

// normal/abnormal 来自 AI 报告末行「状态: 正常|异常」；unknown=没写状态行；failed=没跑起来/出错；timeout=超时被中断
export type InspectionStatus = 'running' | 'normal' | 'abnormal' | 'unknown' | 'failed' | 'timeout'
export interface InspectionRun {
  id: string
  scheduleId: string
  scheduleName: string
  at: string                // 开跑时间
  finishedAt?: string
  status: InspectionStatus
  summary: string           // AI 最后一条回复（截断）
  sessionId?: string
  error?: string
  alertError?: string       // 群机器人推送失败原因（不影响巡检本身）
}

/** 模板里的占位符名（去重，按出现顺序） */
export function templateVars(prompt: string): string[] {
  const out: string[] = []
  for (const m of prompt.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) if (!out.includes(m[1])) out.push(m[1])
  return out
}

/** 用 values 替换占位符；没给值的原样保留 */
export function fillTemplate(prompt: string, values: Record<string, string>): string {
  return prompt.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (all, k: string) => (values[k] ?? '') || all)
}
