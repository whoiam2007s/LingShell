import type { AuthLevel, TrustLevel, AuthDecision, AuthRecord } from '@lingshell/shared'
import { dangerCheck } from './danger.js'

export interface AuthState {
  records: AuthRecord[]
  trust: Record<string, TrustLevel>     // sessionId → 信任档
}
export interface AuthStore {
  load(): AuthState
  save(state: AuthState): void
}

const RANK: Record<AuthLevel, number> = { none: 0, read: 1, write: 2 }
function key(s: string, t: string) { return `${s} ${t}` }

export class AuthRegistry {
  private records = new Map<string, AuthLevel>()   // key(session,term) → level
  private trust = new Map<string, TrustLevel>()    // session → trust
  // 限时提权：key(session,host) → 到期时间 ms。只在内存（重启即失效），不落 auth.json
  private sudo = new Map<string, number>()
  private now: () => number
  constructor(private opts: { store: AuthStore; now?: () => number }) {
    this.now = opts.now ?? Date.now
    const st = opts.store.load()
    for (const r of st.records) this.records.set(key(r.sessionId, r.terminalId), r.level)
    for (const [sid, lvl] of Object.entries(st.trust ?? {})) this.trust.set(sid, lvl)
  }

  private persist() {
    const records: AuthRecord[] = []
    for (const [k, level] of this.records) {
      const [sessionId, terminalId] = k.split(' ')
      records.push({ sessionId, terminalId, level })
    }
    const trust: Record<string, TrustLevel> = {}
    for (const [sid, lvl] of this.trust) trust[sid] = lvl
    this.opts.store.save({ records, trust })
  }

  getLevel(sessionId: string, terminalId: string): AuthLevel {
    return this.records.get(key(sessionId, terminalId)) ?? 'none'
  }
  getTrust(sessionId: string): TrustLevel { return this.trust.get(sessionId) ?? 'autonomous' }
  setTrust(sessionId: string, level: TrustLevel): void { this.trust.set(sessionId, level); this.persist() }

  grant(sessionId: string, terminalId: string, level: AuthLevel): void {
    const cur = this.getLevel(sessionId, terminalId)
    const next = RANK[level] >= RANK[cur] ? level : cur   // 不降级
    this.records.set(key(sessionId, terminalId), next)
    this.persist()
  }
  revoke(sessionId: string, terminalId: string): void {
    this.records.delete(key(sessionId, terminalId)); this.persist()
  }
  // 清除某会话的全部授权和信任档（删会话时调用）。
  revokeSession(sessionId: string): void {
    for (const k of [...this.records.keys()]) if (k.split(' ')[0] === sessionId) this.records.delete(k)
    this.trust.delete(sessionId)
    for (const k of [...this.sudo.keys()]) if (k.split(' ')[0] === sessionId) this.sudo.delete(k)
    this.persist()
  }

  // ── 限时提权（授权卡「本主机 N 分钟内允许提权」）：期间该主机需要 root 的命令免卡（判定在主进程，见 safetyIpc.ts）──
  grantSudo(sessionId: string, hostKey: string, minutes: number): number {
    const until = this.now() + Math.max(1, Math.min(24 * 60, Math.round(minutes))) * 60_000
    this.sudo.set(key(sessionId, hostKey), until)
    return until
  }
  /** 还在期内返回到期时间；过期的顺手清掉（= 到期自动收回） */
  sudoUntil(sessionId: string, hostKey: string): number | undefined {
    const k = key(sessionId, hostKey)
    const until = this.sudo.get(k)
    if (until === undefined) return undefined
    if (until > this.now()) return until
    this.sudo.delete(k)
    return undefined
  }
  listSudo(sessionId: string): { hostKey: string; until: number }[] {
    const out: { hostKey: string; until: number }[] = []
    for (const k of [...this.sudo.keys()]) {
      const [sid, hostKey] = k.split(' ')
      const until = sid === sessionId ? this.sudoUntil(sid, hostKey) : undefined
      if (until !== undefined) out.push({ hostKey, until })
    }
    return out
  }
  revokeSudo(sessionId: string, hostKey: string): boolean { return this.sudo.delete(key(sessionId, hostKey)) }
  listForSession(sessionId: string): { terminalId: string; level: AuthLevel }[] {
    const out: { terminalId: string; level: AuthLevel }[] = []
    for (const [k, level] of this.records) {
      const [sid, terminalId] = k.split(' ')
      if (sid === sessionId) out.push({ terminalId, level })
    }
    return out
  }

  // 决策链（设计文档 §4.3）。纯函数，无 IO，原子。
  // confirmDangerous=false 时关掉「危险命令逐次确认」闸门（系统设置项）：只认 write 授权。
  // prod=true（主机标为生产）：信任档至少按 confirm 算（每条写入都问），危险命令无视开关一律确认。
  decide(sessionId: string, terminalId: string, needed: 'read' | 'write', command?: string, confirmDangerous = true, prod = false): AuthDecision {
    const cur = this.getLevel(sessionId, terminalId)
    const t = this.getTrust(sessionId)
    const trust: TrustLevel = prod && t === 'autonomous' ? 'confirm' : t
    if (prod) confirmDangerous = true
    const risk = command ? dangerCheck(command) : 'safe'

    if (needed === 'write' && trust === 'readonly') {
      return { kind: 'deny', reason: 'readonly: write not allowed' }
    }
    if (trust === 'readonly' && needed === 'read' && RANK[cur] < RANK.read) {
      return { kind: 'prompt', reason: 'first_access', risk }
    }
    if (RANK[cur] >= RANK[needed]) {
      if (needed === 'write' && risk === 'dangerous' && confirmDangerous) {
        return { kind: 'prompt', reason: 'dangerous_command', risk: 'dangerous' }   // 安全闸
      }
      // 确认档：即便已授权，每条 write 仍逐命令确认（read 安全不问）。这是 confirm 与 autonomous 的差异。
      if (needed === 'write' && trust === 'confirm') {
        return { kind: 'prompt', reason: 'elevation', risk }
      }
      return { kind: 'allow' }
    }
    return { kind: 'prompt', reason: cur === 'none' ? 'first_access' : 'elevation', risk }
  }
}
