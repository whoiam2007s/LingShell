// 应用锁（主密码）：锁定期间主进程拒绝敏感 IPC / 本地 HTTP 接口，渲染层显示全屏锁屏。
// 这是访问屏障不是加密：凭据本身由系统 safeStorage 加密，与锁无关。

export interface LockStatus {
  enabled: boolean       // 已设主密码（lock.json 存在）
  locked: boolean
  failures: number       // 连续输错次数（解锁成功清零）
  retryAfterMs: number   // 还要等多久才能再试（0 = 可以试）
  lockFile: string       // 忘记密码时要删的文件（不是机密）
  damaged?: boolean      // 文件存在但损坏 / 无法解析：锁定保持，密码无法验证
}

export type UnlockResult = { ok: true } | { ok: false; failures: number; retryAfterMs: number }

export const LOCK_MIN_PASSWORD = 6

// 第 n 次连续输错后要等多久：1s、2s、4s… 封顶 5 分钟（之前封顶 30s，6 位数字密码在本地可被长时间盯着试）
export function lockBackoffMs(failures: number): number {
  return failures <= 0 ? 0 : Math.min(1000 * 2 ** (failures - 1), 300_000)
}

import { tr } from '../i18n/i18n.js'

/** 新主密码的最低要求：长度之外挡掉纯数字（123456）和几乎无变化的串（aaaaaa） */
export function lockPasswordError(pw: string): string | undefined {
  if (typeof pw !== 'string' || pw.length < LOCK_MIN_PASSWORD) return tr('主密码至少 {n} 位', { n: LOCK_MIN_PASSWORD })
  if (/^\d+$/.test(pw)) return tr('主密码不能是纯数字（建议字母 + 数字 + 符号）')
  if (new Set(pw).size < 3) return tr('主密码太简单：请至少使用 3 种不同字符')
  return undefined
}

// 空闲自动锁：0 分钟 = 只在启动/手动/系统锁屏时锁
export function shouldIdleLock(s: { enabled: boolean; locked: boolean; idleMinutes: number; idleSec: number }): boolean {
  return s.enabled && !s.locked && s.idleMinutes > 0 && s.idleSec >= s.idleMinutes * 60
}
