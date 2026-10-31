// ── 终端辅助：自然语言写命令 + 单条命令的操作菜单 ─────────
// 纯函数，主进程（拼提示词 / 清洗模型输出）和界面（复制 / 存快速命令 / 加入手册）共用。
import { guessStepKind } from '../ops/runbook.js'
import type { RunbookInput } from '../ops/index.js'
import { newQuickId, type QuickCommand } from './quickCommands.js'
import type { TermOs } from '../protocol/index.js'
import { dangerCheck } from '../ai/danger.js'
import { tr } from '../i18n/i18n.js'

// ── 自然语言 → 一条命令 ───────────────────────────────
// 只发用户的描述 + 系统 / 目录 / 是否生产，不带任何终端内容
export interface NlCommandRequest { description: string; os?: TermOs; cwd?: string; prod?: boolean }

const OS_HINT: Record<TermOs, string> = {
  linux: 'Linux，bash',   // i18n-ignore 发给模型的提示词
  macos: 'macOS，bash/zsh（BSD 版命令行工具，如 sed -i \'\'、lsof，没有 GNU 专有参数）',   // i18n-ignore 发给模型的提示词
  windows: 'Windows 上的 Git Bash（bash 语法、MSYS 路径如 /c/Users；没有 free / ss / ip / systemctl / ps aux 这类 Linux 专有工具，'   // i18n-ignore 发给模型的提示词
    + '系统信息用 netstat -ano、tasklist、或 powershell.exe -NoProfile -Command \'...\' 单行）',   // i18n-ignore 发给模型的提示词
  unknown: '未知系统，按 POSIX bash 写，尽量用通用命令',   // i18n-ignore 发给模型的提示词
}

/** 一次性调用的系统提示词 + 用户消息 */
export function buildNlCommandPrompt(r: NlCommandRequest): { system: string; user: string } {
  const L = [
    '你把用户的自然语言描述转换成一条可直接在终端执行的 shell 命令。',   // i18n-ignore 发给模型的提示词
    `目标环境：${OS_HINT[r.os ?? 'unknown']}。`,   // i18n-ignore 发给模型的提示词
  ]
  if (r.cwd) L.push(`当前目录：${r.cwd}`)   // i18n-ignore 发给模型的提示词
  if (r.prod) L.push('这是生产环境：优先只读、影响最小的写法，不要加 -f / --force / -y 之类跳过确认的参数，除非用户明确要求。')   // i18n-ignore 发给模型的提示词
  L.push(
    '输出要求：',   // i18n-ignore 发给模型的提示词
    '- 只输出一行命令本身：不要解释、不要 markdown 代码块、不要行首的 $ 或提示符。',   // i18n-ignore 发给模型的提示词
    '- 需要多步时用 && 或 | 连成一行。',   // i18n-ignore 发给模型的提示词
    '- 不要用 sudo，除非用户明确要求。',   // i18n-ignore 发给模型的提示词
    '- 描述无法转成命令（不是终端操作 / 信息不够）时，只输出一行以 # 开头的简短中文说明。',   // i18n-ignore 发给模型的提示词
  )
  return { system: L.join('\n'), user: r.description.trim() }
}

// 控制字符（含 Tab：写进终端会触发补全）；换行另行处理
// eslint-disable-next-line no-control-regex
const CTRL = /[\x00-\x08\x09\x0b-\x1f\x7f-\x9f]/g
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)?|\x1b[@-_]/g

/** 模型输出 → 一条命令。去掉 <think>、``` 围栏、行首 $ / 反引号；取第一条非空行（行尾 \ 续行拼上）。
 *  开头是 # 的视为模型拒绝（返回 error = 它的说明） */
