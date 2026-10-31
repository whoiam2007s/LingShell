// 自然语言看门狗：用户用一句话写条件 → 模型生成只读检查脚本 → 后台按间隔在目标主机上跑（独立 exec channel，不进交互终端）。
// 脚本约定：输出一行人类可读的当前值；退出码 0 = 正常、1 = 触发、其他 = 检查失败。
// 连续触发 threshold 次才报警；报警后到恢复正常前不重复报警 / 开会话。纯逻辑都在这里，调度见 desktop/main/ops/watchdog.ts
import type { HostSummary, TermOs } from '../protocol/index.js'
import type { BatchExecResult } from './batchExec.js'
import { tr } from '../i18n/i18n.js'

export const WATCHDOG_INTERVALS = [1, 5, 15, 60] as const      // 检查间隔（分钟）
export const WATCHDOG_HISTORY = 20                              // 每个看门狗保留的触发 / 恢复记录
export const WATCHDOG_MAX_THRESHOLD = 10

export interface Watchdog {
  id: string
  name: string
  condition: string          // 用户写的自然语言条件
  script: string             // 只读检查脚本（保存前过只读校验）
  explain?: string           // 模型给的一句说明
  targets: string[]          // 'local' | 已保存主机 id
  groups?: string[]          // 主机分组：运行时展开成组内全部主机
  intervalMin: number        // 1 / 5 / 15 / 60
  threshold: number          // 连续触发几次才报警（默认 1）
  autoSession: boolean       // 触发时自动开 AI 排查会话（默认开）
  enabled: boolean
  createdAt: string
}
export type WatchdogInput = Omit<Watchdog, 'id' | 'createdAt'> & { id?: string }

// unknown = 还没检查过；pending = 触发了但还没到连续次数；firing = 报警中；error = 检查失败（命令错 / 连不上 / 超时）
export type WatchdogStatus = 'unknown' | 'ok' | 'pending' | 'firing' | 'error'
export interface WatchdogHostState {
  status: WatchdogStatus
  value?: string             // 最近一次输出的当前值（失败时是错误原因）
  at?: string                // 最近检查时间
  streak: number             // 连续触发次数
  alerted: boolean           // 已报警、尚未恢复（期间不重复报警 / 开会话）
  sessionId?: string         // 本轮报警自动开的排查会话
}
export interface WatchdogEvent { at: string; hostKey: string; kind: 'fire' | 'recover'; value?: string; sessionId?: string }
export interface WatchdogState { id: string; hosts: Record<string, WatchdogHostState>; history: WatchdogEvent[] }

export type CheckOutcome = { kind: 'ok' | 'trigger' | 'error'; value: string }

// eslint-disable-next-line no-control-regex -- 剥 ANSI 必须匹配 ESC 控制字符
const ANSI = /\x1b\[[0-9;?]*[@-~]/g

/** 一次检查结果 → 正常 / 触发 / 失败 + 当前值（取输出最后一个非空行，截 200 字） */
export function parseCheckOutput(r: Pick<BatchExecResult, 'status' | 'exitCode' | 'output' | 'error'>): CheckOutcome {
  const line = (r.output ?? '').replace(ANSI, '').replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean).pop()?.slice(0, 200) ?? ''
  if (r.status === 'conn_error') return { kind: 'error', value: r.error ? tr('连接失败：{err}', { err: r.error }) : tr('连接失败') }
  if (r.status === 'timeout' || r.status === 'canceled') return { kind: 'error', value: tr('检查超时') }
  if (r.exitCode === 0) return { kind: 'ok', value: line }
  if (r.exitCode === 1) return { kind: 'trigger', value: line }
  return { kind: 'error', value: tr('检查失败（退出码 {code}）', { code: r.exitCode ?? tr('wd|无') }) + (line ? tr('sep|：') + line : '') }
}

/** 状态机：一次检查结果推进一台主机的状态；event = 这次要发的通知（fire = 开始报警，recover = 恢复正常） */
export function stepWatchdog(prev: WatchdogHostState | undefined, o: CheckOutcome, threshold: number, at: string): { next: WatchdogHostState; event?: 'fire' | 'recover' } {
  const base: WatchdogHostState = prev ?? { status: 'unknown', streak: 0, alerted: false }
  if (o.kind === 'error') return { next: { ...base, status: 'error', value: o.value, at } }   // 失败不打断连续计数，也不算恢复
  if (o.kind === 'ok') return { next: { status: 'ok', value: o.value, at, streak: 0, alerted: false }, ...(base.alerted ? { event: 'recover' as const } : {}) }
  const streak = base.streak + 1
  const n = Math.min(WATCHDOG_MAX_THRESHOLD, Math.max(1, Math.floor(threshold) || 1))
  if (streak < n) return { next: { ...base, status: 'pending', value: o.value, at, streak } }
  return { next: { ...base, status: 'firing', value: o.value, at, streak, alerted: true }, ...(base.alerted ? {} : { event: 'fire' as const }) }
}

/** 触发 / 恢复记录：新在前，保留 WATCHDOG_HISTORY 条 */
export function pushHistory(history: WatchdogEvent[], e: WatchdogEvent): WatchdogEvent[] {
  return [e, ...history].slice(0, WATCHDOG_HISTORY)
}

/** 目标主机 + 分组展开（去重；已删除的主机去掉） */
export function resolveWatchdogTargets(w: Pick<Watchdog, 'targets' | 'groups'>, hosts: Pick<HostSummary, 'id' | 'group'>[]): string[] {
  const ids = new Set(hosts.map((h) => h.id))
  const out = w.targets.filter((t) => t === 'local' || ids.has(t))
  for (const g of w.groups ?? []) for (const h of hosts) if (h.group === g) out.push(h.id)
  return [...new Set(out)]
}

