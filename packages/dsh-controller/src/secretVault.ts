// 密钥保险箱接入（工具层只依赖接口；明文展开 / 回写的实现在主进程 desktop/main/integrations/secretsIpc.ts）。
// 模型只写 {{secret:名称}}：授权卡、执行记录、工具卡片、命令规则 / 危险命令 / 回滚判定看到的都是占位符原文，
// 明文只在命令真正发进终端那一刻（execCapture 的 wire）出现；工具结果进模型前再把明文换回占位符。
import { hasSecretRef, secretRefs, tr } from '@lingshell/shared'

export interface SecretVault {
  /** 命令里引用的密钥能否在这个终端（所在主机）上用：能 / 没引用 → undefined；不能 → 原因（给模型，不含值）。终端不存在也返回 undefined（交给授权判定报 terminal_not_found） */
  check(terminalId: string, command: string): string | undefined
  /** 占位符换成明文（按引号上下文转义）；不能用时抛错（同 check 的原因） */
  expand(terminalId: string, command: string): string
  /** 工具结果 / 用户消息进模型前：明文 → {{secret:名称}} */
  mask(text: string): string
  /** 系统提示里的「密钥保险箱」段（只有名称 / 说明 / 范围）；没有可用密钥返回 '' */
  prompt(): string
}

// 会替换占位符的工具（命令真正发进终端前展开）
const EXPANDS = new Set(['exec_in_terminal', 'start_background', 'exec_on_terminals'])
// 不替换的工具：入参带占位符直接拒，免得模型以为文件里 / 别的主机上拿到了真实值
const UNSUPPORTED = new Set(['run_on_hosts', 'write_file', 'read_file', 'upload_file', 'download_file'])

const idsOf = (toolName: string, args: Record<string, unknown>): string[] => {
  if (toolName === 'exec_on_terminals') return Array.isArray(args.terminal_ids) ? [...new Set(args.terminal_ids.filter((x): x is string => typeof x === 'string'))] : []
  return typeof args.terminal_id === 'string' ? [args.terminal_id] : []
}

/** 授权网关里先查：引用了不存在 / 未设值 / 不在范围内的密钥，或在不支持的工具里用了占位符 → 拒绝原因 */
export function secretError(vault: SecretVault | undefined, toolName: string, args: unknown): string | undefined {
  if (!vault) return undefined
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  if (EXPANDS.has(toolName)) {
    const cmd = typeof a.command === 'string' ? a.command : ''
    if (!secretRefs(cmd).length) return undefined
    for (const id of idsOf(toolName, a)) { const e = vault.check(id, cmd); if (e) return e }
    return undefined
  }
  const { explain: _e, ...rest } = a
  if (UNSUPPORTED.has(toolName) && hasSecretRef(rest)) {
    return tr('secret_unsupported: {tool} 不会替换 {{secret:…}} 占位符（只有 exec_in_terminal / exec_on_terminals / start_background 的命令会在执行前替换），已拒绝。', { tool: toolName })
      + (toolName === 'write_file' ? tr('要把密钥写进文件，请用 exec_in_terminal 执行写入命令（如 printf \'%s\\n\' {{secret:名称}} > 文件）。') : '')
  }
  return undefined
}

/** execCapture 的 wire：命令里有占位符才展开（没有返回 undefined，按原命令执行） */
export function wireOf(vault: SecretVault | undefined, terminalId: string, command: string, wrap: (c: string) => string = (c) => c): { wire: string } | undefined {
  if (!vault || !secretRefs(command).length) return undefined
  return { wire: wrap(vault.expand(terminalId, command)) }
}
