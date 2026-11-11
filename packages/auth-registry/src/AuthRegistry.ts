import type { AuthLevel, TrustLevel, AuthDecision, AuthRecord, ExecMode } from '@lingshell/shared'
import { DEFAULT_EXEC_MODE, modeOfTrust, trustOfMode } from '@lingshell/shared'
import { dangerCheck } from './danger.js'

export interface AuthState {
  records: AuthRecord[]
  /**
   * 四档执行模式：sessionId → 模式。0.1.6 起这是**唯一**的信任控制入口，会落盘。
   */
  execMode?: Record<string, ExecMode>
  /**
   * 旧的「会话信任档」快照。只在加载 0.1.5 及更早的 auth.json 时用来迁移成 execMode；
   * 新的写入只放派生快照，方便回退到旧版本时仍能读。
   */
  trust?: Record<string, TrustLevel>
}
export interface AuthStore {
  load(): AuthState
  save(state: AuthState): void
}

const RANK: Record<AuthLevel, number> = { none: 0, read: 1, write: 2 }
function key(s: string, t: string) { return `${s} ${t}` }

export class AuthRegistry {
  private records = new Map<string, AuthLevel>()      // key(session,term) → level
  private modes = new Map<string, ExecMode>()         // session → 四档执行模式（持久化）
  // 内部只读标记：定时巡检等无人值守流程用，不落盘、不对用户暴露（四档里没有「只读」这一项）
  private readOnlySessions = new Set<string>()
  // 限时提权：key(session,host) → 到期时间 ms。只在内存（重启即失效），不落 auth.json
  private sudo = new Map<string, number>()
  private now: () => number
  constructor(private opts: { store: AuthStore; now?: () => number }) {
    this.now = opts.now ?? Date.now
    const st = opts.store.load()
    for (const r of st.records) this.records.set(key(r.sessionId, r.terminalId), r.level)
    // 迁移：旧文件只有 trust，没有 execMode
    for (const [sid, mode] of Object.entries(st.execMode ?? {})) this.modes.set(sid, mode)
    for (const [sid, legacy] of Object.entries(st.trust ?? {})) {
      if (!this.modes.has(sid)) this.modes.set(sid, modeOfTrust(legacy))
    }
  }

  private persist() {
    const records: AuthRecord[] = []
    for (const [k, level] of this.records) {
      const [sessionId, terminalId] = k.split(' ')
      records.push({ sessionId, terminalId, level })
    }
    const execMode: Record<string, ExecMode> = {}
    const trust: Record<string, TrustLevel> = {}
    for (const [sid, mode] of this.modes) {
      execMode[sid] = mode
      trust[sid] = trustOfMode(mode)      // 派生快照：仅为回退到 0.1.5 时能读
    }
    this.opts.store.save({ records, execMode, trust })
  }

  getLevel(sessionId: string, terminalId: string): AuthLevel {
    return this.records.get(key(sessionId, terminalId)) ?? 'none'
  }

  // ── 四档执行模式（唯一信任控制入口，与聊天顶部模式按钮同一个值）──
  getExecMode(sessionId: string): ExecMode { return this.modes.get(sessionId) ?? DEFAULT_EXEC_MODE }
  setExecMode(sessionId: string, mode: ExecMode): void {
    this.modes.set(sessionId, mode)
    this.persist()
  }

  /**
   * 底层信任档：由执行模式派生，不再允许用户单独设置。
   * 只有内部只读标记（定时巡检）会覆盖它 —— 那种会话不该因为四档而被放宽。
   */
  getTrust(sessionId: string): TrustLevel {
    if (this.readOnlySessions.has(sessionId)) return 'readonly'
    return trustOfMode(this.getExecMode(sessionId))
  }
  /** 内部用：把某个会话锁成只读（定时巡检）。不落盘、不暴露给 UI。 */
  markReadonly(sessionId: string): void { this.readOnlySessions.add(sessionId) }
  clearReadonly(sessionId: string): void { this.readOnlySessions.delete(sessionId) }

  grant(sessionId: string, terminalId: string, level: AuthLevel): void {
    const cur = this.getLevel(sessionId, terminalId)
    const next = RANK[level] >= RANK[cur] ? level : cur   // 不降级
    this.records.set(key(sessionId, terminalId), next)
    this.persist()
  }
  revoke(sessionId: string, terminalId: string): void {
    this.records.delete(key(sessionId, terminalId)); this.persist()
  }
  // 清除某会话的全部授权和执行模式（删会话时调用）。
  revokeSession(sessionId: string): void {
    for (const k of [...this.records.keys()]) if (k.split(' ')[0] === sessionId) this.records.delete(k)
    this.modes.delete(sessionId)
    this.readOnlySessions.delete(sessionId)
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
  // 信任档由执行模式派生：trust === 'confirm' 时每条 write 都问（= 逐条确认档），
  // trust === 'autonomous' 时按已批授权放行（= 确认一次 / 信任档，放宽范围见 shared/ai/execMode.ts）。
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
      // 逐条确认档：即便已授权，每条 write 仍逐命令确认（read 安全不问）。这是 confirm 与 auto/trust 的差异。
      if (needed === 'write' && trust === 'confirm') {
        // mode_confirm ≠ 权限不够：该主机早就授了写入，只是这个档要求每条再点一次。
        // UI 据此把文案从「请求将权限提升到写入」换成「已授权 · 本条需确认」。
        return { kind: 'prompt', reason: 'mode_confirm', risk }
      }
      return { kind: 'allow' }
    }
    return { kind: 'prompt', reason: cur === 'none' ? 'first_access' : 'elevation', risk }
  }
}
