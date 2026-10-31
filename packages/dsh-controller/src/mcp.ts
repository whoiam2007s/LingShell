/* eslint-disable @typescript-eslint/no-explicit-any */
// MCP 服务接入：用官方 @modelcontextprotocol/sdk 的 Client 连外部服务，把每个工具注册成 dsh 工具。
//
// 为什么不用 @deepseek-ai/dsh-mcp-client 插件（0.1.1-rc.2 有同版本）：它也是包这个 SDK，但还要额外拉
// dsh-subprocess 等 peer；一个插件实例对应一个服务、状态只进日志，拿不到连接状态/工具列表给设置页，
// 「连接测试」也得另起客户端；结果投影依赖 ctx.attachments 才处理图片。我们要的只是
// connect → tools/list → tools/call 三件事，直接用 SDK + ctx.tools.register 更小更可控。
//
// 参数 schema 原样透传：ctx.tools.register 走「原始 JSON Schema」路径（入参校验由工具自己负责，
// MCP 服务端本来就会校验），dsh-mcp-client 也是这么做的；只补 type:'object'、去掉 $schema/$id，
// 再塞一个可选 explain（给授权卡看的说明，调用前剥掉，不发给服务端）。
import { createHash } from 'node:crypto'
import { tr, type McpServerConfig, type McpServerStatus, type McpToolInfo, type TrustLevel } from '@lingshell/shared'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { CallToolResultSchema, ListToolsResultSchema, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Decision } from './terminalTools.js'

