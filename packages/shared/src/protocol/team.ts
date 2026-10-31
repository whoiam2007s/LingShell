// 团队版协议（客户端开源，Team Server / 企业模块闭源）。
// 这里只放稳定的 API 形状、功能开关和纯 UI 辅助函数；席位、SSO、审计等实现一律在服务端。
// 许可证校验以服务端为准；客户端不凭这些类型做安全决策。

import { tk } from '../i18n/i18n.js'

export type TeamEdition = 'team' | 'enterprise'

export const TEAM_FEATURES = [
  'shared_vault',        // 共享主机 / 凭据库
  'central_policy',      // 集中命令规则 / 变更策略
  'approval_flow',       // 多级审批 / 电子签字
  'audit_export',        // 集中审计 / SIEM 导出
  'sso',                 // OIDC / LDAP / 企业微信 / 钉钉
  'rbac',                // 角色与主机 / 操作权限
  'relay',               // 远程中继 / NAT 穿透
  'team_dashboard',      // 团队仪表盘 / 值班
  'shared_content',      // 团队 Runbook / Skills / 知识库
  'backup_policy',       // 团队数据库备份策略
  'deploy_approval',     // 团队部署评审 / 发布门禁
  'archive',             // 录像 / 日志长期归档
] as const

export type TeamFeature = (typeof TEAM_FEATURES)[number]

export const TEAM_FEATURE_LABEL: Record<TeamFeature, string> = {
  shared_vault: tk('共享主机与凭据'),
  central_policy: tk('集中策略'),
  approval_flow: tk('审批流'),
  audit_export: tk('集中审计与导出'),
  sso: tk('单点登录'),
  rbac: tk('角色权限'),
  relay: tk('远程中继'),
  team_dashboard: tk('团队仪表盘'),
  shared_content: tk('团队内容库'),
  backup_policy: tk('团队备份策略'),
  deploy_approval: tk('部署审批'),
  archive: tk('长期归档'),
}

/** 服务端返回的当前授权能力；客户端只用于显示 / 灰化入口，不做安全判断 */
export interface TeamEntitlements {
  edition: TeamEdition
  seats: number
  features: TeamFeature[]
  issuedAt?: string
  expiresAt: string
  supportUntil?: string
  deploymentId?: string
}

/** 离线 license 文件的载荷（签名由签发工具生成，服务端校验） */
export interface TeamLicensePayload {
  v: 1
  keyId: string
  licenseId: string
  customer: string
  edition: TeamEdition
  seats: number
  features: TeamFeature[]
  issuedAt: string
  expiresAt: string
  supportUntil?: string
  deploymentId?: string
}

export interface TeamServerInfo {
  url: string
  name?: string
  version: string
  edition: TeamEdition
}

export interface TeamServerStatus {
  reachable: boolean
  info?: TeamServerInfo
  entitlements?: TeamEntitlements
  error?: string
}

export type TeamRole = 'owner' | 'admin' | 'member' | 'auditor'
export type TeamMemberStatus = 'active' | 'invited' | 'disabled'

export interface TeamMember {
  id: string
  email: string
  name?: string
  role: TeamRole
  status: TeamMemberStatus
  lastSeenAt?: string
}

export type SharedCredentialKind = 'password' | 'key' | 'agent'

/** 共享凭据只返回摘要，值永远不下发到客户端列表 */
export interface SharedCredentialSummary {
  id: string
  name: string
  kind: SharedCredentialKind
  scope?: string
  updatedAt: string
}

export interface TeamPolicySummary {
  id: string
  name: string
  hostGroupId?: string
  updatedAt: string
}

/** 集中审计事件：命令原文仍由部署方决定是否上报 / 脱敏 */
export interface TeamAuditEvent {
  id: string
  at: string
  actor: string
  action: string
  hostKey?: string
  command?: string
  decision?: string
  detail?: string
}

/** 客户端 UI 辅助：服务端已按 license 返回 features，这里只判断是否显示入口 */
export function hasTeamFeature(e: Pick<TeamEntitlements, 'features'> | undefined, f: TeamFeature): boolean {
  return !!e?.features.includes(f)
}

/** 客户端 UI 辅助：license 是否未过期（服务端才是最终判定） */
export function isTeamLicenseActive(e: Pick<TeamEntitlements, 'expiresAt'>, now = new Date()): boolean {
  const t = Date.parse(e.expiresAt)
  return Number.isFinite(t) && t > now.getTime()
}
