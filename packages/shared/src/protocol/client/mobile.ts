// AppClient 的手机查看与授权。主进程注册见 apps/desktop/src/main/mobile/register.ts，渲染层实现见 apps/ui/src/client/transports/ipc/mobile.ts

export interface MobileApi {
  // 手机查看与授权（设置 →「手机访问」，见 desktop/main/mobile/mobileIpc.ts）：都返回最新状态
  mobile: {
    status(): Promise<import('../../ui/index.js').MobileStatus>
    setEnabled(on: boolean): Promise<import('../../ui/index.js').MobileStatus>
    configure(c: { address?: string; port?: number }): Promise<import('../../ui/index.js').MobileStatus>
    newPairCode(): Promise<import('../../ui/index.js').MobileStatus>
    revoke(deviceId: string): Promise<import('../../ui/index.js').MobileStatus>
    revokeAll(): Promise<import('../../ui/index.js').MobileStatus>
  }
}