type LogFn = (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void

export const MCP_RESULT_MAX = 20_000
const MAX_NAME = 64           // DeepSeek/OpenAI 函数名上限，字符集 [A-Za-z0-9_-]
const HASH_LEN = 12
const ARGS_VIEW_MAX = 4000

export const MCP_GUIDANCE = 'MCP 工具：名字以 mcp__<服务>__ 开头的工具来自用户接入的外部服务（监控/数据库/工单等），调用可能产生外部副作用，'   // i18n-ignore 给模型的提示词 / 工具结果
  + '除用户标记免确认的工具外每次都要用户确认。调用时填 explain（一句通俗中文说明要做什么）。结果过长会被截断，请用过滤/分页/limit 参数缩小范围。'   // i18n-ignore 给模型的提示词 / 工具结果

const EXPLAIN_PROP = { type: 'string', description: '一句通俗中文（≤60 字）说明这次调用要做什么，显示在用户的授权卡上（不会发给该服务）' }   // i18n-ignore 给模型的提示词 / 工具结果

/** 服务 id → 工具名里的命名空间段：服务名能用的字符留下，全是中文等就退成 srv_<id>，重名追加 id */
export function mcpNamespaces(servers: { id: string; name: string }[]): Map<string, string> {
  const out = new Map<string, string>()
  const used = new Set<string>()
  const idPart = (id: string) => id.replace(/[^A-Za-z0-9]/g, '').slice(0, 6)
  for (const s of servers) {
    let ns = s.name.replace(/[^A-Za-z0-9-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24)
    if (!/[A-Za-z0-9]/.test(ns)) ns = `srv_${idPart(s.id)}`
    if (used.has(ns)) ns = `${ns}_${idPart(s.id)}`
    used.add(ns)
    out.set(s.id, ns)
  }
  return out
}

/** mcp__<ns>__<工具> 规范成合法函数名；替换/截断过就追加 (ns, 原名) 的哈希，保证不同工具不撞名（同 dsh-mcp-client） */
export function mcpToolName(ns: string, raw: string): string {
  const joined = `mcp__${ns}__${raw}`
  const norm = joined.replace(/[^A-Za-z0-9_-]/g, '_')
  if (norm === joined && norm.length <= MAX_NAME) return norm
  const hash = createHash('sha256').update(`${ns}\0${raw}`).digest('hex').slice(0, HASH_LEN)
  return `${norm.slice(0, MAX_NAME - HASH_LEN - 1)}_${hash}`
}

/** MCP inputSchema → dsh 原始参数 schema。explain=true 表示 explain 是我们塞的，调用前要剥掉 */
export function mcpParameters(schema: unknown): { parameters: Record<string, unknown>; explain: boolean } {
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  const { $schema: _s, $id: _i, ...rest } = isObj(schema) ? schema : {}
  const props = isObj(rest.properties) ? rest.properties : {}
  const explain = !('explain' in props)
  return { explain, parameters: { ...rest, type: 'object', properties: explain ? { ...props, explain: EXPLAIN_PROP } : props } }
}

export function stripExplain(args: unknown): Record<string, unknown> {
  const { explain: _e, ...rest } = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  return rest
}

const kb = (base64: unknown) => `${((String(base64 ?? '').length * 3) / 4 / 1024).toFixed(1)} KB`

/** MCP 结果 → 给模型的文本：图片/音频/二进制只报类型和大小不内联；超长截断并告诉模型 */
export function mcpResultText(r: { content?: unknown[]; structuredContent?: unknown }, max = MCP_RESULT_MAX): string {
  const parts = (r.content ?? []).map((b: any) => {
    switch (b?.type) {
      case 'text': return String(b.text ?? '')
      case 'image': return `[图片 ${b.mimeType ?? ''}，约 ${kb(b.data)}，未内联]`   // i18n-ignore 给模型的提示词 / 工具结果
      case 'audio': return `[音频 ${b.mimeType ?? ''}，约 ${kb(b.data)}，未内联]`   // i18n-ignore 给模型的提示词 / 工具结果
      case 'resource': {
        const res = b.resource ?? {}
        return typeof res.text === 'string' ? `[资源 ${res.uri ?? ''}]\n${res.text}` : `[资源 ${res.uri ?? ''}（${res.mimeType ?? '二进制'}，约 ${kb(res.blob)}，未内联）]`   // i18n-ignore 给模型的提示词 / 工具结果
      }
      case 'resource_link': return `[资源链接 ${b.name ?? ''} ${b.uri ?? ''}]`   // i18n-ignore 给模型的提示词 / 工具结果
      default: return `[不支持的内容类型 ${String(b?.type)}]`   // i18n-ignore 给模型的提示词 / 工具结果
    }
  })
  let text = parts.join('\n')
  if (!text && r.structuredContent !== undefined) text = JSON.stringify(r.structuredContent, null, 2)
  if (!text) return '（无输出）'   // i18n-ignore 给模型的提示词 / 工具结果
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n\n[结果过长已截断：共 ${text.length} 字符，只保留前 ${max} 字符。需要其余部分请用过滤/分页/limit 等参数缩小范围重新查询]`   // i18n-ignore 给模型的提示词 / 工具结果
}

/**
 * MCP 调用的授权决策（纯函数）：外部副作用，默认每次问。
 * 免确认（用户在工具列表里逐个勾的）放行；只读信任档 / 无人值守巡检里，凡需确认的一律拒（巡检没人点卡，绝不挂起）。
 */
export function mcpDecision(p: { autoApproved: boolean; trust?: TrustLevel; unattended?: boolean }): Decision {
  if (p.autoApproved) return { kind: 'allow' }
  if (p.unattended) return { kind: 'deny', reason: tr('mcp: 无人值守巡检不允许需要确认的 MCP 调用（可在设置里把该工具标为免确认）') }
  if (p.trust === 'readonly') return { kind: 'deny', reason: tr('mcp: 只读信任档不允许调用未标记免确认的 MCP 工具') }
  return { kind: 'ask', reason: 'mcp' }
}

/** 授权卡上的参数：去掉 explain、格式化、截断 */
export function mcpArgsView(args: unknown, max = ARGS_VIEW_MAX): string {
  const s = JSON.stringify(stripExplain(args), null, 2)
  return s.length > max ? `${s.slice(0, max)}\n${tr('…（参数过长，已截断）')}` : s
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500)

/** 连一个服务并列出全部工具。http 先试 Streamable HTTP，不行回退旧版 SSE。失败抛错（stdio 带上 stderr 末尾便于排查） */
export async function openMcp(cfg: McpServerConfig, timeoutMs = 30_000): Promise<{ client: Client; tools: any[] }> {
  const connect = async (transport: any) => {
    const client = new Client({ name: 'lingshell', version: '1.0.0' })
    try { await client.connect(transport, { timeout: timeoutMs }); return client }
    catch (e) { await client.close().catch(() => {}); throw e }
  }
  let client: Client
  if (cfg.transport === 'stdio') {
    if (!cfg.command?.trim()) throw new Error(tr('未填写启动命令'))
    // env 只给安全默认集（PATH/HOME 等，SDK 的 getDefaultEnvironment）+ 用户配的，应用自己的 API key 等不外泄给子进程
    const t = new StdioClientTransport({ command: cfg.command.trim(), args: cfg.args ?? [], env: cfg.env, cwd: cfg.cwd || undefined, stderr: 'pipe' })
    let tail = ''
    t.stderr?.on('data', (d) => { tail = (tail + String(d)).slice(-1000) })   // 一直读着：不读子进程写满 stderr 管道会卡死
    try { client = await connect(t) }
    catch (e) { throw new Error(`${errText(e)}${tail.trim() ? `\nstderr: ${tail.trim()}` : ''}`) }
  } else {
    if (!cfg.url?.trim()) throw new Error(tr('未填写 URL'))
    const url = new URL(cfg.url.trim())
    const requestInit = { headers: cfg.headers ?? {} }
    try { client = await connect(new StreamableHTTPClientTransport(url, { requestInit })) }
    catch (e) {
      try { client = await connect(new SSEClientTransport(url, { requestInit })) }
      catch { throw e }   // 两种都不行：报 Streamable HTTP 的错（更常见、更有用）
    }
  }
  try {
    const tools: any[] = []
    let cursor: string | undefined
    for (let page = 0; page < 50; page++) {
      const r = await client.request({ method: 'tools/list', ...(cursor ? { params: { cursor } } : {}) }, ListToolsResultSchema, { timeout: timeoutMs })
      tools.push(...r.tools)
      cursor = r.nextCursor
      if (!cursor) break
    }
    return { client, tools }
  } catch (e) { await client.close().catch(() => {}); throw e }
}

export interface McpToolRef { serverId: string; server: string; tool: string; publicName: string; autoApproved: boolean }
// 工具体外面包一层（DshController 用它做拒绝原因回传 + 审计）
export type McpAround = (exec: any, ref: McpToolRef, args: unknown, run: () => Promise<string>) => Promise<string>
type Register = (def: any) => () => void

interface Conn {
  cfg: McpServerConfig
  key: string
  ns: string
  client?: Client
  status: McpServerStatus
  tools: Map<string, { raw: string; description: string; parameters: Record<string, unknown>; explain: boolean }>
  unregister: (() => void)[]
  closed: boolean
  retries: number
  timer?: ReturnType<typeof setTimeout>
}

/**
 * 管所有 MCP 连接：按配置连/断/重连，工具注册进 dsh（bind 之后；bind 之前连上的在 bind 时补注册）。
 * 一个服务失败只影响它自己（状态标 failed，日志 + 设置页可见），不影响启动和其他服务。
 */
export class McpManager {
  private conns = new Map<string, Conn>()
  private register?: Register
  private around?: McpAround

  constructor(private opts: { log?: LogFn; onStatus?(servers: McpServerStatus[]): void; connectTimeoutMs?: number; callTimeoutMs?: number; retryBaseMs?: number } = {}) {}

  bind(register: Register, around?: McpAround): void {
    this.register = register
    this.around = around
    for (const c of this.conns.values()) this.publish(c)
  }

  /** 应用一份新配置：没变的连接不动（只改免确认也不重连），变了的断开重连，删掉的断开并注销工具 */
  async apply(configs: McpServerConfig[]): Promise<void> {
    const nss = mcpNamespaces(configs)
    const ids = new Set(configs.map((c) => c.id))
    for (const [id, c] of this.conns) if (!ids.has(id)) { this.drop(c); this.conns.delete(id) }
    const jobs: Promise<void>[] = []
    for (const cfg of configs) {
      const ns = nss.get(cfg.id)!
      const { autoApprove: _a, ...conn } = cfg
      const key = JSON.stringify({ ...conn, ns })
      const cur = this.conns.get(cfg.id)
      if (cur?.key === key) { cur.cfg = cfg; continue }
      if (cur) this.drop(cur)
      const c: Conn = {
        cfg, key, ns, tools: new Map(), unregister: [], closed: false, retries: 0,
        status: { id: cfg.id, name: cfg.name, state: cfg.enabled ? 'connecting' : 'disabled', tools: [] },
      }
      this.conns.set(cfg.id, c)
      if (cfg.enabled) jobs.push(this.connect(c))
    }
    this.emit()
    await Promise.all(jobs)
  }

  /** 连接测试：临时连一次列出工具就断开，不注册 */
  async test(cfg: McpServerConfig): Promise<McpToolInfo[]> {
    const { client, tools } = await openMcp(cfg, this.opts.connectTimeoutMs)
    await client.close().catch(() => {})
    const ns = mcpNamespaces([cfg]).get(cfg.id)!
    return tools.map((t) => ({ name: t.name, description: t.description, publicName: mcpToolName(ns, t.name) }))
  }

  lookup(publicName: string): McpToolRef | undefined {
    if (!publicName.startsWith('mcp__')) return undefined
    for (const c of this.conns.values()) {
      const t = c.tools.get(publicName)
      if (t) return { serverId: c.cfg.id, server: c.cfg.name, tool: t.raw, publicName, autoApproved: !!c.cfg.autoApprove?.includes(t.raw) }
    }
    return undefined
  }

  status(): McpServerStatus[] { return [...this.conns.values()].map((c) => ({ ...c.status, tools: [...c.status.tools] })) }

  async close(): Promise<void> {
    for (const c of this.conns.values()) this.drop(c)
    this.conns.clear()
  }

  private emit(): void { this.opts.onStatus?.(this.status()) }

  private async connect(c: Conn): Promise<void> {
    try {
      const { client, tools } = await openMcp(c.cfg, this.opts.connectTimeoutMs)
      if (c.closed) { await client.close().catch(() => {}); return }
      c.client = client
      client.onclose = () => this.lost(c, client)
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => { void this.resync(c, client) })
      c.retries = 0
      c.status = { ...c.status, state: 'connected', error: undefined }
      this.setTools(c, tools)
      this.opts.log?.('info', 'mcp connected', { server: c.cfg.name, tools: tools.length })
    } catch (e) {
      if (c.closed) return
      c.status = { ...c.status, state: 'failed', error: errText(e), tools: [] }
      this.opts.log?.('warn', 'mcp connect failed', { server: c.cfg.name, err: errText(e) })
    }
    this.emit()
  }

  // 服务端说工具列表变了：重新拉一遍替换
  private async resync(c: Conn, client: Client): Promise<void> {
    try {
      const r = await client.request({ method: 'tools/list' }, ListToolsResultSchema, { timeout: this.opts.connectTimeoutMs ?? 30_000 })
      if (c.closed || c.client !== client) return
      this.setTools(c, r.tools)
      this.emit()
    } catch (e) { this.opts.log?.('warn', 'mcp resync failed', { server: c.cfg.name, err: errText(e) }) }
  }

  // 连接意外断开（子进程崩了等）：注销工具，退避重连，最多 5 次
  private lost(c: Conn, client: Client): void {
    if (c.closed || c.client !== client) return
    c.client = undefined
    this.unpublish(c)
    c.status = { ...c.status, state: 'failed', error: tr('连接已断开'), tools: [] }
    this.opts.log?.('warn', 'mcp connection lost', { server: c.cfg.name, retries: c.retries })
    if (c.retries < 5) {
      const delay = Math.min(30_000, (this.opts.retryBaseMs ?? 2000) * 2 ** c.retries++)
      c.timer = setTimeout(() => {
        if (c.closed) return
        c.status = { ...c.status, state: 'connecting' }
        this.emit()
        void this.connect(c)
      }, delay)
    }
    this.emit()
  }

  private setTools(c: Conn, tools: any[]): void {
    this.unpublish(c)
    c.tools.clear()
    for (const t of tools) {
      const publicName = mcpToolName(c.ns, String(t.name))
      if (c.tools.has(publicName)) continue   // 服务端重复列同名工具：只留第一个
      const { parameters, explain } = mcpParameters(t.inputSchema)
      c.tools.set(publicName, { raw: String(t.name), description: String(t.description ?? ''), parameters, explain })
    }
    c.status = { ...c.status, tools: [...c.tools].map(([publicName, t]) => ({ name: t.raw, description: t.description || undefined, publicName })) }
    this.publish(c)
  }

  private publish(c: Conn): void {
    if (!this.register || c.status.state !== 'connected' || c.unregister.length) return
    for (const [publicName, t] of c.tools) {
      try {
        c.unregister.push(this.register({
          name: publicName,
          description: `[MCP · ${c.cfg.name}] ${t.description}`.slice(0, 2000),
          parameters: t.parameters,
          output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
          execute: async (args: unknown, exec: any) => {
            const ref = this.lookup(publicName) ?? { serverId: c.cfg.id, server: c.cfg.name, tool: t.raw, publicName, autoApproved: false }
            const run = () => this.call(c, t.raw, t.explain ? stripExplain(args) : (args as Record<string, unknown>), exec?.signal)
            return this.around ? this.around(exec, ref, args, run) : run()
          },
        }))
      } catch (e) { this.opts.log?.('warn', 'mcp tool register failed', { server: c.cfg.name, tool: publicName, err: errText(e) }) }
    }
  }

  private unpublish(c: Conn): void {
    for (const off of c.unregister.splice(0)) { try { off() } catch { /* 已随 Context 释放 */ } }
  }

  private async call(c: Conn, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const client = c.client
    if (!client) throw new Error(c.status.error ? tr('MCP 服务「{name}」未连接：{error}', { name: c.cfg.name, error: c.status.error }) : tr('MCP 服务「{name}」未连接', { name: c.cfg.name }))
    const r = await client.request({ method: 'tools/call', params: { name: tool, arguments: args } }, CallToolResultSchema,
      { signal, timeout: this.opts.callTimeoutMs ?? 120_000 })
    const text = mcpResultText(r)
    if (r.isError) throw new Error(text)
    return text
  }

  private drop(c: Conn): void {
    c.closed = true
    if (c.timer) clearTimeout(c.timer)
    this.unpublish(c)
    const client = c.client
    c.client = undefined
    if (client) void client.close().catch(() => {})
  }
}
