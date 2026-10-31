// 命令失败后的「让 AI 排查」横幅（参考 Warp Active AI）：出现条件与显示文字（纯逻辑，TerminalPane 用，可单测）

// 不算「失败」的退出码：130 = Ctrl+C 中断（SIGINT），148 = Ctrl+Z 挂起（SIGTSTP）——都是用户自己停的
const USER_STOP = new Set([130, 148])

export interface FailHintInput {
  exitCode?: number                    // 无退出码（别家 shell 的 133;D）不算失败
  command: string                      // 读出的命令行（可能为空）
  enabled: boolean                     // 设置 → 终端「命令失败时提示让 AI 排查」
  aiBusy: boolean                      // AI 接管中（终端锁定）：AI 执行的命令不提示
  dismissed: ReadonlySet<string>       // 用户按 × 关过的命令（同一终端内同一命令不再提示）
}

export function shouldOfferFix(o: FailHintInput): boolean {
  if (!o.enabled || o.aiBusy || o.exitCode === undefined || o.exitCode === 0 || USER_STOP.has(o.exitCode)) return false
  return !o.dismissed.has(dismissKey(o.command))
}

export const dismissKey = (command: string) => command.trim()

/** 横幅里显示的命令：多行取首行，超长截断 */
export function failCommandLabel(command: string, max = 60): string {
  const first = command.trim().split('\n')[0].trim()
  if (!first) return ''
  return first.length > max ? first.slice(0, max) + '…' : first
}
