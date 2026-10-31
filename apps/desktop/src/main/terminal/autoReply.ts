import { AUTO_REPLY_MAX_PER_MIN, matchAutoReply, type AutoReplySummary } from '@lingshell/shared'
import { LineFilter } from './sessionLog.js'

// 自动应答（Xshell「触发器」）：终端输出停下来（QUIET_MS 内无新输出 = 光标停在提示上等输入）时，
// 只拿光标所在的最后一行（未换行，去 ANSI，同会话日志的 LineFilter）去匹配规则，命中就发应答。
// 安全约束：
// - AI 经哨兵 execCapture 执行期间绝不触发：execCapture 期间原始输出本就不走 onData，但结束/超时时会把捕获的输出
//   回放到 UI（超时的半截输出可能正停在 "[sudo] password for"），所以收到数据时只要终端处于 AI 锁定中，
//   就把「当前这一行」标为已污染，直到换行都不触发。理由：AI 不能借自动应答拿到/用上 sudo 密码——
//   密码一旦代填给 AI 的命令，等于把提权交给了模型，且绕过逐条授权。没有例外。
// - 生产主机（env=prod）不触发，除非规则显式 allowProd。
// - 每次提示只触发一次（换行后才算新提示）；同一规则同一终端 1 分钟内最多 AUTO_REPLY_MAX_PER_MIN 次，
//   超出即在该终端停用并通知（防密码错时无限重试）。
// - 应答不进命令历史 / 录像键入 / 审计 / 运行日志（只记规则名）。会话日志只记输出，密码提示不回显所以不含密码。

export const QUIET_MS = 150
const WINDOW_MS = 60_000

export type AutoReplyRule = Omit<AutoReplySummary, 'hasResponse'>   // response 已解密；undefined = 未设置

export interface AutoReplyDeps {
  rules: () => AutoReplyRule[]
  hostKey: (terminalId: string) => string        // 'local' | 已存主机 id | host:port
  isProd: (hostKey: string) => boolean
  aiBusy: (terminalId: string) => boolean        // AI execCapture / 静默探测中
  write: (terminalId: string, data: string) => void
  notify: (terminalId: string, rule: string, disabled?: boolean) => void
  log?: (message: string, data?: unknown) => void
  now?: () => number
  quietMs?: number
}

interface TermState { filter: LineFilter; done: boolean; tainted: boolean; hits: Map<string, number[]>; off: Set<string>; timer?: ReturnType<typeof setTimeout> }

export class AutoReplyEngine {
  private terms = new Map<string, TermState>()
  constructor(private d: AutoReplyDeps) {}

  attach(id: string): void {
    if (!this.terms.has(id)) this.terms.set(id, { filter: new LineFilter(), done: false, tainted: false, hits: new Map(), off: new Set() })
  }
  detach(id: string): void { clearTimeout(this.terms.get(id)?.timer); this.terms.delete(id) }

  data(id: string, chunk: string): void {
    const t = this.terms.get(id)
    if (!t) return
    if (t.filter.feed(chunk).length) { t.done = false; t.tainted = false }   // 换过行 = 新的提示
    if (this.d.aiBusy(id)) t.tainted = true
    clearTimeout(t.timer)
    t.timer = setTimeout(() => this.check(id), this.d.quietMs ?? QUIET_MS)
  }

  private check(id: string): void {
    const t = this.terms.get(id)
    if (!t || t.done || t.tainted || this.d.aiBusy(id)) return
    const line = t.filter.peek()
    if (!line.trim()) return
    const hk = this.d.hostKey(id)
    const prod = this.d.isProd(hk)
    const rule = this.d.rules().find((r) => r.enabled && !t.off.has(r.id) && (!prod || r.allowProd)
      && (r.scope === 'all' || r.scope.includes(hk)) && r.response !== undefined && (r.response || r.appendEnter)
      && matchAutoReply(line, r.pattern, r.regex))
    if (!rule) return
    t.done = true
    const now = this.d.now?.() ?? Date.now()
    const hits = (t.hits.get(rule.id) ?? []).filter((x) => now - x < WINDOW_MS)
    if (hits.length >= AUTO_REPLY_MAX_PER_MIN) {
      t.off.add(rule.id)
      this.d.log?.('自动应答触发过多，已在该终端停用', { terminalId: id, rule: rule.name })   // i18n-ignore 日志
      this.d.notify(id, rule.name, true)
      return
    }
    t.hits.set(rule.id, [...hits, now])
    try { this.d.write(id, rule.response! + (rule.appendEnter ? '\r' : '')) } catch { return }   // 锁定/断线时 write 抛错：不发
    this.d.log?.('自动应答', { terminalId: id, rule: rule.name })   // 不记应答内容 i18n-ignore 日志
    this.d.notify(id, rule.name)
  }
}
