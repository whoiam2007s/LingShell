import { type BrowserWindow, powerMonitor, app } from 'electron'
import { createMainContext } from './services.js'
import { registerAiIpc } from './ai/index.js'
import { registerOpsIpc } from './ops/index.js'
import { registerFilesIpc } from './files/index.js'
import { registerGitIpc } from './git/index.js'
import { registerDbIpc } from './db/index.js'
import { registerIntegrationsIpc } from './integrations/index.js'
import { registerMobileIpc } from './mobile/index.js'
import { registerAppIpc } from './app/index.js'
import { registerTerminalIpc } from './terminal/index.js'

// 组合根：先建共享服务（应用锁门禁在其中最先装上），再按顺序挂各领域；窗口关闭 / 退出时的收尾在最后，顺序同改造前
// registerIpc 必须保持同步执行：中间不 await，各领域 register 也不同步发起网络连接。否则主机指纹策略
// （terminal 领域里的 setHostKeyPolicy）可能晚于第一次 SSH 握手
export function registerIpc(win: BrowserWindow) {
  const ctx = createMainContext(win)
  const { dashboard, forwards, vault, recorder, logUnsub, stopAllLogs } = ctx
  const { controller, openTerminal, mcp, decideApproval } = registerAiIpc(ctx, { hostCheck: () => hostCheck })
  const { hostCheck, ports, k8s, multiLogs, watchdogs, certs, inspection } = registerOpsIpc(ctx, { controller, openTerminal })
  const { externalEdit } = registerFilesIpc(ctx)
  registerGitIpc(ctx, { controller })
  const { dbReg } = registerDbIpc(ctx)
  const { api } = registerIntegrationsIpc(ctx, { controller })
  const { mobile } = registerMobileIpc(ctx, { decideApproval })
  win.on('closed', () => k8s.stopAll())
  win.on('closed', () => externalEdit.stopAll())
  win.on('closed', () => multiLogs.dispose())
  win.on('closed', () => watchdogs.stop())
  win.on('closed', () => mobile.stop())
  const { idleTimer, lockNow } = registerAppIpc(ctx, { watchdogs })
  const { hostStats } = registerTerminalIpc(ctx, { externalEdit, ports })

  win.on('closed', () => { certs.stop(); dbReg.stop(); clearInterval(idleTimer); hostStats.stop(); dashboard.stop(); powerMonitor.off('lock-screen', lockNow); powerMonitor.off('suspend', lockNow); inspection.stop(); void controller.stopAll(); void mcp.close(); api.stop(); forwards.stopAll() })
  // 退出前等录像流 / 会话日志写完再退（否则缓冲里最后一段会丢）；第二次进来已无打开的，直接放行
  app.on('before-quit', (e) => {
    vault.clearClipboardIfSecret()   // 30 秒自动清空靠的是进程里的定时器，退出前主动清一次
    if (!recorder.active && !logUnsub.size) return
    e.preventDefault()
    void Promise.all([recorder.stopAll(), stopAllLogs()]).finally(() => app.quit())
  })
}
