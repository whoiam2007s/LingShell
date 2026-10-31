// 接口调试面板（纯逻辑）：请求 / 集合 / 环境变量的数据结构，{{变量}} 替换、curl 导入 / 导出、
// 远程发送用的 curl 配置（-K -，经 stdin 传入，URL / 请求头 / 请求体都不出现在命令行里）与响应解析。
// {{secret:名称}} 不在这里替换：主进程发送前才展开成明文，界面 / 集合 / 历史里永远只有占位符。
import { tr } from '../i18n/i18n.js'

export const API_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const
export type ApiMethod = (typeof API_METHODS)[number]
export type ApiBodyType = 'none' | 'json' | 'form' | 'multipart' | 'text'
export interface ApiKV { key: string; value: string; off?: boolean }   // off：暂不发送（勾掉）
export interface ApiRequest {
  id: string
  name: string
  method: ApiMethod
  url: string
  headers: ApiKV[]
  bodyType: ApiBodyType
  body: string        // json / text 原文；form = 每行 key=value
}
export interface ApiEnv { id: string; name: string; vars: ApiKV[] }
export interface ApiHistoryItem { at: string; method: ApiMethod; url: string; via: string; status?: number; ms?: number; error?: string; request: ApiRequest }
export interface ApiStore { requests: ApiRequest[]; envs: ApiEnv[]; activeEnv?: string; history: ApiHistoryItem[] }
export interface ApiResponse { status: number; statusText: string; ms: number; headers: [string, string][]; body: string; truncated: boolean; via: string; size?: number }
/** 发送：request 是模板（含 {{变量}} / {{secret:x}}），via = 'local' 或 SSH 终端 id */
export interface ApiSendInput { request: ApiRequest; vars: ApiKV[]; via: string }

export const API_HISTORY_MAX = 50
export const API_REQUESTS_MAX = 500
export const API_BODY_MAX = 2 * 1024 * 1024     // 响应体最多显示这么多字节
export const API_TIMEOUT_MS = 30_000

export const newApiRequest = (id: string, name = tr('新请求')): ApiRequest => ({ id, name, method: 'GET', url: '', headers: [], bodyType: 'none', body: '' })
export const emptyApiStore = (): ApiStore => ({ requests: [], envs: [], history: [] })

const str = (v: unknown, max = 100_000) => (typeof v === 'string' ? v.slice(0, max) : '')
// 请求头 / URL 里的换行和控制字符：远端 curl 配置文件会把 \n 还原成真实换行（header 注入），本机 fetch 会直接抛错
const noCtl = (s: string) => s.replace(/[\r\n\0]/g, '')
const kvs = (v: unknown): ApiKV[] => (Array.isArray(v) ? v : []).slice(0, 200).flatMap((x) => {
  if (!x || typeof x !== 'object') return []
  const o = x as Record<string, unknown>
  return [{ key: noCtl(str(o.key, 500)), value: noCtl(str(o.value, 20_000)), ...(o.off === true ? { off: true } : {}) }]
})
const isMethod = (m: unknown): m is ApiMethod => typeof m === 'string' && (API_METHODS as readonly string[]).includes(m)
export function sanitizeApiRequest(v: unknown): ApiRequest | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  const id = str(o.id, 64)
  if (!id) return undefined
  const bt = o.bodyType
  return {
    id, name: str(o.name, 200) || tr('未命名'), method: isMethod(o.method) ? o.method : 'GET', url: noCtl(str(o.url, 8000)), headers: kvs(o.headers),
    bodyType: bt === 'json' || bt === 'form' || bt === 'multipart' || bt === 'text' ? bt : 'none', body: str(o.body, 1_000_000),
  }
}
/** 渲染层传来的整份集合：逐项校验、截长度（存盘前） */
export function sanitizeApiStore(v: unknown): ApiStore {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const requests = (Array.isArray(o.requests) ? o.requests : []).map(sanitizeApiRequest).filter((x): x is ApiRequest => !!x).slice(0, API_REQUESTS_MAX)
  const envs = (Array.isArray(o.envs) ? o.envs : []).slice(0, 50).flatMap((e) => {
    if (!e || typeof e !== 'object') return []
    const x = e as Record<string, unknown>
    const id = str(x.id, 64)
    return id ? [{ id, name: str(x.name, 100) || tr('环境'), vars: kvs(x.vars) }] : []
  })
  const history = (Array.isArray(o.history) ? o.history : []).slice(0, API_HISTORY_MAX).flatMap((h) => {
    const x = (h && typeof h === 'object' ? h : {}) as Record<string, unknown>
    const request = sanitizeApiRequest(x.request)
    if (!request) return []
    return [{ at: str(x.at, 40), method: request.method, url: str(x.url, 8000), via: str(x.via, 200), request,
      ...(typeof x.status === 'number' ? { status: x.status } : {}), ...(typeof x.ms === 'number' ? { ms: x.ms } : {}), ...(typeof x.error === 'string' ? { error: x.error.slice(0, 500) } : {}) }]
  })
  const activeEnv = str(o.activeEnv, 64)
  return { requests, envs, history, ...(activeEnv && envs.some((e) => e.id === activeEnv) ? { activeEnv } : {}) }
}