export function sanitizeNlCommand(raw: string): { command: string } | { error: string } {
  let s = raw.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '').replace(ANSI, '').replace(/\r/g, '')
  const fence = /```[^\n]*\n([\s\S]*?)(```|$)/.exec(s)
  if (fence) s = fence[1]
  const lines = s.split('\n').map((l) => l.trim().replace(/^(\$|>|PS>)\s+/, '').trim()).filter(Boolean)
  // 「可以用下面的命令：」这类引导语跳过
  while (lines.length > 1 && /[:：]$/.test(lines[0])) lines.shift()
  if (!lines.length) return { error: tr('模型没有给出命令') }
  let cmd = lines[0]
  for (let i = 1; /\\$/.test(cmd) && i < lines.length; i++) cmd = `${cmd.slice(0, -1).trimEnd()} ${lines[i]}`
  cmd = cmd.replace(/^`+|`+$/g, '').replace(CTRL, ' ').trim()
  if (cmd.startsWith('#')) { const why = cmd.replace(/^#+\s*/, ''); return { error: why ? tr('无法转换成命令：{why}', { why }) : tr('无法转换成命令') } }
  return cmd ? { command: cmd } : { error: tr('模型没有给出命令') }
}

/** 模型调用报错 → 界面文字 */
// 已是给人看的话的开头（中文原文 + 英文界面下这些报错的译文开头）
const FRIENDLY = ['模型', '无法', 'The model', 'Model ', 'Cannot ', 'Could not ']   // i18n-ignore 匹配报错开头
export function nlErrorText(msg: string): string {
  const m = msg.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '')
  if (/api_key_not_configured/.test(m)) return tr('未配置 API Key，请先在设置里填写')
  if (/aborted|timeout/i.test(m)) return tr('模型响应超时')
  // 已经是给人看的话（主进程 / parseNlCommand 抛的「模型… / 无法…」，可能已按当前语言翻译）就原样返回
  return FRIENDLY.some((p) => m.startsWith(p)) ? m : tr('模型调用失败：{msg}', { msg: m })
}

// ── 单条命令的操作 ────────────────────────────────────
export const COPY_OUTPUT_MAX = 200 * 1024

/** 复制输出：去 ANSI / 控制字符（保留换行），去尾部空白；超长留末尾（报错通常在最后） */
export function cleanOutput(text: string, max = COPY_OUTPUT_MAX): { text: string; truncated: boolean } {
  // eslint-disable-next-line no-control-regex
  const s =text.replace(ANSI, '').replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').replace(/\s+$/, '')
  return s.length > max ? { text: s.slice(-max), truncated: true } : { text: s, truncated: false }
}

/** 写回终端的单行命令（重新执行 / 自然语言结果）：只取首行、控制字符换空格（防夹带回车 / Tab 补全 / 转义序列） */
export function termSafeLine(cmd: string): string {
  return cmd.split(/\r?\n/)[0].replace(CTRL, ' ').trim()
}

/** 「存为快速命令」的预填：名称取命令前 20 字，发到当前终端、末尾回车 */
export function quickCommandFrom(command: string): QuickCommand {
  const c = command.trim()
  const label = c.length > 20 ? `${c.slice(0, 20)}…` : c
  return { id: newQuickId('qc'), label, command: c, appendEnter: true, target: 'active' }
}

/** 「加入运维手册」：追加到已有手册末尾，或 base 缺省时新建一份只含这一步的手册；类型按命令猜 */
export function appendRunbookStep(base: RunbookInput | undefined, command: string): RunbookInput {
  const c = command.trim()
  const step = { title: c.length > 40 ? `${c.slice(0, 40)}…` : c, command: c, kind: guessStepKind(c) }
  if (!base) return { name: '', description: '', params: [], steps: [step] }
  return { ...base, params: [...base.params], steps: [...base.steps, step] }
}

// ── 粘贴安全检查 ──────────────────────────────────────
// 往生产终端粘贴：只要带换行就会在粘贴时直接执行（逐行），先确认（不受开关影响）。
// 任何终端：含危险命令 / 隐藏字符先确认（系统设置「粘贴安全检查」，默认开）
// 隐藏 / 控制字符：C0（\t \r \n 除外，含 ESC）、DEL、C1、零宽、双向控制。网页复制陷阱常用它们藏命令
const HIDDEN_SRC = '[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f-\\x9f\\u200b-\\u200f\\u2060\\ufeff\\u202a-\\u202e\\u2066-\\u2069]'
const HIDDEN = new RegExp(HIDDEN_SRC, 'g'), HIDDEN_ONE = new RegExp(HIDDEN_SRC)
const HIDDEN_NAME: Record<string, string> = { '\x1b': 'ESC', '\x00': 'NUL', '\x7f': 'DEL' }

