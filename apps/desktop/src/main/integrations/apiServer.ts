import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { AgentEvent } from '@lingshell/shared'

// 对外调用接口：让 Claude Code 等 agent 工具往「当前打开的会话」发一句话，之后取这轮的结果总结。
//
// 为什么是异步任务 + 轮询而不是一次阻塞请求：一轮任务可能跑十几分钟，而调用方那头是有硬上限的
// （Claude Code 的 Bash 工具默认 120s、最大 600s），阻塞式必被调用方自己掐断。所以拆成
// POST /api/send 立刻拿 taskId，GET /api/result 长轮询取结果——每次轮询自己控制等多久，
// 稳稳落在调用方的超时预算内，任务想跑多久跑多久。
//
// 只监听 127.0.0.1 + Authorization token。loopback 不是信任边界：本机任意进程（含浏览器页面）
// 都能打 127.0.0.1，CORS 只拦「读响应」不拦「请求发出」，而本接口的效果是驱动一个能执行 shell 的 AI，
// 攻击者不需要读响应。token 放 header 而非 URL：自定义 header 强制浏览器走 preflight，我们不回 CORS 头即挡死网页侧。

export type SendStatus = 'completed' | 'failed' | 'timeout'
export type TaskStatus = SendStatus | 'running'
export interface SendResult { status: SendStatus; summary: string; sessionId: string; error?: string }