/** 保存前的字段校验（只读校验在主进程做）。返回错误文案 */
export function checkWatchdogInput(w: WatchdogInput): string | undefined {
  if (!w.name.trim()) return tr('名称不能为空')
  if (!w.condition.trim()) return tr('条件不能为空')
  if (!w.script.trim()) return tr('请先生成或填写检查脚本')
  if (!w.targets.length && !w.groups?.length) return tr('至少选一台主机或一个分组')
  if (!(WATCHDOG_INTERVALS as readonly number[]).includes(w.intervalMin)) return tr('检查间隔只能是 1 / 5 / 15 / 60 分钟')
  if (!(w.threshold >= 1 && w.threshold <= WATCHDOG_MAX_THRESHOLD)) return tr('连续触发次数需在 1–{max}', { max: WATCHDOG_MAX_THRESHOLD })
  return undefined
}

// ── 生成检查脚本：复用「自然语言写命令」的一次性模型调用 ──
const OS_TEXT: Record<TermOs, string> = { linux: 'Linux（bash / sh）', macos: 'macOS（BSD 工具）', windows: 'Windows · Git Bash', unknown: 'Linux（bash / sh）' }   // i18n-ignore 发给模型的提示词

export function buildWatchdogPrompt(r: { condition: string; os?: TermOs }): { system: string; user: string } {
  const system = [
    '你把用户用自然语言描述的监控条件写成一个只读的 shell 检查脚本，由监控程序定时在目标主机上执行。',   // i18n-ignore 发给模型的提示词
    `目标环境：${OS_TEXT[r.os ?? 'unknown']}。`,   // i18n-ignore 发给模型的提示词
    '约定：',   // i18n-ignore 发给模型的提示词
    '1. 脚本最后输出一行人类可读的当前值（如「5xx 次数：12」「/data 使用率 93%」「mysqld 未运行」）。',   // i18n-ignore 发给模型的提示词
    '2. 退出码：0 = 正常；1 = 条件成立（需要报警）；其他 = 检查本身失败（命令不存在、文件读不到等）。',   // i18n-ignore 发给模型的提示词
    '3. 必须只读：不修改任何文件或系统状态；不用 sudo、eval、sh -c、awk、sed、xargs、后台 &、heredoc、写文件重定向（只允许 >/dev/null 与 2>&1）。',   // i18n-ignore 发给模型的提示词
    '4. 只用这些命令：cat head tail grep wc cut tr sort uniq df du free uptime ps pgrep pidof ss netstat ls stat test date echo printf find journalctl systemctl（只读子命令）curl（只看状态，不下载不提交）；'   // i18n-ignore 发给模型的提示词
      + '可用 if/then/else/fi、[ ]、&&、||、管道、变量赋值、$(...)、$((...))、exit。',   // i18n-ignore 发给模型的提示词
    '5. 简短（一般不超过 10 行），不要交互输入，不要注释。',   // i18n-ignore 发给模型的提示词
    '输出格式（严格遵守）：第一行「说明：<一句中文，说明检查什么、何时触发>」，接着一个 ```sh 代码块放脚本，不要其他内容。',   // i18n-ignore 发给模型的提示词
    '条件无法用只读脚本检查时，只输出一行以 # 开头的原因。',   // i18n-ignore 发给模型的提示词
  ].join('\n')
  return { system, user: `监控条件：${r.condition.trim()}` }   // i18n-ignore 发给模型的提示词
}

/** 模型输出 → 脚本 + 说明。去 <think>；取第一个代码块；开头是 # 且没有代码块 = 模型拒绝 */
export function parseWatchdogGen(raw: string): { script: string; explain: string } | { error: string } {
  const s = raw.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '').replace(/\r/g, '').trim()
  const fence = /```[^\n]*\n([\s\S]*?)(```|$)/.exec(s)
  if (!fence) {
    const first = s.split('\n').find((l) => l.trim())?.trim() ?? ''
    return { error: first.startsWith('#') ? first.replace(/^#+\s*/, '') || tr('模型无法生成脚本') : tr('模型没有给出脚本，请换个说法再试') }
  }
  const script = fence[1].replace(/^#!.*\n/, '').trim()
  if (!script) return { error: tr('模型给出的脚本为空') }
  const outside = (s.slice(0, fence.index) + '\n' + s.slice(fence.index + fence[0].length)).split('\n').map((l) => l.trim()).filter(Boolean)
  const line = outside.find((l) => /^说明\s*[:：]/.test(l)) ?? outside[0] ?? ''
  return { script, explain: line.replace(/^说明\s*[:：]\s*/, '').slice(0, 200) }
}

/** 自动排查会话的第一条消息 */
export function watchdogSessionPrompt(w: Pick<Watchdog, 'name' | 'condition' | 'script'>, host: { key: string; label: string }, value: string): string {
  return [
    `看门狗『${w.name}』在 ${host.label} 触发：当前值 ${value || '（无输出）'}，请排查原因。`,   // i18n-ignore 发给 AI 的话
    '',
    `监控条件：${w.condition}`,   // i18n-ignore 发给 AI 的话
    '检查脚本：',   // i18n-ignore 发给 AI 的话
    '```sh', w.script, '```',
    host.key === 'local' ? '主机是本机，用本地终端排查。' : `该主机已保存（主机 id：${host.key}），可用 create_terminal（type=ssh）打开它的终端。`,   // i18n-ignore 发给 AI 的话
    '先只读排查、给出结论与建议；需要改动时先说明影响并给出回滚方案。',   // i18n-ignore 发给 AI 的话
  ].join('\n')
}