// ── 变量替换 ──
const VAR = /\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g
/** {{名称}} → 环境变量的值；{{secret:x}} 原样保留（主进程再展开）；没定义的变量记进 missing、原样保留 */
export function substituteVars(text: string, vars: ApiKV[]): { text: string; missing: string[] } {
  const map = new Map(vars.filter((v) => !v.off && v.key.trim()).map((v) => [v.key.trim(), v.value]))
  // 变量值里也可以引用别的变量（如 url = {{base}}/v1），最多展开 5 层，防循环
  let out = text
  for (let round = 0; round < 5; round++) {
    const next = out.replace(VAR, (all, name: string) => map.get(name) ?? all)
    if (next === out) break
    out = next
  }
  const missing = [...new Set([...out.matchAll(VAR)].map((m) => m[1]).filter((n) => !map.has(n)))]
  return { text: out, missing }
}

export interface ResolvedRequest { method: ApiMethod; url: string; headers: [string, string][]; body?: string; form?: [string, string][]; multipart?: [string, string][] }
/** 表单对按 HTML 表单规则编码（key=value&…） */
export const encodeApiForm = (pairs: [string, string][]) => pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
/** 模板 → 要发出去的请求（变量已替换；密钥占位符还在）。form 保留未编码的键值对，主进程展开密钥后再编码 */
export function resolveApiRequest(req: ApiRequest, vars: ApiKV[]): { resolved: ResolvedRequest; missing: string[] } {
  const missing = new Set<string>()
  const sub = (s: string) => { const r = substituteVars(s, vars); r.missing.forEach((m) => missing.add(m)); return r.text }
  const url = sub(req.url.trim())
  const headers: [string, string][] = req.headers.filter((h) => !h.off && h.key.trim()).map((h) => [sub(h.key.trim()), sub(h.value)])
  // 远端 curl 配置会把 \n 还原成真实换行；在发送前明确拒绝，不靠 UI 单行输入框隐藏
  const ctl = (s: string) => /[\r\n\0]/.test(s)
  if (ctl(url)) throw new Error(tr('URL 里不能有换行或控制字符'))
  const badHeader = headers.find(([k, v]) => ctl(k) || ctl(v))
  if (badHeader) throw new Error(tr('请求头里不能有换行或控制字符'))
  let body: string | undefined, form: [string, string][] | undefined, multipart: [string, string][] | undefined
  if (req.bodyType !== 'none' && req.method !== 'GET' && req.method !== 'HEAD') {
    if (req.bodyType === 'form' || req.bodyType === 'multipart') {
      const pairs = req.body.split(/\r?\n/).filter((l) => l.trim()).map((l) => {
        const i = l.indexOf('=')
        return [sub(i < 0 ? l : l.slice(0, i)).trim(), sub(i < 0 ? '' : l.slice(i + 1))] as [string, string]
      })
      if (req.bodyType === 'form') { form = pairs; body = encodeApiForm(form) } else multipart = pairs
    } else body = sub(req.body)
    const ct = req.bodyType === 'json' ? 'application/json' : req.bodyType === 'form' ? 'application/x-www-form-urlencoded' : ''
    if (ct && !headers.some(([k]) => k.toLowerCase() === 'content-type')) headers.push(['Content-Type', ct])
  }
  return { resolved: { method: req.method, url, headers, ...(body !== undefined ? { body } : {}), ...(form ? { form } : {}), ...(multipart ? { multipart } : {}) }, missing: [...missing] }
}

