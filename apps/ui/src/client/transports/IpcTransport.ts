// Electron 渲染层的 AppClient：各领域的实现在 ipc/<领域>.ts，这里只组合；事件订阅跨领域，留在这里
import type { AppClient, AppEvent } from '@lingshell/shared'
import { createTerminalIpc } from './ipc/terminal.js'
import { createAiIpc } from './ipc/ai.js'
import { createOpsIpc } from './ipc/ops.js'
import { createFilesIpc } from './ipc/files.js'
import { createGitIpc } from './ipc/git.js'
import { createDbIpc } from './ipc/db.js'
import { createIntegrationsIpc } from './ipc/integrations.js'
import { createMobileIpc } from './ipc/mobile.js'
import { createAppIpc } from './ipc/app.js'

declare global {
  interface Window {
    electronAPI: {
      invoke(channel: string, ...args: unknown[]): Promise<unknown>
      onEvent(handler: (ev: AppEvent) => void): () => void
    }
  }
}

export function createIpcTransport(): AppClient {
  return {
    ...createTerminalIpc(),
    ...createAiIpc(),
    ...createOpsIpc(),
    ...createFilesIpc(),
    ...createGitIpc(),
    ...createDbIpc(),
    ...createIntegrationsIpc(),
    ...createMobileIpc(),
    ...createAppIpc(),
    on: (handler: (ev: AppEvent) => void): (() => void) => window.electronAPI.onEvent(handler),
  }
}