/** 隐藏字符换成可见占位（⟨ESC⟩、⟨U+200B⟩），确认框显示用 */
export const revealHidden = (s: string): string =>
  s.replace(HIDDEN, (c) => `⟨${HIDDEN_NAME[c] ?? `U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`}⟩`)
/** 去掉隐藏字符（「去除隐藏字符后粘贴」） */
export const stripHidden = (s: string): string => s.replace(HIDDEN, '')
export const hasHidden = (s: string): boolean => HIDDEN_ONE.test(s)

export interface PasteLine { text: string; dangerous: boolean; hidden: boolean }
/** 一行的标记（确认框里危险行标红、隐藏字符显示占位）；撰写栏确认框共用 */
export const pasteLine = (l: string): PasteLine => ({ text: l, dangerous: dangerCheck(stripHidden(l)) === 'dangerous', hidden: hasHidden(l) })
export interface PasteCheck {
  lines: PasteLine[]          // 非空行（确认框逐行显示）
  dangerous: number           // 危险命令行数
  hidden: boolean             // 含隐藏字符
  prodMulti: boolean          // 生产终端多行（原「粘贴到生产终端」规则）
}

/** 粘贴前检查：含危险命令 / 隐藏字符（safety 开时，任何终端）或生产终端多行 → 返回确认信息；否则 undefined。
 *  危险判定按去掉隐藏字符后的行算（零宽字符拆开的 r<U+200B>m -rf 照样认出来） */
export function pasteCheck(text: string, env?: string, safety = true): PasteCheck | undefined {
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim()).map(pasteLine)
  const dangerous = safety ? lines.filter((l) => l.dangerous).length : 0
  const hidden = safety && hasHidden(text)
  const prodMulti = env === 'prod' && /[\r\n]/.test(text)
  return dangerous || hidden || prodMulti ? { lines, dangerous, hidden, prodMulti } : undefined
}

/** 确认框标题：隐藏字符 > 危险命令 > 生产多行 */
export const pasteCheckTitle = (c: PasteCheck): string =>
  c.hidden ? tr('粘贴内容含隐藏字符') : c.dangerous ? tr('粘贴内容含危险命令') : tr('粘贴到生产终端')

// ── SSH 终端类型（$TERM）──────────────────────────────
export const DEFAULT_TERM_TYPE = 'xterm-256color'
export const TERM_TYPES = ['xterm-256color', 'xterm', 'xterm-color', 'vt100', 'screen-256color'] as const
/** 主机设置里的终端类型：只允许 [A-Za-z0-9._+-]（≤64 字）；不合法 / 空 / 等于默认 → undefined（不存） */
export function cleanTermType(v?: string): string | undefined {
  const s = (v ?? '').trim()
  return s && s.length <= 64 && /^[A-Za-z0-9._+-]+$/.test(s) && s !== DEFAULT_TERM_TYPE ? s : undefined
}

// ── 终端响铃（\a）────────────────────────────────────
export type BellMode = 'off' | 'badge' | 'notify'
export const BELL_NOTIFY_GAP_MS = 10_000
/** 响铃怎么提示：标签不可见 → 角标；窗口不在前台 → 系统通知（同终端 10 秒最多一次） */
export function bellAction(mode: BellMode | undefined, visible: boolean, focused: boolean, lastNotify: number, now: number): { badge: boolean; notify: boolean } {
  const m = mode ?? 'notify'
  if (m === 'off') return { badge: false, notify: false }
  return { badge: !visible, notify: m === 'notify' && !focused && now - lastNotify >= BELL_NOTIFY_GAP_MS }
}
