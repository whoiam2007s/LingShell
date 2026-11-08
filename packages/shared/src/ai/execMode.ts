// 四档执行模式的判定表：给定「这次要做什么」的事实，算出该放行、该问、还是该拒。
// 纯函数，不碰文件系统 / 不查配置 —— 事实由主进程的授权网关收集好传进来，这样规则能单测。
//
// 四档（会话级，默认 confirm）：0.1.6 起是**唯一**的信任控制入口，
// 授权注册表里的信任档由这里派生（trustOfMode），旧的「会话信任档」选择器已下线。
//   preview 预演     ：只说不做，写操作全拦，只放行只读
//   confirm 逐条确认 ：每条写都问（删除 / 危险命令同样每条问）
//   auto    确认一次 ：按「工具 + 范围」记授权，同一类操作问一次就不再问
//   trust   信任     ：工作目录内写、只读命令自动放行；目录外写第一次问、批过该目录就不再问；会改东西的命令仍问
//
// 三条不变式（任何模式都成立）：
//   1. 真删除永远问（preview 下直接拒）
//   2. 危险命令永远问（preview 下直接拒）
//   3. 读操作永远放行
import type { RiskLevel, TrustLevel } from '../protocol/index.js'

export type ExecMode = 'preview' | 'confirm' | 'auto' | 'trust'
export const EXEC_MODES: ExecMode[] = ['preview', 'confirm', 'auto', 'trust']
export const DEFAULT_EXEC_MODE: ExecMode = 'confirm'

export type OpDecision = 'allow' | 'ask' | 'deny'

/** 一次操作的事实（由网关收集） */
export interface OpFacts {
  /** read = 只读文件操作；write = 写文件；exec = 跑命令 */
  kind: 'read' | 'write' | 'exec'
  /** 写操作的目标是否在工作目录之外。命令类无法可靠判定路径 → 不填 */
  outsideWorkDir?: boolean
  /** 目录外写的目标父目录（授权记忆按目录记：「批过这个目录就不再问」） */
  outsideDir?: string
  /** kind = exec 时：这条命令是否只读（isReadOnlyCommand） */
  readOnlyCommand?: boolean
  /** 真删除（isDestructiveCommand / isDestructiveTool） */
  destructive?: boolean
  /** 危险命令（dangerCheck 的结果） */
  risk?: RiskLevel
  /** 该操作是否已经被记住批准过（按 grantScopeOf 的粒度） */
  granted?: boolean
}

/**
 * 判定：allow 直接放行 / ask 弹确认 / deny 直接拒（并把理由告诉模型）
 */
export function decideByMode(mode: ExecMode, f: OpFacts): OpDecision {
  const preview = mode === 'preview'

  // 不变式 1、2：删除与危险命令 —— 预演直接拒，其它模式每次都问
  if (f.destructive) return preview ? 'deny' : 'ask'
  if (f.risk === 'dangerous') return preview ? 'deny' : 'ask'

  // 不变式 3：读操作永远放行
  if (f.kind === 'read') return 'allow'

  if (f.kind === 'exec') {
    if (f.readOnlyCommand) {
      // 只读命令：预演也放行；信任直接过；其它模式问过一次就记住
      if (preview || mode === 'trust') return 'allow'
      return f.granted ? 'allow' : 'ask'
    }
    // 会改东西的命令：命令串判不出路径，所以除预演外一律问（trust 也一样）
    return preview ? 'deny' : 'ask'
  }

  // kind === 'write'（文件写入 / 创建 / 移动）
  if (preview) return 'deny'
  // 工作目录外的写：auto / trust 档第一次问，批过这个目录就记住（confirm 不记，照旧每条问）
  if (f.outsideWorkDir && !f.granted) return 'ask'
  switch (mode) {
    case 'trust':
      return 'allow'
    case 'confirm':
    case 'auto':
      return f.granted ? 'allow' : 'ask'
  }
}

/**
 * 授权记忆的粒度（决定「问一次」这个"一次"的范围）：
 *   host = 按主机记（confirm：同主机同级别批一次，换服务器要再批）
 *   tool = 按工具 + 范围内记（auto：write_file@cwd 批过一次，之后所有主机都不再问）
 *   none = 不需要记（trust 里能放行的本来就放行了）
 */
export type GrantScope = 'host' | 'tool' | 'none'
export function grantScopeOf(mode: ExecMode): GrantScope {
  if (mode === 'auto') return 'tool'
  if (mode === 'trust' || mode === 'preview') return 'none'
  return 'host'
}

/** 拒绝时回给模型的理由（模型据此改方案，而不是傻等） */
export function denyReasonOf(mode: ExecMode, f: OpFacts): string {
  if (mode !== 'preview') return 'denied_by_user'
  if (f.destructive) return 'preview_mode_no_delete'
  if (f.risk === 'dangerous') return 'preview_mode_no_dangerous'
  return 'preview_mode_readonly'
}

// ── 四档 ↔ 底层信任档：四档是唯一来源，信任档只是派生值 ──────────────────────
// 授权注册表（AuthRegistry.getTrust）和 AI 复核用这个派生值，
// 不再让用户单独选「只读 / 确认 / 全自主」。

/**
 * 四档 → 底层信任档
 *   preview / confirm → confirm   ：每条 write 都问（preview 另有前置拦截，写直接拒）
 *   auto    / trust   → autonomous：按已批的授权放行，放宽范围由判定表 + 授权记忆控制
 */
export function trustOfMode(mode: ExecMode): TrustLevel {
  return mode === 'auto' || mode === 'trust' ? 'autonomous' : 'confirm'
}

/**
 * 旧版 auth.json 里的信任档 → 四档（升级迁移，只在加载旧数据时用）
 *   autonomous 全自主 → 确认一次（批过一次后同类不再问，语义最接近）
 *   confirm    确认    → 逐条确认
 *   readonly   只读    → 预演（写操作全拦、只读放行）
 */
export function modeOfTrust(legacy: TrustLevel): ExecMode {
  if (legacy === 'autonomous') return 'auto'
  if (legacy === 'readonly') return 'preview'
  return 'confirm'
}
