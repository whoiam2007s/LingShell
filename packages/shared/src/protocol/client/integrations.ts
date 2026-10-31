// AppClient 的集成：接口调试、群机器人、密钥保险箱。主进程注册见 apps/desktop/src/main/integrations/register.ts，渲染层实现见 apps/ui/src/client/transports/ipc/integrations.ts
import type { WebhookSummary, WebhookInput } from '../../ops/index.js'

export interface IntegrationsApi {
  // 巡检告警群机器人（URL/密钥只进不出）
  webhooks: {
    list(): Promise<WebhookSummary[]>
    save(input: WebhookInput): Promise<WebhookSummary>
    delete(id: string): Promise<void>
    test(id: string): Promise<void>                   // 发测试消息，失败抛错（带原因）
  }
  // 密钥保险箱（设置 → 连接 →「密钥保险箱」，见 desktop/main/integrations/secretsIpc.ts）：值只进不出（save 的 value 留空 = 不改）。
  // copy 把值复制到剪贴板，返回多少秒后自动清空；send 撰写栏发送含 {{secret:名称}} 的内容（主进程展开后写进终端，范围不符抛错、整段不发）
  secrets: {
    list(): Promise<import('../../ui/index.js').SecretSummary[]>
    save(input: import('../../ui/index.js').SecretInput): Promise<import('../../ui/index.js').SecretSummary>
    delete(id: string): Promise<void>
    copy(id: string): Promise<number>
    send(terminalId: string, data: string): Promise<void>
  }
  // 接口调试面板（见 desktop/main/integrations/apiDebugIpc.ts）：集合 / 环境存数据目录；send 返回响应（密钥已换回占位符）和最新历史
  api: {
    load(): Promise<import('../../ops/index.js').ApiStore>
    save(store: import('../../ops/index.js').ApiStore): Promise<import('../../ops/index.js').ApiStore>
    send(input: import('../../ops/index.js').ApiSendInput): Promise<{ response: import('../../ops/index.js').ApiResponse; history: import('../../ops/index.js').ApiHistoryItem[] }>
    clearHistory(): Promise<void>
  }
}
