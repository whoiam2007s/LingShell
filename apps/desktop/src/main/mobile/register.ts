// 手机查看与授权（从 ipc.ts 原样搬来，顺序不变）
import { ipcMain } from 'electron'
import { join } from 'node:path'
import { tr } from '@lingshell/shared'
import { log, type MainContext } from '../core/index.js'
import os from 'node:os'
import { registerMobile } from './mobileIpc.js'
import { lanAddresses } from './mobileAuth.js'
import mobilePage from './mobilePage.html?raw'
import type { registerAiIpc } from '../ai/index.js'

type Deps = Pick<ReturnType<typeof registerAiIpc>, 'decideApproval'>

export function registerMobileIpc(ctx: MainContext, deps: Deps) {
  const { paths, sessionStore, unattended, hostOf, appLock, knownSecrets, vault, setMobileSecretsInvalidator, sendTaps } = ctx
  const { decideApproval } = deps

  // 手机查看与授权（局域网，见 mobileIpc.ts）：旁听界面事件；授权走 decideApproval，与桌面端同一路径
  const mobile = registerMobile({
    handle: (ch, fn) => ipcMain.handle(ch, fn), file: join(paths.config, 'mobile.json'), page: mobilePage,
    addresses: () => lanAddresses(os.networkInterfaces()),
    sessions: () => sessionStore.list().filter((m) => !unattended.has(m.id)),
    hostInfo: (hk) => (hk === 'local' ? { label: tr('本地'), prod: false } : hk.startsWith('mcp:') ? { label: `MCP · ${hk.slice(4)}`, prod: false } : { label: hostOf(hk)?.label ?? hk, prod: hostOf(hk)?.env === 'prod' }),
    decideApproval: (id, ans, sid) => decideApproval(id, ans, sid),
    isLocked: () => appLock.locked,
    secrets: () => knownSecrets(false),
    mask: (t) => vault.maskText(t),
    log: (lv, m, d) => log(lv, 'main', 'mobile', m, d),
  })
  setMobileSecretsInvalidator(mobile.invalidateSecrets)
  sendTaps.push(mobile.onEvent)
  return { mobile }
}
