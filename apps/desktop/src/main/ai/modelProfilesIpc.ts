// 多模型配置（设置 → 模型设置）：测试连接 + 会话级切换模型。配置的增删改走 settings:save（见 SettingsStore），
// Key 明文只进不出：测试连接时表单没填 Key 就用主进程里已存的，渲染层拿不到。
import type { ModelProfile, ModelProtocol, ModelTestResult } from '@lingshell/shared'
import { endpointBaseOf, protocolOf, providerMeta, tr, tk } from '@lingshell/shared'

export interface ModelProfilesIpcDeps {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  // 已存配置（用来取 key；换过提供商的不沿用旧 key，同 SettingsStore 的规则）
  stored(id: string): { provider: string; apiKey: string } | undefined
  setSessionModel(sessionId: string, profileId?: string): Promise<{ pending: boolean }>
  sessionModel(sessionId: string): { profileId?: string; pending: boolean }
  fetch?: typeof fetch
}

const TIMEOUT_MS = 15_000

// 疑似协议不匹配时附在错误后的建议（界面另给「改用 OpenAI 兼容并重试」按钮）
export const ANTHROPIC_MISMATCH_TIP = tk('这个地址可能不支持 Anthropic 协议，试试把「接口协议」改为「OpenAI 兼容」')
const OPENAI_MISMATCH_TIP = tk('地址可能不对；若这个网关只支持 Anthropic 协议，把「接口协议」改回「Anthropic Messages」')
// 端点不认这个路径 / 方法：多半是协议不对（或地址少了一段）
const isMismatchStatus = (s: number) => s === 404 || s === 405

/**
 * 测试一套配置能不能用（只在用户点「测试连接」时调用），按配置的接口协议测：
 *  - openai：先 GET {base}/models（不耗 token，验证地址与 Key），端点不提供模型列表（404/405 等）再发一个极小的对话请求（max_tokens=1）；
 *  - anthropic（DeepSeek 默认）：POST {base}/v1/messages 极小请求（max_tokens=1，x-api-key）。404/405 或返回的不是 Messages 格式
 *    → protocolMismatch，提示改用 OpenAI 兼容。
 * DeepSeek 官方地址按协议自动修正（同引擎，见 endpointBaseOf）。错误信息里抹掉 Key。
 */
