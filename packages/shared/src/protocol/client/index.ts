// AppClient = 各领域接口的组合（protocol/client/<领域>.ts）；事件订阅跨领域，放在这里
import type { AppEvent } from '../events.js'
import type { TerminalApi } from './terminal.js'
import type { AiApi } from './ai.js'
import type { OpsApi } from './ops.js'
import type { FilesApi } from './files.js'
import type { GitApi } from './git.js'
import type { DbApi } from './db.js'
import type { IntegrationsApi } from './integrations.js'
import type { MobileApi } from './mobile.js'
import type { AppApi } from './app.js'

export type { SshCreateOpts } from './terminal.js'
export type { TerminalApi, AiApi, OpsApi, FilesApi, GitApi, DbApi, IntegrationsApi, MobileApi, AppApi }

export interface AppClient extends TerminalApi, AiApi, OpsApi, FilesApi, GitApi, DbApi, IntegrationsApi, MobileApi, AppApi {
  // 事件订阅：返回取消订阅函数
  on(handler: (ev: AppEvent) => void): () => void
}
