// ── 配置导出 / 导入（换电脑、重装、备份）────────────────────
// 文件 .lingshell-config.json；格式与加解密见 packages/config/src/configBundle.ts
import { tk } from '../i18n/i18n.js'

export type ConfigSection = 'hosts' | 'knownHosts' | 'templates' | 'quickCommands' | 'schedules' | 'system' | 'model' | 'webhooks' | 'autoReplies' | 'knowledge' | 'secrets'
export const CONFIG_SECTIONS: { id: ConfigSection; label: string }[] = [
  { id: 'hosts', label: tk('主机（含跳板/分组/备注/凭据）') },
  { id: 'knownHosts', label: tk('已信任指纹') },
  { id: 'templates', label: tk('常用模板') },
  { id: 'quickCommands', label: tk('快速命令（按命令组）') },
  { id: 'schedules', label: tk('定时巡检') },
  { id: 'system', label: tk('系统设置') },
  { id: 'model', label: tk('模型设置（全部模型配置 + 单价）') },
  { id: 'webhooks', label: tk('告警机器人（地址含 token，需设导出密码）') },
  { id: 'autoReplies', label: tk('自动应答（密钥应答需设导出密码）') },
  { id: 'knowledge', label: tk('知识库（主机 / 分组 / 全局知识卡）') },
  { id: 'secrets', label: tk('密钥保险箱（名称 / 说明 / 范围；值需设导出密码）') },
]

export interface ConfigExportOpts {
  sections: ConfigSection[]
  password?: string          // 有值 = 凭据（主机密码/私钥/口令、API Key 等）用它派生的密钥加密后一并导出；无 = 凭据不导出
}

export interface ConfigPreview {
  exportedAt: string
  appVersion: string
  counts: Partial<Record<ConfigSection, number>>   // 每节条数（system/model 为 1）
  hasSecrets: boolean
  credentialsOmitted: number                       // 没带凭据、导入后需重填的主机数
  proxyCommands?: { label: string; command: string }[]   // 带 ProxyCommand 的主机：导入后连接时会在本机执行这些命令（预览醒目提示）
}

// 合并策略：merge = 已有同键保留；overwrite = 已有同键用文件里的覆盖。system/model 只有「替换」
export type MergeMode = 'merge' | 'overwrite'
export interface ConfigImportOpts {
  password?: string
  hosts?: MergeMode
  knownHosts?: boolean
  templates?: MergeMode
  quickCommands?: MergeMode   // 按命令组名合并
  schedules?: MergeMode
  system?: boolean
  model?: boolean
  webhooks?: MergeMode
  autoReplies?: MergeMode     // 按规则名合并
  knowledge?: MergeMode       // 按卡片 id 合并；主机卡按导入的主机重映射，本机找不到的主机卡丢弃
  secrets?: MergeMode         // 密钥保险箱：按名称合并；指定主机按导入的主机重映射
}

export interface MergeCount { added: number; updated: number; skipped: number }
export interface ConfigImportReport {
  hosts?: MergeCount & { needCredentials: string[] }   // needCredentials：需重填凭据的主机名
  knownHosts?: { added: number; same: number; conflicts: { hostPort: string; existing: string; incoming: string }[] }
  templates?: MergeCount
  quickCommands?: MergeCount
  schedules?: MergeCount & { droppedTargets: number }  // 目标主机找不到被去掉的数量
  system?: boolean
  model?: boolean
  apiKeys?: number
  webhooks?: MergeCount
  autoReplies?: MergeCount & { needResponse: string[] }   // needResponse：密钥应答没随文件带来（未设导出密码）、已停用待重填的规则名
  knowledge?: MergeCount & { dropped: number }            // dropped：所属主机在本机找不到、丢弃的主机卡数
  secrets?: MergeCount & { needValue: string[] }          // needValue：值没随文件带来（未设导出密码）、需「替换值」后才能用的密钥名
}
