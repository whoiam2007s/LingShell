// 接口调试面板（见 shared/ops/apiDebug.ts）：请求集合 / 环境变量存数据目录 api-debug.json；发送在主进程做。
// 本机发送 = Node fetch（不跟随重定向）；从某台主机发送 = 该 SSH 终端的独立 exec channel 跑 curl -K -，
// URL / 请求头 / 请求体经 stdin 传给 curl，不出现在远端命令行里。{{secret:x}} 发送前才展开成明文，
// 响应里出现的密钥明文换回占位符；集合 / 历史里只存模板（占位符）。
import { readJson, writeJson } from '@lingshell/config'
import {
  API_BODY_MAX, API_HISTORY_MAX, API_TIMEOUT_MS, checkApiUrl, curlConfig, emptyApiStore, encodeApiForm, parseCurlOutput, remoteCurlCommand, resolveApiRequest,
  sanitizeApiRequest, sanitizeApiStore, tr,
  type ApiHistoryItem, type ApiKV, type ApiResponse, type ApiStore, type ResolvedRequest, type TerminalInfo,
} from '@lingshell/shared'
import type { ExecFullResult } from '@lingshell/terminal-core'
import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'

export interface ApiDebugDeps {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  file: string
  terminal(id: string): TerminalInfo | undefined
  hostKey(terminalId: string): string | undefined
  exec(terminalId: string, command: string, o: { timeoutMs: number; maxBytes?: number; stdin?: string }): Promise<ExecFullResult>
  /** {{secret:x}} → 明文（不加 shell 引号；hostKey 决定可用范围，不能用时抛错） */
  expandSecrets(hostKey: string, text: string): string
  /** 明文 → 占位符 */
  mask(text: string): string
  fetch?: typeof fetch
}

const BINARY = /^(image|audio|video)\/|octet-stream|application\/(pdf|zip|gzip|x-tar|x-7z)/i
// multipart 本机文件字段的 Content-Type：按扩展名猜，猜不到用 octet-stream
const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip', '.json': 'application/json', '.txt': 'text/plain',
  '.csv': 'text/csv', '.xml': 'application/xml', '.html': 'text/html', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg',
}
const mimeOf = (p: string) => MIME[extname(p).toLowerCase()] ?? 'application/octet-stream'

export function loadApiStore(file: string): ApiStore {
  // readJson：损坏时改名为 .corrupt-<时间戳> 再返回 undefined，下一次保存不会静默覆盖；写盘统一 0600 + 原子写
  try { return sanitizeApiStore(readJson<unknown>(file)) } catch { return emptyApiStore() }
}
function saveApiStore(file: string, s: ApiStore): void {
  writeJson(file, s)
}

/** 本机发送：不跟随重定向（3xx 原样给人看），响应体流式读取，最多保留 API_BODY_MAX，不把几百 MB 全读进内存 */
export async function sendLocal(r: ResolvedRequest, f: typeof fetch = fetch): Promise<Omit<ApiResponse, 'via'>> {
  const t0 = performance.now()
  let reqHeaders = r.headers, reqBody: string | FormData | undefined = r.body
  if (r.multipart) {
    // 本机发送：key=@路径 读本机文件，其余按普通字段；Content-Type 由 fetch 带 boundary 生成
    const fd = new FormData()
    for (const [k, v] of r.multipart) {
      if (!v.startsWith('@')) { fd.append(k, v); continue }
      const p = v.slice(1)
      try {
        const buf = await readFile(p)
        fd.append(k, new Blob([buf], { type: mimeOf(p) }), basename(p))
      } catch (e) {
        throw new Error(tr('读取文件失败：{path}（{err}）', { path: p, err: e instanceof Error ? e.message : String(e) }))
      }
    }
    reqBody = fd
    reqHeaders = reqHeaders.filter(([k]) => k.toLowerCase() !== 'content-type')   // 手写的 multipart/form-data 没有 boundary，必须去掉
  }
  const res = await f(r.url, { method: r.method, headers: reqHeaders, body: reqBody, redirect: 'manual', signal: AbortSignal.timeout(API_TIMEOUT_MS) })
  const headers = [...res.headers.entries()] as [string, string][]
  const ct = res.headers.get('content-type') ?? ''
  const chunks: Uint8Array[] = []
  let total = 0, kept = 0, truncated = false
  const reader = res.body?.getReader()
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.length
        if (kept < API_BODY_MAX) {
          const take = value.subarray(0, Math.min(value.length, API_BODY_MAX - kept))
          chunks.push(take); kept += take.length
        }
        if (total > API_BODY_MAX) {
          truncated = true
          await reader.cancel().catch(() => {})
          break
        }
      }
    } catch (e) {
      // 中途断流：已经收到的字节也没法当完整响应
      throw new Error(tr('响应读取中断（已收到 {n} 字节）：{error}', { n: total, error: e instanceof Error ? e.message : String(e) }))
    }
  }
  const ms = Math.round(performance.now() - t0)
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)))
  const body = BINARY.test(ct) ? (truncated ? tr('（二进制内容，{n} 字节，已截断，不显示）', { n: total }) : tr('（二进制内容，{n} 字节，不显示）', { n: total })) : buf.toString('utf8')
  // 有 Content-Length 时显示真实总大小（流式读取只代表读到了多少）
  const cl = Number(res.headers.get('content-length'))
  return { status: res.status, statusText: res.statusText, ms, headers, body, truncated, size: Number.isFinite(cl) && cl > total ? cl : total }
}