/** URL 只允许 http / https（防止 file:// 之类被拿去读本机文件） */
export function checkApiUrl(url: string): string | undefined {
  if (!url) return tr('请填写 URL')
  let u: URL
  try { u = new URL(url) } catch { return tr('URL 不合法：{v}', { v: url.slice(0, 200) }) }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return tr('只支持 http:// 和 https://')
  return undefined
}

// ── curl 导出 / 导入 ──
const shq = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)
/** 「复制为 curl」：用模板（占位符原样），多行便于阅读 */
export function toCurl(req: ApiRequest): string {
  const parts = ['curl', '-g']   // URL 里的 [] {} 按字面量，不做 glob
  // HEAD 用 -I：-X HEAD 会让 curl 等一个不会来的响应体
  if (req.method === 'HEAD') parts.push('-I')
  else if (req.method !== 'GET' || (req.bodyType !== 'none' && req.body)) parts.push(`-X ${req.method}`)
  parts.push(shq(req.url))
  for (const h of req.headers) if (!h.off && h.key.trim()) parts.push(`-H ${shq(`${h.key.trim()}: ${h.value}`)}`)
  if (req.bodyType !== 'none' && req.body && req.method !== 'GET' && req.method !== 'HEAD') {
    if (req.bodyType === 'json' && !req.headers.some((h) => !h.off && h.key.trim().toLowerCase() === 'content-type')) parts.push(`-H ${shq('Content-Type: application/json')}`)
    if (req.bodyType === 'form') {
      // 直接用编码后的整体 body：避免 --data-urlencode 把以 @ 开头的行当成文件读取
      parts.push(`-H ${shq('Content-Type: application/x-www-form-urlencoded')}`)
      parts.push(`--data-raw ${shq(encodeApiForm(req.body.split(/\r?\n/).filter((x) => x.trim()).map((l) => {
        const i = l.indexOf('=')
        return [i < 0 ? l.trim() : l.slice(0, i).trim(), i < 0 ? '' : l.slice(i + 1)] as [string, string]
      })))}`)
    } else if (req.bodyType === 'multipart') {
      // 文件字段写 key=@路径；不手写 Content-Type，curl 自己带 boundary
      for (const l of req.body.split(/\r?\n/).filter((x) => x.trim())) parts.push(`-F ${shq(l)}`)
    } else parts.push(`--data-raw ${shq(req.body)}`)
  }
  return parts.join(' \\\n  ')
}

/** shell 风格分词：单引号 / 双引号 / 反斜杠转义 / 反斜杠续行；$'..' 简单处理 \n \t \\ \' */
export function shellWords(s: string): string[] {
  const out: string[] = []
  let cur = '', has = false, i = 0
  const push = () => { if (has) out.push(cur); cur = ''; has = false }
  while (i < s.length) {
    const c = s[i]
    if (c === '\\' && (s[i + 1] === '\n' || (s[i + 1] === '\r' && s[i + 2] === '\n'))) { i += s[i + 1] === '\r' ? 3 : 2; continue }
    if (/\s/.test(c)) { push(); i++; continue }
    has = true
    if (c === "'") { const j = s.indexOf("'", i + 1); cur += s.slice(i + 1, j < 0 ? s.length : j); i = j < 0 ? s.length : j + 1; continue }
    if (c === '$' && s[i + 1] === "'") {
      i += 2
      while (i < s.length && s[i] !== "'") {
        if (s[i] === '\\' && i + 1 < s.length) { const e = s[i + 1]; cur += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e; i += 2 } else cur += s[i++]
      }
      i++; continue
    }
    if (c === '"') {
      i++
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length && '"\\$`\n'.includes(s[i + 1])) { cur += s[i + 1]; i += 2 } else cur += s[i++]
      }
      i++; continue
    }
    if (c === '\\' && i + 1 < s.length) { cur += s[i + 1]; i += 2; continue }
    cur += c; i++
  }
  push()
  return out
}

