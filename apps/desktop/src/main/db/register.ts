// 数据库快查（从 ipc.ts 原样搬来，顺序不变）
import { ipcMain } from 'electron'
import { join } from 'node:path'
import { connectSsh, execFull } from '@lingshell/terminal-core'
import { tr, dateLocale } from '@lingshell/shared'
import type { MainContext } from '../core/index.js'
import { pushAlerts } from '../integrations/index.js'
import { runSh, DB_LOCAL_SHELL } from '../terminal/index.js'
import { registerDb } from './dbIpc.js'

export function registerDbIpc(ctx: MainContext) {
  const { win, paths, hostOf, terminals, auditHost, liveTerminal, vault, hostStore, webhookStore, notify } = ctx
  // 数据库快查（见 dbIpc.ts）：连接存 db-conns.json；SSH 主机走它已打开终端的 exec channel，本机走后台 sh；密码经 stdin；终止会话记执行记录 db_kill
  const dbReg = registerDb({
    handle: (ch, fn) => ipcMain.handle(ch, fn),
    file: join(paths.config, 'db-conns.json'),
    host: (hk) => { if (hk === 'local') return { label: tr('本机'), prod: false }; const h = hostOf(hk); return h && { label: h.label, prod: h.env === 'prod' } },
    run: (hk) => {
      if (hk === 'local') return (cmd, o) => runSh(cmd, o, DB_LOCAL_SHELL)   // Windows：自动补上 MySQL / PostgreSQL 的 bin 目录
      const tid = liveTerminal(hk, { ssh: true })
      const t = tid ? terminals.list().find((x) => x.id === tid) : undefined
      if (!t) throw new Error(tr('「{host}」没有打开着的 SSH 终端：先连接这台主机（数据库命令经它的 SSH 连接执行）', { host: hostOf(hk)?.label ?? hk }))
      if (t.os === 'windows') throw new Error(tr('Windows 的 SSH 主机不支持（需要 sh）'))
      return (cmd, o) => terminals.execFull(t.id, cmd, o)
    },
    password: (hk, name) => vault.expandRaw(hk, `{{secret:${name}}}`),
    mask: (text) => vault.maskText(text),
    audit: (hostKey, e) => auditHost(hostKey, e, { logCommand: true }),
    // 定时备份：没人开着终端也要跑 —— 有在线终端复用它的连接，没有就临时连、跑完断开
    schedulesFile: join(paths.config, 'db-backup-schedules.json'),
    withHost: async (hk, fn) => {
      if (hk === 'local') return fn((cmd, o) => runSh(cmd, o, DB_LOCAL_SHELL))
      const tid2 = liveTerminal(hk, { ssh: true, running: true })
      const t = tid2 ? terminals.list().find((x) => x.id === tid2) : undefined
      if (t) return fn((cmd, o) => terminals.execFull(t.id, cmd, o))
      const o = hostStore.resolveConnectOpts(hk)
      const conn = await connectSsh({ ...o, noHostKeyPrompt: true })
      try { return await fn((cmd, x) => execFull(conn.client, cmd, { ...x, encoding: o.encoding })) } finally { conn.close() }
    },
    notify: (t, b) => notify(win, t, b),
    push: (title, lines, hosts, ok) => {
      const targets = webhookStore.resolveAll().filter((w) => w.enabled && w.url)
      if (!targets.length) return Promise.resolve(undefined)
      return pushAlerts(targets, { scheduleName: title, status: ok ? 'normal' : 'abnormal', hosts, time: new Date().toLocaleString(dateLocale(), { hour12: false }), summary: lines.join('\n') })
    },
  })
  return { dbReg }
}
