import {
  SYSTEMD_ACTION_TIMEOUT_MS, SYSTEMD_TIMEOUT_MS, isSvcAction, isSvcName, parseSystemd, splitSvcRc, svcActionError,
  systemdActionCommand, systemdAuditCommand, systemdDecision, systemdListCommand, systemdStatusCommand, systemdSupported,
  type SvcList, type TerminalInfo,
} from '@lingshell/shared'
import { tr } from '@lingshell/shared'
import type { ExecRead } from './processes.js'

// systemd 服务视图主进程侧（命令 / 解析见 shared/ops/systemd.ts）：全部走 SSH 独立 exec channel，不碰交互 shell。
// 启停等操作记执行记录（decision = systemd_<动作>，界面标「手动」），失败把 systemctl / sudo 的输出原样抛回去
export interface SystemdIpcDeps {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  terminal(id: string): TerminalInfo | undefined
  exec(id: string): ExecRead
  // 记执行记录（hostKey / 终端名 / 会话由 ipc.ts 补）
  audit(terminalId: string, entry: { command: string; decision: string; exitCode?: number }): void
}

export function registerSystemd(d: SystemdIpcDeps): void {
  const target = (id: unknown) => {
    const t = typeof id === 'string' ? d.terminal(id) : undefined
    if (!t) throw new Error('terminal_not_found')
    if (!systemdSupported(t.type, t.os)) throw new Error(tr('服务视图只支持 Linux 的 SSH 终端'))
    return t
  }
  const svcOf = (s: unknown) => { if (!isSvcName(s)) throw new Error(tr('非法的服务名')); return s }

  d.handle('systemd:list', async (_e, id): Promise<SvcList> => {
    const r = parseSystemd(await d.exec(target(id).id)(systemdListCommand(), SYSTEMD_TIMEOUT_MS))
    if (!r.noSystemd && !r.rows.length) throw new Error(tr('读不到服务列表：systemctl 没有输出'))
    return r
  })
  // status 的退出码不代表出错（服务没在跑时是 3），原文照给
  d.handle('systemd:status', async (_e, id, svc) => {
    const { rc, text } = splitSvcRc(await d.exec(target(id).id)(systemdStatusCommand(svcOf(svc)), SYSTEMD_TIMEOUT_MS))
    return text || tr('（systemctl status 没有输出，退出码 {rc}）', { rc: rc ?? tr('rc|未知') })
  })
  d.handle('systemd:action', async (_e, id, svc, action) => {
    const t = target(id), s = svcOf(svc)
    if (!isSvcAction(action)) throw new Error(tr('非法的服务操作'))
    let rc: number | undefined, text = ''
    try { ({ rc, text } = splitSvcRc(await d.exec(t.id)(systemdActionCommand(action, s), SYSTEMD_ACTION_TIMEOUT_MS))) }
    catch (e) { text = e instanceof Error ? e.message : String(e) }   // 超时 / 断线：照样记一笔（无退出码）
    d.audit(t.id, { command: systemdAuditCommand(action, s), decision: systemdDecision(action), exitCode: rc })
    if (rc !== 0) throw new Error(svcActionError(text, rc))
    return text
  })
}
