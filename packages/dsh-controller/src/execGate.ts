// 四档执行模式接进授权网关的判定层：工具名 + 入参 → 判定事实（OpFacts），
// 再和既有授权链的结论合成「放不放宽」。
//
// 与 shared/ai/execMode.ts 的分工：那边只有「事实 → allow / ask / deny」的规则表（纯规则）；
// 事实怎么收集、怎么和 AuthRegistry 那条链叠加，放在这里。全是纯函数，方便单测。
//
// 合成原则：**只放宽、不收紧**。既有链（终端校验 / 命令规则 / 上传下载必问 / 生产主机逐条确认）
// 说拒的照拒，说问的只有判定表也同意放行时才放行 —— 这样默认档 confirm 一行代码都不经过这里，
// 行为与升级前完全一致。

import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import {
  dangerCheck, decideByMode, isDestructiveCommand, isDestructiveTool, tr,
  type ExecMode, type OpFacts,
} from '@lingshell/shared'

// 跑命令的工具（有 command 才判只读 / 危险）。check_background 没有 command，只是查日志，算读。
const EXEC_TOOLS = new Set(['exec_in_terminal', 'exec_on_terminals', 'start_background', 'run_on_hosts'])
const WRITE_TOOLS = new Set(['write_file', 'upload_file'])
// 以后新加的写类工具按前缀归属（现在还没有 move_file / delete_* 工具，先留住规则）
const WRITE_PREFIXES = ['move_file', 'create_', 'delete_', 'remove_']

/** 工具属于哪一类操作：exec 跑命令 / write 写文件 / read 只读 */
export function execKindOf(name: string): OpFacts['kind'] {
  if (EXEC_TOOLS.has(name)) return 'exec'
  if (WRITE_TOOLS.has(name) || WRITE_PREFIXES.some((p) => name.startsWith(p))) return 'write'
  return 'read'
}

/**
 * 写操作的目标是否在会话工作目录之外。判不出来一律当成「目录外」（保守）：
 *  - 没给 path / 没有工作目录 / 相对路径（落点取决于目标主机的 cwd，SSH 更是本地目录之外的远端路径）
 * 目录外的写在任何模式下都要问，所以宁可多问一次。
 */
export function isOutsideWorkDir(path: unknown, workDir?: string): boolean {
  const p = typeof path === 'string' ? path.trim() : ''
  const dir = typeof workDir === 'string' ? workDir.trim() : ''
  if (!p || !dir || !isAbsolute(p)) return true
  const rel = relative(resolve(dir), resolve(p))
  if (!rel) return false                                   // 就是工作目录本身
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
}

/**
 * 目录外写的授权记忆键：取目标文件的父目录（Windows 不分大小写，统一小写后再比）。
 * 判不出（相对路径 / 没给 path）返回 undefined —— 这种不记，下次照样问。
 */
function dirKeyOf(path: unknown): string | undefined {
  const p = typeof path === 'string' ? path.trim() : ''
  if (!p || !isAbsolute(p)) return undefined
  const d = resolve(dirname(p)).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? d.toLowerCase() : d
}

/**
 * 「确认一次」/「信任」档的记忆粒度：工具 + 范围（不含主机，所以换主机同类操作不再问）。
 * 可以安全复用的三类：工作目录内的写、目录外的写（按目标父目录）、只读命令。
 * 删除、危险命令一律不记（永远问）。
 */
export function grantKeyOf(name: string, f: OpFacts): string | undefined {
  if (f.destructive || f.risk === 'dangerous') return undefined
  if (f.kind === 'exec') return f.readOnlyCommand ? `${name}@readonly` : undefined
  if (f.kind === 'write') {
    if (!f.outsideWorkDir) return `${name}@cwd`
    return f.outsideDir ? `${name}@dir:${f.outsideDir}` : undefined   // 判不出目录就不记（保守：下次还问）
  }
  return undefined                                          // 读操作本来就放行，不必记
}

/** 会话级「工具 + 范围」授权记忆（只在内存：重启即失效，与四档模式同生命周期） */
export class ToolGrants {
  private m = new Map<string, Set<string>>()
  has(sessionId: string, key: string): boolean { return this.m.get(sessionId)?.has(key) ?? false }
  remember(sessionId: string, key: string): void {
    const s = this.m.get(sessionId) ?? new Set<string>()
    s.add(key)
    this.m.set(sessionId, s)
  }
  keys(sessionId: string): string[] { return [...(this.m.get(sessionId) ?? [])] }
  clear(sessionId: string): void { this.m.delete(sessionId) }
}

export interface FactsInput {
  name: string
  args: unknown
  /** 只读白名单判定（deps.isReadOnly）；缺省 = 认不出只读，exec 一律按会改东西算 */
  isReadOnly?: (command: string) => boolean
  /** 会话工作目录（判 outsideWorkDir 用） */
  workDir?: string
  /** 该会话已记住的「工具 + 范围」授权（仅 auto 档有意义） */
  granted?: (key: string) => boolean
}

/** 收集这次调用的事实（见 shared/ai/execMode.ts 的 OpFacts 字段表） */
export function modeFacts(o: FactsInput): OpFacts {
  const a = (o.args ?? {}) as Record<string, unknown>
  const kind = execKindOf(o.name)
  const facts: OpFacts = { kind }
  if (kind === 'exec') {
    const command = typeof a.command === 'string' ? a.command : ''
    facts.destructive = isDestructiveCommand(command)
    facts.risk = dangerCheck(command)
    facts.readOnlyCommand = o.isReadOnly?.(command) === true
  } else if (kind === 'write') {
    // 共享的删除判定只认已知的删除类工具；名字以 delete_ / remove_ 开头的一律当真删（保守）
    const byName = (o.name.startsWith('delete_') || o.name.startsWith('remove_')) && a.dryRun !== true
    facts.destructive = isDestructiveTool(o.name, a) || byName
    facts.outsideWorkDir = isOutsideWorkDir(a.path, o.workDir)
    if (facts.outsideWorkDir) facts.outsideDir = dirKeyOf(a.path)
  }
  const key = grantKeyOf(o.name, facts)
  facts.granted = key !== undefined && o.granted?.(key) === true
  return facts
}

/** 模式的中文名（i18n 键：预演 / 逐条确认 / 确认一次 / 信任，见 en/settings.ts） */
export function modeLabelOf(mode: ExecMode): string {
  if (mode === 'preview') return tr('预演')
  if (mode === 'auto') return tr('确认一次')
  if (mode === 'trust') return tr('信任')
  return tr('逐条确认')
}

/** 既有授权链给出的结论（decideFor 的 ask 就是这里的 ask） */
export interface ExistingGate { kind: 'allow' | 'ask' | 'deny'; rule?: string }

/**
 * 该模式下是否放行这次调用（只放宽：既有链说拒 / 必问 / 命中「询问」规则时不放）。
 * veto = 与模式无关的额外否决：上传下载每次必问、生产主机逐条确认。
 */
export function relaxByMode(mode: ExecMode, existing: ExistingGate, facts: OpFacts, veto = false): boolean {
  if (mode !== 'auto' && mode !== 'trust') return false      // confirm：走原路径，行为不变；preview：预演分支自己拦
  if (existing.kind === 'deny') return false                 // 规则禁止 / 只读信任档 / 终端不存在 / 仅手动终端 照旧拒
  if (veto) return false
  if (existing.kind === 'ask' && existing.rule) return false // 用户配了「询问」规则的不放宽
  return decideByMode(mode, facts) === 'allow'
}