export async function testModelConnection(p: { provider: string; model: string; baseUrl: string; apiKey: string; protocol?: ModelProtocol }, f: typeof fetch = fetch, timeoutMs = TIMEOUT_MS): Promise<ModelTestResult> {
  const meta = providerMeta(p.provider)
  if (meta.needsApiKey && !p.apiKey) return { ok: false, error: tr('还没填 API Key') }
  const base = endpointBaseOf(p)
  const anthropic = protocolOf(p.provider, p.protocol) === 'anthropic'
  const headers: Record<string, string> = anthropic
    ? { 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
    : { authorization: `Bearer ${p.apiKey || 'no-key'}`, 'content-type': 'application/json' }
  const hide = (s: string) => (p.apiKey ? s.split(p.apiKey).join('***') : s)
  const detail = async (r: Response) => {
    const text = await r.text().catch(() => '')
    let msg = text
    try { const j = JSON.parse(text); msg = j?.error?.message ?? j?.message ?? j?.error ?? text } catch { /* 非 JSON 原样 */ }
    msg = hide(String(typeof msg === 'string' ? msg : JSON.stringify(msg)).replace(/\s+/g, ' ').trim()).slice(0, 200)
    return msg ? tr('：{msg}', { msg }) : ''
  }
  const t0 = Date.now()
  const signal = AbortSignal.timeout(timeoutMs)
  const auth = (s: number) => s === 401 || s === 403
  try {
    if (anthropic) {
      const r = await f(`${base}/v1/messages`, {
        method: 'POST', headers, signal,
        body: JSON.stringify({ model: p.model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
      })
      if (r.ok) {
        const j = await r.json().catch(() => null) as { type?: unknown; content?: unknown } | null
        if (j && (j.type === 'message' || Array.isArray(j.content))) return { ok: true, ms: Date.now() - t0 }
        return { ok: false, protocolMismatch: true, error: tr('返回的不是 Anthropic Messages 格式。{tip}', { tip: tr(ANTHROPIC_MISMATCH_TIP) }) }
      }
      if (auth(r.status)) return { ok: false, error: tr('认证失败（HTTP {status}），请检查 API Key{detail}', { status: r.status, detail: await detail(r) }) }
      if (isMismatchStatus(r.status)) return { ok: false, protocolMismatch: true, error: tr('请求失败（HTTP {status}）{detail}。{tip}', { status: r.status, detail: await detail(r), tip: tr(ANTHROPIC_MISMATCH_TIP) }) }
      return { ok: false, error: tr('请求失败（HTTP {status}）{detail}', { status: r.status, detail: await detail(r) }) }
    }
    const r = await f(`${base}/models`, { headers, signal })
    if (r.ok) {
      const j = await r.json().catch(() => null) as { data?: { id?: unknown }[] } | null
      const ids = Array.isArray(j?.data) ? j!.data.map((x) => x?.id).filter((x): x is string => typeof x === 'string') : []
      return { ok: true, ms: Date.now() - t0, ...(ids.length && !ids.includes(p.model) ? { warning: tr('连接正常，但模型列表里没有「{model}」，请核对模型 id', { model: p.model }) } : {}) }
    }
    if (auth(r.status)) return { ok: false, error: tr('认证失败（HTTP {status}），请检查 API Key{detail}', { status: r.status, detail: await detail(r) }) }
    const c = await f(`${base}/chat/completions`, {
      method: 'POST', headers, signal,
      body: JSON.stringify({ model: p.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }),
    })
    if (c.ok) return { ok: true, ms: Date.now() - t0 }
    // 只有 DeepSeek 能换协议，才提示换回 Anthropic
    const tip = p.provider === 'deepseek' && isMismatchStatus(c.status) ? tr('。{tip}', { tip: tr(OPENAI_MISMATCH_TIP) }) : ''
    return { ok: false, error: auth(c.status) ? tr('认证失败（HTTP {status}）{detail}{tip}', { status: c.status, detail: await detail(c), tip }) : tr('请求失败（HTTP {status}）{detail}{tip}', { status: c.status, detail: await detail(c), tip }) }
  } catch (e) {
    if (signal.aborted) return { ok: false, error: tr('连接超时（{n} 秒没有响应）：{base}', { n: Math.round(timeoutMs / 1000), base }) }
    const err = e as { message?: string; cause?: { code?: string; message?: string } }
    return { ok: false, error: hide(tr('连不上 {base}：{error}', { base, error: err.cause?.code ?? err.cause?.message ?? err.message ?? String(e) })) }
  }
}

const str = (v: unknown, what: string): string => { if (typeof v !== 'string' || !v) throw new Error(tr('非法的{what}', { what: tr(what) })); return v }

export function registerModelProfiles(d: ModelProfilesIpcDeps): void {
  d.handle('modelProfiles:test', (_e, input) => {
    const p = input as ModelProfile
    if (!p || typeof p !== 'object') throw new Error(tr('非法的模型配置'))
    const old = (p.id ? d.stored(p.id) : undefined) ?? (p.keyFrom ? d.stored(p.keyFrom) : undefined)
    const apiKey = p.apiKey || (old && old.provider === p.provider ? old.apiKey : '')
    return testModelConnection({ provider: String(p.provider), model: String(p.model ?? '').trim(), baseUrl: String(p.baseUrl ?? ''), apiKey, protocol: protocolOf(String(p.provider), p.protocol) }, d.fetch)
  })
  d.handle('agent:setModel', (_e, sessionId, profileId) => d.setSessionModel(str(sessionId, tk('arg|会话')), typeof profileId === 'string' && profileId ? profileId : undefined))
  d.handle('agent:getModel', (_e, sessionId) => d.sessionModel(str(sessionId, tk('arg|会话'))))
}
