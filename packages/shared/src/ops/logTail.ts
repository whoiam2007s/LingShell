// 日志实时查看（tail -F / journalctl -f）：来源校验 + 服务器命令拼装。主进程 logTail.ts 与界面共用
import { shq } from '../files/explorer.js'
import { isK8sContext, isK8sName, k8sLogTailMain } from './k8s.js'
import type { TermOs, TerminalType } from '../protocol/index.js'
import { tr } from '../i18n/i18n.js'

// k8s：Kubernetes 视图里的 Pod 日志（kubectl logs -f；previous = 上一个容器，不跟踪）
export type K8sLogSource = { kind: 'k8s'; context?: string; namespace: string; pod: string; container?: string; previous?: boolean }
export type LogSource = { kind: 'file'; path: string } | { kind: 'journal'; unit?: string } | K8sLogSource
// 一次轮询取走的新行；dropped = 主进程缓冲超上限丢掉的行数；ended = 通道已结束（error 有值 = 异常结束）
export interface LogPoll { lines: string[]; dropped: number; ended?: { error?: string } }

export const LOG_TAIL_INITIAL = 500
export const LOG_COMMON_PATHS = [
  '/var/log/syslog', '/var/log/messages', '/var/log/nginx/access.log', '/var/log/nginx/error.log',
]
const UNIT_RE = /^[\w@.:\\-]{1,256}$/

export const logSupported = (type: TerminalType, os?: TermOs): boolean => type === 'ssh' && os !== 'windows'

/** 校验渲染层传来的来源（当不可信）：路径非空、无换行/空字符；单元名只允许 systemd 单元字符 */
export function parseLogSource(v: unknown): LogSource {
  const o = (v ?? {}) as { kind?: unknown; path?: unknown; unit?: unknown }
  if (o.kind === 'file') {
    if (typeof o.path !== 'string' || !o.path.trim() || o.path.length > 4096 || /[\0\r\n]/.test(o.path)) throw new Error(tr('非法的日志路径'))
    return { kind: 'file', path: o.path.trim() }
  }
  if (o.kind === 'journal') {
    const unit = typeof o.unit === 'string' ? o.unit.trim() : ''
    if (unit && !UNIT_RE.test(unit)) throw new Error(tr('非法的单元名'))
    return unit ? { kind: 'journal', unit } : { kind: 'journal' }
  }
  if (o.kind === 'k8s') {
    const k = v as Record<string, unknown>
    if (!isK8sName(k.namespace) || !isK8sName(k.pod) || (k.container !== undefined && !isK8sName(k.container)) || (k.context !== undefined && !isK8sContext(k.context))) throw new Error(tr('非法的 Pod 日志来源'))
    return { kind: 'k8s', namespace: k.namespace, pod: k.pod, ...(k.container ? { container: k.container as string } : {}), ...(k.context ? { context: k.context as string } : {}), ...(k.previous === true ? { previous: true } : {}) }
  }
  throw new Error(tr('非法的日志来源'))
}

export const logSourceLabel = (s: LogSource): string =>
  s.kind === 'file' ? s.path
    : s.kind === 'k8s' ? `kubectl logs ${s.pod}${s.container ? ` -c ${s.container}` : ''} -n ${s.namespace}${s.previous ? ' --previous' : ''}`
      : `journalctl${s.unit ? ` -u ${s.unit}` : ''}`

/**
 * 服务器命令。要点：通道关闭后不能留下远端 tail 进程。
 * exec 不分配 pty，channel 关闭时 sshd 只关管道，tail 要等下次写入才因 SIGPIPE 退出（日志安静时会一直挂着）。
 * 所以：shell 先把通道的 stdin 存到 fd3，后台起一个 cat 读它——客户端关通道 → stdin EOF → cat 返回 → kill $$；
 * 再 exec 成 tail 本身（$$ 即 tail 的 pid）。tail 自己退出（命令不存在等）时通道照常结束。
 * 外层固定用 sh -c，不依赖用户登录 shell 是 bash 还是 fish/csh。
 */
export function logTailCommand(s: LogSource): string {
  const main = s.kind === 'file'
    ? `tail -n ${LOG_TAIL_INITIAL} -F -- ${shq(s.path)}`
    : s.kind === 'k8s' ? k8sLogTailMain(s)
    : `journalctl -f -n ${LOG_TAIL_INITIAL} --no-pager${s.unit ? ` -u ${shq(s.unit)}` : ''}`
  const script = `exec 3<&0; (cat <&3 >/dev/null 2>&1; kill $$ 2>/dev/null) >/dev/null 2>&1 & exec ${main} 2>&1 3<&-`
  return `sh -c ${shq(script)}`
}
