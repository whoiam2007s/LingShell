import {
  CRON_DECISION_PREFIX, CRON_OP_LABEL, CRON_TIMEOUT_MS, FIREWALL_TIMEOUT_MS, TOPOLOGY_TIMEOUT_MS,
  buildCronPrompt, cronAppend, cronListCommand, cronReadCommand, cronRemove, cronToggle, cronWriteCommand, deriveTopology, firewallListCommand,
  parseCronGen, parseCronList, parseCronRead, parseCronWrite, parseFirewall, portsSupported, topologyCommand,
  type CronGen, type CronList, type CronOp, type FwList, type TerminalInfo, type Topology,
} from '@lingshell/shared'
import { tr, tk } from '@lingshell/shared'
import type { ExecRead } from './processes.js'
import { backupName } from '../files/index.js'

// 运维视图（定时任务 / 防火墙 / 服务拓扑）主进程侧：全部走 SSH 独立 exec channel，不碰交互 shell。
// 防火墙、拓扑只读；定时任务只改当前用户自己的 crontab：先重读确认没被别处改过 → 备份原 crontab 到 ~/.lingshell/backups → 整体写回，记执行记录
export interface OpsViewsDeps {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  terminal(id: string): TerminalInfo | undefined
  exec(id: string): ExecRead
  audit(terminalId: string, entry: { command: string; decision: string; exitCode?: number }): void
  complete(system: string, user: string, signal: AbortSignal): Promise<string>
}

const MAX_CMD = 2000
const MAX_RAW = 100_000   // crontab 行原文：删除 / 停用时要和远端行逐字比对，长命令（>2000）也得能删

export function registerOpsViews(d: OpsViewsDeps): void {
  // what 传 tk() 标过的视图名（显示时翻译）
  const target = (id: unknown, what: string) => {
    const t = typeof id === 'string' ? d.terminal(id) : undefined
    if (!t) throw new Error('terminal_not_found')
    if (!portsSupported(t.type, t.os)) throw new Error(tr('{what}只支持 Linux 的 SSH 终端', { what: tr(what) }))
    return t
  }

  d.handle('cron:list', async (_e, id): Promise<CronList> => {
    const out = await d.exec(target(id, tk('定时任务')).id)(cronListCommand(), CRON_TIMEOUT_MS)
    if (!out.includes('@@me:')) throw new Error(tr('读不到定时任务：远端命令没有输出'))
    return parseCronList(out)
  })

  d.handle('cron:generate', async (_e, id, description): Promise<CronGen> => {
    const t = target(id, tk('定时任务'))
    const desc = String(description ?? '').trim().slice(0, 500)
    if (!desc) throw new Error(tr('请先写下想定时做什么'))
    const p = buildCronPrompt({ description: desc, os: t.os, prod: t.env === 'prod' })
    const r = parseCronGen(await d.complete(p.system, p.user, AbortSignal.timeout(60_000)))
    if ('error' in r) throw new Error(r.error)
    return r
  })

  // 写：读当前 → edit 得到新内容 → 备份 + 写回；成败都记一笔
  const write = async (id: unknown, op: CronOp, describe: string, edit: (cur: string) => string) => {
    const t = target(id, tk('定时任务'))
    const exec = d.exec(t.id)
    const next = edit(parseCronRead(await exec(cronReadCommand(), CRON_TIMEOUT_MS)))   // 原文对不上会在这里抛，不写
    let r: ReturnType<typeof parseCronWrite>
    try { r = parseCronWrite(await exec(cronWriteCommand(next, backupName('crontab')), CRON_TIMEOUT_MS)) }
    catch (e) { r = { text: e instanceof Error ? e.message : String(e) } }
    // 执行记录原文（存盘），不翻译
    // i18n-ignore-next
    d.audit(t.id, { command: `crontab ${CRON_OP_LABEL[op]}：${describe}${r.backup ? `（原 crontab 已备份到 ${r.backup}，恢复：crontab ${r.backup}）` : ''}`, decision: `${CRON_DECISION_PREFIX}${op}`, exitCode: r.rc })
    if (r.rc !== 0) throw new Error(r.rc === 90 ? tr('无法创建备份目录 ~/.lingshell/backups，没有写入') : tr('写入 crontab 失败：{err}', { err: r.text || tr('退出码 {rc}', { rc: r.rc ?? tr('rc|未知') }) }))
    return { ...(r.backup ? { backup: r.backup } : {}) }
  }
  // msg 是 tk() 标过的完整报错，抛出时再翻译
  const str = (v: unknown, msg: string) => { if (typeof v !== 'string' || !v.trim() || v.length > MAX_CMD) throw new Error(tr(msg)); return v }
  const rawStr = (v: unknown) => { if (typeof v !== 'string' || !v.trim() || v.length > MAX_RAW) throw new Error(tr('非法的任务')); return v }
  const lineNo = (v: unknown) => { if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new Error(tr('非法的行号')); return v }

  d.handle('cron:add', (_e, id, entry) => {
    const o = (entry ?? {}) as { schedule?: unknown; command?: unknown; note?: unknown }
    const schedule = str(o.schedule, tk('非法的时间表达式')), command = str(o.command, tk('非法的命令'))
    const note = typeof o.note === 'string' ? o.note.slice(0, 200) : undefined
    return write(id, 'add', `${schedule} ${command}`, (cur) => cronAppend(cur, schedule, command, note))
  })
  d.handle('cron:remove', (_e, id, line, raw) => { const r = rawStr(raw); return write(id, 'delete', r, (cur) => cronRemove(cur, lineNo(line), r)) })
  d.handle('cron:toggle', (_e, id, line, raw, disable) => { const r = rawStr(raw); return write(id, disable === true ? 'disable' : 'enable', r, (cur) => cronToggle(cur, lineNo(line), r, disable === true)) })

  d.handle('firewall:list', async (_e, id): Promise<FwList> => {
    const out = await d.exec(target(id, tk('防火墙视图')).id)(firewallListCommand(), FIREWALL_TIMEOUT_MS)
    if (!out.includes('@@ss')) throw new Error(tr('读不到防火墙规则：远端命令没有输出'))
    return parseFirewall(out)
  })

  d.handle('topology:get', async (_e, id): Promise<Topology> => {
    const out = await d.exec(target(id, tk('服务拓扑')).id)(topologyCommand(), TOPOLOGY_TIMEOUT_MS)
    if (!out.includes('@@listen')) throw new Error(tr('读不到连接信息：远端命令没有输出'))
    return deriveTopology(out)
  })
}