export function registerApiDebug(d: ApiDebugDeps): void {
  let store = loadApiStore(d.file)
  const errMsg = (e: unknown) => {
    const m = e instanceof Error ? (e.name === 'TimeoutError' ? tr('请求超时（{n} 秒）', { n: API_TIMEOUT_MS / 1000 }) : (e.cause instanceof Error ? tr('{a}：{b}', { a: e.message, b: e.cause.message }) : e.message)) : String(e)
    return d.mask(m)
  }

  d.handle('api:load', () => store)
  // 集合 / 环境：整份覆盖（历史只由发送追加，不让渲染层改）
  d.handle('api:save', (_e, v) => {
    const s = sanitizeApiStore(v)
    store = { ...s, history: store.history }
    saveApiStore(d.file, store)
    return store
  })
  d.handle('api:clearHistory', () => { store = { ...store, history: [] }; saveApiStore(d.file, store) })

  d.handle('api:send', async (_e, input) => {
    const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
    const req = sanitizeApiRequest(o.request)
    if (!req) throw new Error(tr('非法的请求'))
    const vars = sanitizeApiStore({ envs: [{ id: 'x', vars: o.vars }] }).envs[0]?.vars ?? ([] as ApiKV[])
    const via = typeof o.via === 'string' ? o.via : 'local'
    const t = via === 'local' ? undefined : d.terminal(via)
    if (via !== 'local' && (!t || t.type !== 'ssh')) throw new Error(tr('发送位置的 SSH 终端已关闭，请重新选择'))
    if (t && t.os === 'windows') throw new Error(tr('Windows 主机不支持（需要 sh 和 curl）'))
    const { resolved, missing } = resolveApiRequest(req, vars)
    if (missing.length) throw new Error(tr('未定义的变量：{names}（在「环境」里添加，或检查拼写）', { names: missing.join(tr('、')) }))
    const hk = t ? d.hostKey(t.id) : 'local'
    // 终端映射缺失时不能回退成本机：否则 scope=local 的密钥会被放行到这台 SSH 主机
    if (t && !hk) throw new Error(tr('找不到这个终端对应的主机，已拒绝发送'))
    const hostKey = hk ?? 'local'
    // 密钥展开（范围不对 / 没值直接报错，不发）。表单先展开再编码，否则占位符会变成 %7B%7Bsecret...
    const form = resolved.form?.map(([k, v]) => [d.expandSecrets(hostKey, k), d.expandSecrets(hostKey, v)] as [string, string])
    const multipart = resolved.multipart?.map(([k, v]) => [d.expandSecrets(hostKey, k), d.expandSecrets(hostKey, v)] as [string, string])
    const wire: ResolvedRequest = {
      method: resolved.method, url: d.expandSecrets(hostKey, resolved.url),
      headers: resolved.headers.map(([k, v]) => [d.expandSecrets(hostKey, k), d.expandSecrets(hostKey, v)]),
      ...(form ? { body: encodeApiForm(form) } : multipart ? { multipart } : resolved.body !== undefined ? { body: d.expandSecrets(hostKey, resolved.body) } : {}),
    }
    const bad = checkApiUrl(wire.url)
    if (bad) throw new Error(d.mask(bad))
    const viaLabel = t ? t.title : tr('本机')
    // 历史里存模板 URL（可能含 {{变量}}），不把环境变量里的 token / 密码写进 api-debug.json
    const hist: ApiHistoryItem = { at: new Date().toISOString(), method: req.method, url: req.url, via: viaLabel, request: req }
    const record = (h: ApiHistoryItem) => {
      store = { ...store, history: [h, ...store.history].slice(0, API_HISTORY_MAX) }
      try { saveApiStore(d.file, store) } catch { /* 写盘失败不影响这次结果 */ }
    }
    let res: Omit<ApiResponse, 'via'>
    try {
      if (!t) res = await sendLocal(wire, d.fetch)
      else {
        const r = await d.exec(t.id, remoteCurlCommand(), { timeoutMs: API_TIMEOUT_MS + 5000, maxBytes: API_BODY_MAX + 64 * 1024, stdin: curlConfig(wire) })
        if (r.stopped === 'timeout') throw new Error(tr('请求超时（{n} 秒）', { n: API_TIMEOUT_MS / 1000 }))
        const p = parseCurlOutput(r.output)
        if ('error' in p) throw new Error(p.error)
        // curl 退出码 / -w 之后才到的错误：说明响应没收完，不能显示成干净的 200 + 半截 body
        if (r.code !== 0 || p.after) {
          const why = (p.after || tr('curl 退出码 {code}', { code: r.code ?? tr('frag|未知') })).trim()
          throw new Error(tr('请求未完成{got}：{why}', { got: p.status ? tr('（已收到 HTTP {status}，响应不完整）', { status: p.status }) : '', why }).slice(0, 1500))
        }
        const ct = p.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? ''
        const bin = BINARY.test(ct)
        const cl = Number(p.headers.find(([k]) => k.toLowerCase() === 'content-length')?.[1])
        res = {
          status: p.status, statusText: p.statusText, ms: p.ms ?? 0, headers: p.headers, truncated: r.truncated,
          body: bin ? (r.truncated ? tr('（二进制内容，已截断，不显示）') : tr('（二进制内容，不显示）')) : p.body,
          ...(Number.isFinite(cl) && cl > 0 ? { size: cl } : bin ? { size: Buffer.byteLength(p.body) } : {}),
        }
      }
    } catch (e) {
      const error = errMsg(e)
      record({ ...hist, error })
      throw new Error(error)
    }
    record({ ...hist, status: res.status, ms: res.ms })
    // 响应里回显的密钥明文换回占位符（界面上只看到占位符）
    const out: ApiResponse = { ...res, headers: res.headers.map(([k, v]) => [k, d.mask(v)]), body: d.mask(res.body), via: viaLabel }
    return { response: out, history: store.history }
  })
}
