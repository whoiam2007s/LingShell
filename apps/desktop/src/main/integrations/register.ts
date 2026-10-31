// 集成：对外调用接口、接口调试、群机器人（从 ipc.ts 原样搬来，顺序不变）
import { ipcMain } from 'electron'
import { join } from 'node:path'
import { type WebhookInput, tr } from '@lingshell/shared'
import { log, type MainContext } from '../core/index.js'
import { ApiServer } from './apiServer.js'
import { sendWebhook, testAlert } from './webhook.js'
import { registerApiDebug } from './apiDebugIpc.js'
import type { registerAiIpc } from '../ai/index.js'

type Deps = Pick<ReturnType<typeof registerAiIpc>, 'controller'>

export function registerIntegrationsIpc(ctx: MainContext, deps: Deps) {
  const { paths, layoutStore, appLock, terminals, hiddenTerms, termHostKey, vault, webhookStore } = ctx
  const { controller } = deps

  // ── 对外调用接口：Claude Code 等 agent 工具往「当前打开的会话」发消息，等这轮跑完拿总结 ──
  // 「当前打开的会话」直接复用 UI 已持久化的 layout.activeSessionId（App.tsx 每次切会话都写）。
  const api = new ApiServer({
    configDir: paths.config,
    activeSessionId: () => layoutStore.get().activeSessionId,
    sendTurn: (sid, text) => controller.sendTurn(sid, text),
    onEvent: (h) => controller.onEvent(h),
    isLocked: () => appLock.locked,
    log: (level, message, data) => log(level, 'main', 'api', message, data),
  })
  api.start().then((port) => log('info', 'main', 'api', `api server on 127.0.0.1:${port}`))
    .catch((err) => log('error', 'main', 'api', `api start failed: ${String(err)}`))
  // 接口调试面板（见 apiDebugIpc.ts）：集合存数据目录；从主机发送走该 SSH 终端的 exec channel（curl -K -，内容经 stdin）
  registerApiDebug({
    handle: (ch, fn) => ipcMain.handle(ch, fn),
    file: join(paths.config, 'api-debug.json'),
    terminal: (id) => terminals.list().find((t) => t.id === id && !hiddenTerms.has(t.id)),
    hostKey: (id) => termHostKey.get(id),   // 映射缺失时不能回退成本机（会放行 scope=local 的密钥）
    exec: (id, cmd, o) => terminals.execFull(id, cmd, o),
    expandSecrets: (hk, text) => vault.expandRaw(hk, text),
    mask: (text) => vault.maskText(text),
  })
  ipcMain.handle('webhooks:list', () => webhookStore.list())
  ipcMain.handle('webhooks:save', (_e, input: WebhookInput) => webhookStore.save(input))
  ipcMain.handle('webhooks:delete', (_e, id: string) => webhookStore.delete(id))
  ipcMain.handle('webhooks:test', async (_e, id: string) => {
    const t = webhookStore.resolveAll().find((w) => w.id === id)
    if (!t?.url) throw new Error(tr('机器人不存在或地址无法解密，请重新填写'))
    try {
      await sendWebhook(t, testAlert())
      log('info', 'main', 'inspection', `群机器人测试成功：${t.name}`)   // i18n-ignore 日志
    } catch (e) {
      log('warn', 'main', 'inspection', `群机器人测试失败：${t.name}：${(e as Error).message}`)   // i18n-ignore 日志
      throw e
    }
  })
  return { api }
}
