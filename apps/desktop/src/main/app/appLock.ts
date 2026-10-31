import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { IpcMain } from 'electron'
import { lockBackoffMs, lockPasswordError, tr, type LockStatus, type UnlockResult } from '@lingshell/shared'

// 应用锁：lock.json 只存 scrypt 哈希 + 盐 + 连续失败计数，绝不存密码。
// 失败计数落盘：重启应用不能绕过退避。忘记密码 = 删 lock.json（凭据由 safeStorage 加密，锁只是访问屏障）。

const N = 1 << 15, R = 8, P = 1, KEYLEN = 32
const MAXMEM = 64 * 1024 * 1024   // 128*N*R = 32MB，默认 maxmem 不够

interface LockFile { v: 1; salt: string; hash: string; N: number; r: number; p: number; failures?: number; lastFailAt?: number }

function scryptAsync(pw: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(pw, salt, KEYLEN, { N: n, r, p, maxmem: MAXMEM }, (e, k) => e ? reject(e) : resolve(k)))
}

export async function hashPassword(pw: string): Promise<LockFile> {
  const salt = randomBytes(16)
  const hash = await scryptAsync(pw, salt, N, R, P)
  return { v: 1, salt: salt.toString('base64'), hash: hash.toString('base64'), N, r: R, p: P }
}

export async function verifyPassword(pw: string, rec: Pick<LockFile, 'salt' | 'hash' | 'N' | 'r' | 'p'>): Promise<boolean> {
  const want = Buffer.from(rec.hash, 'base64')
  const got = await scryptAsync(pw, Buffer.from(rec.salt, 'base64'), rec.N, rec.r, rec.p)
  return got.length === want.length && timingSafeEqual(got, want)
}

export class AppLock {
  locked: boolean
  constructor(private file: string, private onChange: (locked: boolean) => void = () => {}, private now = () => Date.now()) {
    const s = this.load()
    this.locked = !!s.rec || s.damaged   // 设了主密码 → 启动即锁；文件损坏也锁住（不能静默失效）
  }

  // 每次读盘：运行中删掉 lock.json 也能生效（忘记密码的出路）。文件存在但解析 / 结构不对 → damaged，
  // 不能当成「没设密码」：那等于损坏一次就把访问屏障关掉，还清零失败计数
  private load(): { rec?: LockFile; damaged: boolean } {
    if (!existsSync(this.file)) return { damaged: false }
    try {
      const v = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<LockFile>
      if (!v || v.v !== 1 || typeof v.salt !== 'string' || typeof v.hash !== 'string'
        || !Number.isFinite(v.N) || !Number.isFinite(v.r) || !Number.isFinite(v.p)) return { damaged: true }
      return { rec: v as LockFile, damaged: false }
    } catch { return { damaged: true } }
  }
  // 原子写：先写临时文件再改名。直接 writeFileSync 在崩溃 / 磁盘满时可能留下截断的 lock.json，
  // 下次启动 read() 把它当不存在 → 应用锁静默失效、失败计数清零
  private write(rec: LockFile) {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(rec, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.file)
  }
  get enabled() { const s = this.load(); return !!s.rec || s.damaged }

  private retryAfter(rec: LockFile): number {
    const f = rec.failures ?? 0
    return f ? Math.max(0, (rec.lastFailAt ?? 0) + lockBackoffMs(f) - this.now()) : 0
  }

  status(): LockStatus {
    const { rec, damaged } = this.load()
    return {
      enabled: !!rec || damaged, locked: this.locked, failures: rec?.failures ?? 0,
      retryAfterMs: rec ? this.retryAfter(rec) : 0, lockFile: this.file, ...(damaged ? { damaged: true } : {}),
    }
  }

  private set(locked: boolean) { if (this.locked !== locked) { this.locked = locked; this.onChange(locked) } }
  lock(): boolean { if (!this.enabled || this.locked) return false; this.set(true); return true }

