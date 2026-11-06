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
  /\b(sh|bash|zsh)\b.*((<\(|\$\(\s*(curl|wget)\b))/i,          // bash <(curl ..) / sh -c "$(curl ..)"
  /\bfind\b.*\s-delete\b/i,                                     // find 批量删除
]

// 只要递归就算危险：非交互 shell 里 rm -r 不带 -f 也会直接删整棵目录（只对写保护文件才询问）。
function isDangerousRm(cmd: string): boolean {
  // 只看命令位置上的 rm（前面是行首或 ; & | ( ` 之类），避免把 "echo rm -rf" 也算上
  const re = /(?:^|[;&|(`\n]\s*)(?:sudo\s+(-\S+\s+)*)?rm\b([^;&|\n]*)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(cmd))) {
    const flags = m[2] ?? ''
    if (/(^|\s)-[a-z]*[rR]/.test(flags)) return true     // -r / -R / -rf / -fr
    if (/--recursive\b/.test(flags)) return true
  }
  return false
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

// ── 删除检测（执行模式用：删除在任何模式下都要用户确认）──────────────────────
/**
 * 这条命令是不是「真删除」。
 *
 * 只认确定性删除：rm / rmdir / del / erase / Remove-Item / unlink。
 * **不**把 mv 覆盖、重定向截断、git reset --hard 算进来 —— 那些是「丢内容」不是「删文件」，
 * 扩大范围会让确认弹窗多到用户麻木（越麻木越危险）。
 *
 * 与 dangerCheck 的区别：dangerCheck 是「危险」提醒（rm -rf / mkfs），这里只要删文件就算，
 * 哪怕 `rm a.txt` 这种不危险的。
 */
const DELETE_RES: RegExp[] = [
  /\brm\b/i,               // rm / rm -rf（含 cd x && rm、换行后、xargs rm）
  /\brmdir\b/i,
  /\bunlink\b/i,
  /\bdel\b/i,              // Windows cmd
  /\berase\b/i,            // Windows cmd
  /\bRemove-Item\b/i,      // PowerShell
  /\bClear-RecycleBin\b/i,
  /\bshred\b/i,
// 宽松匹配的代价：'echo "rm -rf 很危险"' 这类纯文本也会被算成删除，多弹一次确认。
// 这是刻意的取舍 —— 误报只是多问一句，漏报会静默删掉文件。
]

export function isDestructiveCommand(command: string): boolean {
  const cmd = command ?? ''
  if (!cmd.trim()) return false
  return DELETE_RES.some((re) => re.test(cmd))
}

/** 文件工具侧的删除判定（工具名 + 参数） */
export function isDestructiveTool(tool: string, args?: Record<string, unknown>): boolean {
  if (tool === 'delete_file' || tool === 'remove_file' || tool === 'fs_delete') return true
  // 删除计划：dryRun=false 才是真删（预览不删东西）
  if (tool === 'delete_plan') return args?.dryRun !== true
  return false
}
