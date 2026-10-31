// AppClient 集成部分的 IPC 实现（接口见 packages/shared/src/protocol/client/integrations.ts，主进程见 apps/desktop/src/main/integrations/register.ts）
import type { AppClient, IntegrationsApi, WebhookInput, WebhookSummary } from '@lingshell/shared'

export function createIntegrationsIpc(): IntegrationsApi {
  return {
    webhooks: {
      list: () => window.electronAPI.invoke('webhooks:list') as Promise<WebhookSummary[]>,
      save: (input: WebhookInput) => window.electronAPI.invoke('webhooks:save', input) as Promise<WebhookSummary>,
      delete: (id: string) => window.electronAPI.invoke('webhooks:delete', id) as Promise<void>,
      test: (id: string) => window.electronAPI.invoke('webhooks:test', id) as Promise<void>,
    },
    secrets: {
      list: () => window.electronAPI.invoke('secrets:list') as ReturnType<AppClient['secrets']['list']>,
      save: (input) => window.electronAPI.invoke('secrets:save', input) as ReturnType<AppClient['secrets']['save']>,
      delete: (id) => window.electronAPI.invoke('secrets:delete', id) as Promise<void>,
      copy: (id) => window.electronAPI.invoke('secrets:copy', id) as Promise<number>,
      send: (terminalId, data) => window.electronAPI.invoke('secrets:send', terminalId, data) as Promise<void>,
    },
    api: {
      load: () => window.electronAPI.invoke('api:load') as ReturnType<AppClient['api']['load']>,
      save: (s) => window.electronAPI.invoke('api:save', s) as ReturnType<AppClient['api']['save']>,
      send: (input) => window.electronAPI.invoke('api:send', input) as ReturnType<AppClient['api']['send']>,
      clearHistory: () => window.electronAPI.invoke('api:clearHistory') as Promise<void>,
    },
  }
}