type Unsub = () => void
type OnEvent = (h: (ev: AgentEvent) => void) => Unsub
type LogFn = (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void

const DEFAULT_TASK_TTL_MS = 1_800_000   // 30 分钟：一个任务最长跑多久（不是调用方等多久）
const DEFAULT_POLL_MS = 30_000          // 一次轮询默认挂多久
const MAX_POLL_MS = 300_000             // 单次轮询上限 5 分钟：留足余量给调用方 600s 的硬超时
const TASK_KEEP_MS = 3_600_000          // 终态任务保留 1 小时供重复取用

// 订阅某会话直到本轮 turn 结束，把最后一条 AI 回复当总结。
// 必须在 sendTurn **之前**调用：事件可能早于 sendTurn 的 Promise resolve 到达。
// ponytail: 不按 turnId 匹配——ApiServer 在会话有活跃 turn 时直接回 409（见 busy），
// 所以发出后该会话的下一个 turn 结束就是这次的结果，按 sessionId 过滤够了。
// 超时不中断 turn：调用方等不及不代表该杀掉用户在 UI 里看得见的工作，让它继续跑完。
export function awaitTurn(onEvent: OnEvent, sessionId: string, timeoutMs: number): { promise: Promise<SendResult>; cancel: Unsub } {
  let done = false
  let unsub: Unsub = () => {}
  let timer: ReturnType<typeof setTimeout> | undefined
  let summary = ''
  const promise = new Promise<SendResult>((resolve) => {
    const finish = (r: SendResult) => {
      if (done) return
      done = true; clearTimeout(timer); unsub(); resolve(r)
    }
    timer = setTimeout(() => finish({ status: 'timeout', summary, sessionId }), timeoutMs)
    unsub = onEvent((ev) => {
      if (ev.sessionId !== sessionId) return
      // item 完成时带完整文本（见 dsh-controller relay）；后一条覆盖前一条，留最后一条作总结
      if (ev.type === 'agent:itemUpdated' && ev.kind === 'agent_message' && ev.text) summary = ev.text
      else if (ev.type === 'agent:turnCompleted') finish({ status: 'completed', summary, sessionId })
      else if (ev.type === 'agent:turnFailed') finish({ status: 'failed', summary, sessionId, error: ev.error })
    })
    if (done) unsub()   // 极端情况：订阅期间已 finish，补一次退订
  })
  return { promise, cancel: () => { if (!done) { done = true; clearTimeout(timer); unsub() } } }
}

interface Task {
  sessionId: string
  status: TaskStatus
  summary: string
  error?: string
  done: Promise<SendResult>
  finishedAt?: number
}

export interface ApiServerDeps {
  configDir: string
  activeSessionId: () => string | undefined
  sendTurn: (sessionId: string, text: string) => Promise<void>
  onEvent: OnEvent
  isLocked?: () => boolean   // 应用锁定期间所有接口回 423（已在跑的任务照跑，解锁后可再取结果）
  log?: LogFn
}

export class ApiServer {
  private http?: Server
  private tokenBuf = Buffer.alloc(0)
  private file: string
  private tasks = new Map<string, Task>()
  // 有活跃 turn 的会话。dsh 的 followup 是排队不报错，若此时再发，awaitTurn 会被正在跑的
  // 那一轮（如 UI 发起的）提前结束、拿错总结，所以忙时直接拒绝。
  private busy = new Set<string>()
  private offBusy?: Unsub
  constructor(private deps: ApiServerDeps) { this.file = join(deps.configDir, 'api.json') }

  async start(): Promise<number> {
    const token = randomBytes(24).toString('base64url')
    this.tokenBuf = Buffer.from(token)
    this.offBusy = this.deps.onEvent((ev) => {
      if (ev.type === 'agent:turnStarted') this.busy.add(ev.sessionId)
      else if (ev.type === 'agent:turnCompleted' || ev.type === 'agent:turnFailed') this.busy.delete(ev.sessionId)
    })
    this.http = createServer((req, res) => { void this.onRequest(req, res) })
    // 轮询请求会挂几分钟不发一个字节，Node 默认的各种超时会中途掐断
    this.http.timeout = 0; this.http.keepAliveTimeout = 0; this.http.headersTimeout = 0; this.http.requestTimeout = 0
    await new Promise<void>((r) => this.http!.listen(0, '127.0.0.1', r))
    const port = (this.http.address() as AddressInfo).port
    // 端口随机 + token 落盘，CLI 读这个文件即可，无需约定固定端口
    mkdirSync(this.deps.configDir, { recursive: true })
    // 0600：这个 token 能让本机任何进程驱动当前 AI 会话
    writeFileSync(this.file, JSON.stringify({ port, token }, null, 2), { encoding: 'utf8', mode: 0o600 })
    return port
  }

  stop(): void {
    this.http?.close(); this.http = undefined
    this.offBusy?.(); this.busy.clear()
    this.tasks.clear()
    try { rmSync(this.file) } catch { /* 文件不在就算了 */ }
  }

  // 定长比较防时序侧信道；长度不等时 timingSafeEqual 会抛，先比长度
  private checkToken(header?: string): boolean {
    const got = Buffer.from((header ?? '').replace(/^Bearer\s+/i, ''))
    return got.length === this.tokenBuf.length && this.tokenBuf.length > 0 && timingSafeEqual(got, this.tokenBuf)
  }

  // ponytail: 无定时器，每次新任务时顺手扫。任务量小（人手动发起），O(n) 无所谓。
  private sweep(): void {
    const cutoff = Date.now() - TASK_KEEP_MS
    for (const [id, t] of this.tasks) if (t.finishedAt !== undefined && t.finishedAt < cutoff) this.tasks.delete(id)
  }

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    // token 先于读 body：没凭据的请求连 body 都不读，无需再防大包
    if (!this.checkToken(req.headers.authorization)) return json(401, { error: 'unauthorized' })
    if (this.deps.isLocked?.()) return json(423, { error: 'locked' })

    if (req.method === 'POST' && url.pathname === '/api/send') return this.handleSend(req, json)
    if (req.method === 'GET' && url.pathname === '/api/result') return this.handleResult(url, json)
    return json(404, { error: 'not_found' })
  }

  // 发消息 → 立刻返回 taskId，不等任务跑完
  private async handleSend(req: IncomingMessage, json: (c: number, b: unknown) => void): Promise<void> {
    const raw = await new Promise<string>((resolve) => {
      let b = ''
      req.on('data', (c: Buffer) => { b += c.toString('utf8') })
      req.on('end', () => resolve(b))
    })
    let text: string, ttlMs: number
    try {
      const p = JSON.parse(raw) as { text?: unknown; ttlMs?: unknown }
      text = String(p.text ?? '')
      ttlMs = Number(p.ttlMs) || DEFAULT_TASK_TTL_MS
    } catch { return json(400, { error: 'bad_json' }) }
    if (!text.trim()) return json(400, { error: 'empty_text' })

    const sessionId = this.deps.activeSessionId()
    if (!sessionId) return json(409, { error: 'no_active_session' })
    if (this.busy.has(sessionId)) return json(409, { error: 'session_busy' })

    const wait = awaitTurn(this.deps.onEvent, sessionId, ttlMs)
    // sendTurn 只是提交 turn，很快返回；它失败说明压根没发出去，直接报错不建任务
    try { await this.deps.sendTurn(sessionId, text) }
    catch (e) { wait.cancel(); return json(500, { error: String(e) }) }

    const taskId = randomBytes(8).toString('hex')
    const task: Task = { sessionId, status: 'running', summary: '', done: wait.promise }
    void wait.promise.then((r) => {
      task.status = r.status; task.summary = r.summary; task.error = r.error; task.finishedAt = Date.now()
    })
    this.sweep()
    this.tasks.set(taskId, task)
    this.deps.log?.('info', 'api send', { taskId, sessionId, chars: text.length })
    json(202, { taskId, sessionId })
  }

  // 取结果 → 已终态立刻返回；还在跑就挂到 waitMs（长轮询），到点回 running 让调用方再来
  private async handleResult(url: URL, json: (c: number, b: unknown) => void): Promise<void> {
    const taskId = url.searchParams.get('taskId') ?? ''
    const t = this.tasks.get(taskId)
    if (!t) return json(404, { error: 'unknown_task' })

    if (t.status === 'running') {
      const waitMs = Math.min(Number(url.searchParams.get('waitMs')) || DEFAULT_POLL_MS, MAX_POLL_MS)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, waitMs)
        void t.done.then(() => { clearTimeout(timer); resolve() })
      })
    }
    // 长轮询可能跨过上锁：任务结果（会话摘要）不能在锁定后返回
    if (this.deps.isLocked?.()) return json(423, { error: 'locked' })
    json(200, { status: t.status, summary: t.summary, sessionId: t.sessionId, ...(t.error ? { error: t.error } : {}) })
  }
}
