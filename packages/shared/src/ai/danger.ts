import type { RiskLevel } from '../protocol/index.js'

// 提醒闸，非安全防线。命中即 dangerous。可被变量拼接/base64/别名绕过（已知局限）。
// ponytail: 启发式检测，挡手滑/常见误操作，不对抗恶意。真正的安全边界是会话↔终端授权（Phase 3）。
const DISK = String.raw`\/dev\/(sd[a-z]|nvme\d|vd[a-z]|xvd[a-z]|hd[a-z]|mmcblk\d)`   // 裸盘设备
const SHELL = String.raw`(sudo\s+(-\S+\s+)*)?(env\s+)?(sh|bash|zsh|python\d?|perl|ruby)\b`
const DANGEROUS: RegExp[] = [
  new RegExp(String.raw`\bdd\b.*\bof=${DISK}`, 'i'),            // dd 写裸盘（if/of 顺序不限）
  /\bmkfs\b/i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  new RegExp(String.raw`>\s*${DISK}`, 'i'),                     // 重定向覆盖裸盘
  /:\s*\(\s*\)\s*\{.*\|.*&.*\}/,                                // fork 炸弹 :(){ :|:& };:
  /\bgit\s+push\b.*(\s-[a-z]*f\b|--force)/i,                    // -f / --force / --force-with-lease
  new RegExp(String.raw`\b(curl|wget)\b.*\|\s*${SHELL}`, 'i'),  // 管道执行远程脚本（含 sudo/env 前缀、python 等）
  /\b(sh|bash|zsh)\b.*(<\(|\$\()\s*(curl|wget)\b/i,             // bash <(curl ..) / sh -c "$(curl ..)"
  /\bfind\b.*\s-delete\b/i,                                     // find 批量删除
]

// 只要递归就算危险：非交互 shell 里 rm -r 不带 -f 也会直接删整棵目录（只对写保护文件才询问）。
function isDangerousRm(cmd: string): boolean {
  if (!/\brm\b/i.test(cmd)) return false
  return /(?:^|\s)-[a-z]*r/i.test(cmd) || /--recursive\b/i.test(cmd)
}

// chmod 递归改权限：-R 与权限码可能分写。777 / a+rwx（开放）与 000（锁死）都危险。
function isDangerousChmod(cmd: string): boolean {
  const recursive = /-R\b/i.test(cmd) || /--recursive\b/i.test(cmd)
  return /\bchmod\b/i.test(cmd) && recursive && (/\b0?(777|000)\b/.test(cmd) || /\ba\+rwx\b/.test(cmd))
}

// chown -R 改根/系统路径属主
function isDangerousChown(cmd: string): boolean {
  if (!/\bchown\b/i.test(cmd)) return false
  const recursive = /-R\b/i.test(cmd) || /--recursive\b/i.test(cmd)
  return recursive && /\s\/(\s|$|etc|usr|bin|var|root)/i.test(cmd)
}

export function dangerCheck(command: string): RiskLevel {
  if (isDangerousRm(command) || isDangerousChmod(command) || isDangerousChown(command)) return 'dangerous'
  return DANGEROUS.some((re) => re.test(command)) ? 'dangerous' : 'safe'
}
