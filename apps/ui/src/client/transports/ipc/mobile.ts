// AppClient 手机访问部分的 IPC 实现（接口见 packages/shared/src/protocol/client/mobile.ts，主进程见 apps/desktop/src/main/mobile/register.ts）
import type { AppClient, MobileApi } from '@lingshell/shared'

export function createMobileIpc(): MobileApi {
  return {
    mobile: {
      status: () => window.electronAPI.invoke('mobile:status') as ReturnType<AppClient['mobile']['status']>,
      setEnabled: (on) => window.electronAPI.invoke('mobile:setEnabled', on) as ReturnType<AppClient['mobile']['status']>,
      configure: (c) => window.electronAPI.invoke('mobile:configure', c) as ReturnType<AppClient['mobile']['status']>,
      newPairCode: () => window.electronAPI.invoke('mobile:newPairCode') as ReturnType<AppClient['mobile']['status']>,
      revoke: (id) => window.electronAPI.invoke('mobile:revoke', id) as ReturnType<AppClient['mobile']['status']>,
      revokeAll: () => window.electronAPI.invoke('mobile:revokeAll') as ReturnType<AppClient['mobile']['status']>,
    },
  }
}