/** 「从 curl 导入」：认 -X / -H / -d 系列 / --json / -u / -I / --url / -G，其它选项忽略 */
export function parseCurl(cmd: string, id: string): ApiRequest | { error: string } {
  const w = shellWords(cmd.trim())
  if (w[0] !== 'curl' && !/[\\/]curl(\.exe)?$/.test(w[0] ?? '')) return { error: tr('不是 curl 命令（要以 curl 开头）') }
  const req = newApiRequest(id, tr('从 curl 导入'))
  const data: string[] = [], urlData: string[] = [], forms: string[] = []
  let method: string | undefined, json = false, form = false, getMode = false
  // 这些选项都带一个参数：不消费参数的话，参数会被当成 URL（如 --cacert ca.pem → url=ca.pem）
  const withArg = new Set(['-X', '--request', '-H', '--header', '-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode', '--json', '-u', '--user', '--url',
    '-A', '--user-agent', '-e', '--referer', '-b', '--cookie', '-o', '--output', '-m', '--max-time', '--connect-timeout', '-x', '--proxy', '-w', '--write-out', '-F', '--form', '--form-string', '--resolve', '--connect-to', '-T', '--upload-file',
    '--cacert', '--capath', '--cert', '--key', '--cert-type', '--key-type', '--pass', '--cookie-jar', '-c', '--proxy-user', '--retry', '--retry-delay', '--retry-max-time', '--limit-rate', '--output-dir', '--trace', '--trace-ascii', '--stderr', '--interface', '--dns-servers', '--unix-socket', '--url-query', '--oauth2-bearer', '--aws-sigv4'])
  for (let i = 1; i < w.length; i++) {
    let a = w[i], v: string | undefined
    // -XPOST / -H'..' / --data=..：选项和值连在一起
    const m = /^(-[XHdubeAmxwFT])(.+)$/.exec(a) ?? /^(--[a-z-]+)=(.*)$/s.exec(a)
    if (m && withArg.has(m[1])) { a = m[1]; v = m[2] }
    else if (withArg.has(a)) v = w[++i]
    if (v === undefined && withArg.has(a)) break
    switch (a) {
      case '-X': case '--request': method = (v ?? '').toUpperCase(); break
      case '-H': case '--header': {
        const j = (v ?? '').indexOf(':')
        if (j > 0) req.headers.push({ key: v!.slice(0, j).trim(), value: v!.slice(j + 1).trim() })
        break
      }
      case '--json': json = true; data.push(v ?? ''); break
      case '--data-urlencode': form = true; urlData.push(v ?? ''); break
      case '-F': case '--form': case '--form-string': forms.push(v ?? ''); break
      case '-d': case '--data': case '--data-raw': case '--data-binary': case '--data-ascii': data.push(v ?? ''); break
      case '-u': case '--user': req.headers.push({ key: 'Authorization', value: `Basic ${b64(v ?? '')}` }); break
      case '-A': case '--user-agent': req.headers.push({ key: 'User-Agent', value: v ?? '' }); break
      case '-e': case '--referer': req.headers.push({ key: 'Referer', value: v ?? '' }); break
      case '-b': case '--cookie': req.headers.push({ key: 'Cookie', value: v ?? '' }); break
      case '--url': req.url = v ?? ''; break
      case '-I': case '--head': method = 'HEAD'; break
      case '-G': case '--get': getMode = true; break
      default: if (!a.startsWith('-') && !req.url) req.url = a
    }
  }
  if (!req.url) return { error: tr('没找到 URL') }
  const dec = (p: string) => { try { return decodeURIComponent(p.replace(/\+/g, ' ')) } catch { return p } }
  if (getMode && (data.length || urlData.length)) {
    // -G --data-urlencode 的 curl 语义是编码后再拼到查询串；-d 的原文保持原样
    const enc = urlData.map((d) => { const i = d.indexOf('='); return i < 0 ? encodeURIComponent(dec(d)) : `${d.slice(0, i)}=${encodeURIComponent(dec(d.slice(i + 1)))}` })
    req.url += (req.url.includes('?') ? '&' : '?') + [...data, ...enc].join('&')
    data.length = 0; urlData.length = 0
  }
  const ct = req.headers.find((h) => h.key.toLowerCase() === 'content-type')?.value.toLowerCase() ?? ''
  if (forms.length) {
    req.bodyType = 'multipart'; req.body = forms.join('\n')
  } else if (data.length || urlData.length) {
    if (form || urlData.length || ct.includes('x-www-form-urlencoded')) {
      req.bodyType = 'form'
      // --data-urlencode 的参数本身就是一个已编码的 key=value；按第一个 = 拆开，值里的 & 不能被当分隔符
      req.body = [...data.flatMap((d) => d.split('&')), ...urlData].map(dec).join('\n')
    } else {
      req.bodyType = json || ct.includes('json') || /^\s*[[{]/.test(data[0]) ? 'json' : 'text'
      req.body = data.join('&')
    }
    if (json && !ct) req.headers.push({ key: 'Content-Type', value: 'application/json' })
  }
  const mm = method ?? (data.length || urlData.length || forms.length ? 'POST' : 'GET')
  req.method = isMethod(mm) ? mm : 'GET'
  try { req.name = `${req.method} ${new URL(req.url).pathname}` } catch { req.name = `${req.method} ${req.url.slice(0, 60)}` }
  // 导入的 header / URL 也可能带 CR/LF（$'...' 写法）：按持久化同样的规则清洗掉
  return sanitizeApiRequest(req) ?? { error: tr('导入的请求不合法') }
}
const b64 = (s: string) => {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

// ── 远程发送：curl -K - ──
/** curl 配置文件里的双引号字符串：\\ \" \n \r \t 转义 */
const cfgQuote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`
/** 写进 curl stdin 的配置（URL / 请求头 / 请求体都在这里，命令行里没有） */
export function curlConfig(r: ResolvedRequest): string {
  // HEAD 用 head 选项（-X HEAD 会让 curl 等一个不会来的响应体）；GET 不用写
  const lines = [`url = ${cfgQuote(r.url)}`, r.method === 'HEAD' ? 'head' : r.method === 'GET' ? '' : `request = ${cfgQuote(r.method)}`].filter(Boolean)
  for (const [k, v] of r.headers) lines.push(`header = ${cfgQuote(`${k}: ${v}`)}`)
  // data-raw 不解释开头的 @（data-binary 会把 @/path 当成远端文件读走）；multipart 用 form，@路径是远端文件
  if (r.multipart) for (const [k, v] of r.multipart) lines.push(`form = ${cfgQuote(`${k}=${v}`)}`)
  else if (r.body !== undefined) lines.push(`data-raw = ${cfgQuote(r.body)}`)
  return `${lines.join('\n')}\n`
}
export const API_TIME_MARK = '@@api-time:'
/** 远端命令：-q 不读 ~/.curlrc、-g 关闭 URL glob、-sS 静默但报错、-i 带响应头、-w 末尾追加耗时；不跟随重定向 */
export const remoteCurlCommand = (timeoutSec = API_TIMEOUT_MS / 1000) =>
  `command -v curl >/dev/null 2>&1 || { echo "@@api-nocurl"; exit 0; }; curl -q -g -sS -i --max-time ${timeoutSec} -K - -w '\\n${API_TIME_MARK}%{time_total}' 2>&1`

/** 解析远端 curl 的输出：可能有多个响应头块（100 Continue / 代理 CONNECT），取最后一个；出错返回 error */
export function parseCurlOutput(out: string): { status: number; statusText: string; headers: [string, string][]; body: string; ms?: number; after?: string } | { error: string } {
  if (out.startsWith('@@api-nocurl')) return { error: tr('该主机上没有 curl 命令，无法从这台主机发送') }
  let text = out
  let ms: number | undefined, after = ''
  const ti = text.lastIndexOf(`\n${API_TIME_MARK}`)
  if (ti >= 0) {
    // 耗时后面可能还跟着 curl 的报错（stderr 晚于 -w 输出到达）
    const m = /^([\d.]+)([\s\S]*)$/.exec(text.slice(ti + API_TIME_MARK.length + 1))
    if (m) { ms = Math.round(Number.parseFloat(m[1]) * 1000); after = m[2].trim() }
    text = text.slice(0, ti)
  }
  let status = 0, statusText = '', headers: [string, string][] = []
  for (;;) {
    const m = /^HTTP\/[\d.]+ (\d{3})(?: ([^\r\n]*))?\r?\n/.exec(text)
    if (!m) break
    const end = /\r?\n\r?\n/.exec(text)
    const block = end ? text.slice(0, end.index) : text
    text = end ? text.slice(end.index + end[0].length) : ''
    status = Number(m[1]); statusText = (m[2] ?? '').trim()
    headers = block.split(/\r?\n/).slice(1).flatMap((l) => { const i = l.indexOf(':'); return i > 0 ? [[l.slice(0, i).trim(), l.slice(i + 1).trim()] as [string, string]] : [] })
    if (status >= 200 || status < 100) break    // 1xx 后面还有真正的响应
  }
  if (!status) return { error: `${text.trim()}\n${after}`.trim().slice(0, 1000) || tr('curl 没有返回响应') }
  // after = -w 之后才到达的 curl 错误（服务端中途断流 / 读超时）；调用方必须当成未完成，不能显示成成功
  return { status, statusText, headers, body: text, ...(ms !== undefined ? { ms } : {}), ...(after ? { after } : {}) }
}

// ── 响应体展示：JSON 美化、HTML / XML 换行缩进（都只影响显示，复制仍用原文）──

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
const RAW_TAGS = new Set(['script', 'style', 'textarea', 'pre'])
const MARKUP_MAX = 2 * 1024 * 1024   // 超过这个大小不格式化，避免卡住界面

/** 从 '<' 开始找标签结束的 '>'（跳过属性值引号里的 '>'） */
function tagEnd(src: string, from: number): number {
  let q = ''
  for (let i = from + 1; i < src.length; i++) {
    const c = src[i]
    if (q) { if (c === q) q = ''; continue }
    if (c === '"' || c === "'") q = c
    else if (c === '>') return i
  }
  return -1
}
const tagName = (tag: string) => (/^<\s*([a-zA-Z0-9:-]+)/.exec(tag)?.[1] ?? '').toLowerCase()

/** HTML / XML 换行缩进：每个标签一行，文本节点去掉首尾空白；script / style / textarea / pre 内容原样 */
export function formatMarkup(body: string): string {
  const out: string[] = []
  let i = 0, depth = 0
  const pad = (d = depth) => '  '.repeat(Math.max(0, d))
  while (i < body.length) {
    const lt = body.indexOf('<', i)
    if (lt < 0) { const text = body.slice(i).trim(); if (text) out.push(pad() + text); break }
    const text = body.slice(i, lt).trim()
    if (text) out.push(pad() + text)
    if (body.startsWith('<!--', lt)) {   // 注释
      const end = body.indexOf('-->', lt + 4)
      const e = end < 0 ? body.length : end + 3
      out.push(pad() + body.slice(lt, e).trim())
      i = e
      continue
    }
    if (body.startsWith('<![CDATA[', lt)) {
      const end = body.indexOf(']]>', lt + 9)
      const e = end < 0 ? body.length : end + 3
      out.push(pad() + body.slice(lt, e).trim())
      i = e
      continue
    }
    const gt = tagEnd(body, lt)
    if (gt < 0) { out.push(pad() + body.slice(lt).trim()); break }
    const tag = body.slice(lt, gt + 1)
    if (/^<\s*\//.test(tag)) {   // 关闭标签：先减一层
      depth = Math.max(0, depth - 1)
      out.push(pad() + tag)
      i = gt + 1
      continue
    }
    const name = tagName(tag)
    const decl = /^<\s*[!?]/.test(tag)   // <!DOCTYPE> / <?xml?>：不改变层级
    const self = decl || /\/\s*>$/.test(tag) || VOID_TAGS.has(name)
    out.push(pad() + tag)
    if (!self && RAW_TAGS.has(name)) {   // script / style / pre：内容原样，不解析里面的 '<'
      const rest = body.slice(gt + 1)
      const m = new RegExp(`</\\s*${name}\\s*>`, 'i').exec(rest)
      if (m) {
        const raw = rest.slice(0, m.index).trim()
        if (raw) out.push(pad(depth + 1) + raw)
        out.push(pad() + m[0])
        i = gt + 1 + m.index + m[0].length
        continue
      }
    }
    if (!self) depth++
    i = gt + 1
  }
  return out.join('\n')
}

/** 响应体展示：JSON 格式化（解析不了原样）；HTML / XML 换行缩进。复制仍用原始响应 */
export function prettyBody(body: string, contentType = ''): { text: string; json: boolean } {
  const t = body.trim()
  if (/json/i.test(contentType) || /^[[{]/.test(t)) {
    try { return { text: JSON.stringify(JSON.parse(t), null, 2), json: true } } catch { /* 不是合法 JSON */ }
  }
  if (t.length <= MARKUP_MAX && (/html|xml|svg/i.test(contentType) || /^<(!doctype|html|svg|\?xml)/i.test(t))) {
    return { text: formatMarkup(body), json: false }
  }
  return { text: body, json: false }
}

/** 历史 / 标题里显示的「发送位置」 */
export const apiViaLabel = (via: string, title?: string) => (via === 'local' ? tr('via|本机') : title ?? via)