  // 串行校验：并发猜测不能在失败计数落盘前挤进同一个退避窗口
  private queue: Promise<unknown> = Promise.resolve()
  private check(pw: string): Promise<UnlockResult & { throttled?: boolean }> {
    const r = this.queue.then(() => this.checkNow(pw))
    this.queue = r.catch(() => {})
    return r
  }

  // 校验当前密码（解锁 / 改密 / 关闭共用退避）：退避期内直接拒，不算一次失败
  private async checkNow(pw: string): Promise<UnlockResult & { throttled?: boolean }> {
    const { rec, damaged } = this.load()
    // 损坏时不能放行（也不能当成「文件不存在 = 忘记密码的出路」），只能退出后手动删除
    if (damaged) throw new Error(`lock_damaged: ${tr('锁文件损坏或无法解析（{file}），无法验证主密码。请退出应用后删除该文件（会关闭应用锁），再重新打开', { file: this.file })}`)
    if (!rec) return { ok: true }
    const wait = this.retryAfter(rec)
    if (wait > 0) return { ok: false, failures: rec.failures ?? 0, retryAfterMs: wait, throttled: true }
    if (await verifyPassword(pw, rec)) {
      if (rec.failures) { delete rec.failures; delete rec.lastFailAt; this.write(rec) }
      return { ok: true }
    }
    rec.failures = (rec.failures ?? 0) + 1; rec.lastFailAt = this.now(); this.write(rec)
    return { ok: false, failures: rec.failures, retryAfterMs: lockBackoffMs(rec.failures) }
  }

  async unlock(pw: string): Promise<UnlockResult> {
    const r = await this.check(String(pw ?? ''))
    if (r.ok) { this.set(false); return { ok: true } }
    return { ok: false, failures: r.failures, retryAfterMs: r.retryAfterMs }
  }

  // 改密 / 关闭：当前密码不对就抛（同样计入失败、受退避限制）
  private async requireCurrent(pw?: string) {
    const r = await this.check(String(pw ?? ''))
    if (r.ok) return
    throw new Error(r.throttled ? tr('尝试过于频繁，请 {n} 秒后再试', { n: Math.ceil(r.retryAfterMs / 1000) }) : tr('当前密码错误（已连续错 {n} 次）', { n: String(r.failures) }))
  }

  async setPassword(next: string, current?: string): Promise<void> {
    const bad = lockPasswordError(next)
    if (bad) throw new Error(bad)
    if (this.enabled) await this.requireCurrent(current)
    this.write(await hashPassword(next))
  }

  async disable(current: string): Promise<void> {
    await this.requireCurrent(current)
    rmSync(this.file, { force: true })
    this.set(false)
  }
}

// 锁定期间放行的通道：锁本身、版本信息、终端尺寸同步（无害，免得隐藏布局变化时刷错）、窗口控制。其余一律拒（默认拒绝，
// 以后新增的 handler 自动受保护）
// dashboard:close 允许锁定时调用：界面收到上锁事件会关仪表盘，关闭请求不能被门禁拒绝（否则采样器一直开着）
const ALLOWED = new Set(['lock:status', 'lock:unlock', 'lock:lock', 'system:getUpdateStatus', 'terminal:resize', 'system:notify', 'dashboard:close'])
export const allowedWhileLocked = (channel: string) => ALLOWED.has(channel) || channel.startsWith('window:')

// 包一层 ipcMain.handle：之后注册的每个 handler 先过锁检查。必须在任何 handle 注册之前调用
export function installLockGate(ipc: Pick<IpcMain, 'handle'>, isLocked: () => boolean): void {
  const orig = ipc.handle.bind(ipc)
  ipc.handle = (channel, fn) => orig(channel, (e, ...args) => {
    if (isLocked() && !allowedWhileLocked(channel)) throw new Error(`locked: ${tr('应用已锁定，请先解锁')}`)
    return fn(e, ...args)
  })
}
