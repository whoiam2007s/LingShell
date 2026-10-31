// 命名凭据（设置 → SSH 连接管理 →「凭据」）：增删改 + 批量让主机使用某凭据。凭据明文只进不出（渲染层只拿摘要）
import type { HostStore } from '@lingshell/config'
import { tr, type CredentialInput } from '@lingshell/shared'

export interface CredentialsIpcDeps {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  hosts: Pick<HostStore, 'credentials' | 'saveCredential' | 'deleteCredential' | 'setCredential'>
}

const str = (v: unknown, what: string): string => { if (typeof v !== 'string' || !v) throw new Error(tr('非法的{what}', { what })); return v }

export function registerCredentials(d: CredentialsIpcDeps): void {
  d.handle('credentials:list', () => d.hosts.credentials.list())
  d.handle('credentials:save', (_e, input) => {
    if (!input || typeof input !== 'object') throw new Error(tr('非法的凭据'))
    return d.hosts.saveCredential(input as CredentialInput)
  })
  d.handle('credentials:delete', (_e, id) => d.hosts.deleteCredential(str(id, tr('arg|凭据'))))
  d.handle('credentials:assign', (_e, hostIds, id) => {
    if (!Array.isArray(hostIds) || !hostIds.every((x) => typeof x === 'string')) throw new Error(tr('非法的主机列表'))
    return d.hosts.setCredential(hostIds as string[], str(id, tr('arg|凭据')))
  })
}
