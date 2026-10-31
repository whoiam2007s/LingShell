/* eslint-disable @typescript-eslint/no-explicit-any */
// 发给 AI 前脱敏：所有工具（终端工具 / propose_plan / MCP）注册进 dsh 前包一层 withRedaction，
// 工具体的返回值与报错文本就是进模型的内容，在这一处换掉机密。终端 UI、执行记录、录像都不经过这里。
import { REDACTED, hasPlaceholder, redactToolText, tr } from '@lingshell/shared'

// 已知机密明文（主机密码/私钥、命名凭据的密码/私钥/口令、API Key、Webhook、MCP 凭据、自动应答密钥…）；返回 undefined = 脱敏关闭
export type SecretsFn = () => readonly string[] | undefined

export const REDACT_GUIDANCE = `脱敏：工具结果里的密码、私钥、API Key、token 等机密已替换成 ${REDACTED}，你看不到真实值。`   // i18n-ignore 模型提示词
  + `绝不要把 ${REDACTED} 写进文件或命令（write_file / exec_in_terminal 等会直接拒绝）；需要真实值时请用户自己填写或修改，`   // i18n-ignore 模型提示词
  + '排查认证失败这类问题时说明你看不到密码，让用户自行核对。'   // i18n-ignore 模型提示词

// 入参会落到文件/命令里的工具：带占位符就拒（防止把配置里的密码改成 [已脱敏]）
export const GUARDED_TOOLS = new Set(['exec_in_terminal', 'exec_on_terminals', 'start_background', 'write_file', 'propose_plan', 'propose_host_knowledge', 'run_on_hosts', 'propose_quick_commands', 'propose_runbook'])

export function placeholderError(toolName: string, args: unknown): string | undefined {
  if (!GUARDED_TOOLS.has(toolName)) return undefined
  const { explain: _e, ...rest } = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  if (!hasPlaceholder(rest)) return undefined
  return tr('已拒绝：参数里含 {mark}。这是脱敏占位符，不是真实内容（原值是密码/密钥等机密，已对你隐藏）。不要把它写进文件或命令；需要真实值的地方请让用户自己填写或修改，或改用不涉及该值的做法。', { mark: REDACTED })
}

// 密钥保险箱占位符 {{secret:名称}} 不能被样式脱敏误伤（「secret:」会被当成 key: value 抹成 [已脱敏]）：
// 脱敏前换成私用区字符包着的序号（JSON 合法、不匹配任何规则），脱敏后换回
const REF = /\{\{secret:[a-z0-9_-]{1,64}\}\}/g
export function keepSecretRefs(text: string, f: (s: string) => string): string {
  const keep: string[] = []
  const t = text.replace(REF, (m) => `${keep.push(m) - 1}`)
  return keep.length ? f(t).replace(/(\d+)/g, (_, i: string) => keep[Number(i)]) : f(t)
}

/**
 * 包一层：先查占位符，再跑工具体，结果 / 报错文本脱敏。secrets 每次调用现取（改设置、改密码即时生效）。
 * onRefuse：拒绝时工具体没跑，网关为这次调用记下的 override 由它取走。
 * mask：密钥保险箱的明文回写（明文 → {{secret:名称}}），不受脱敏开关影响，先于脱敏做
 */
export function withRedaction<T extends { name: string; execute: (...a: any[]) => Promise<any> }>(def: T, secrets: SecretsFn, onRefuse?: (exec: any) => void, mask?: (s: string) => string): T {
  const execute = async (args: unknown, exec: unknown) => {
    const list = secrets()
    if (!list && !mask) return def.execute(args, exec)
    const refused = list ? placeholderError(def.name, args) : undefined
    if (refused) { onRefuse?.(exec); throw new Error(refused) }
    const clean = (s: string) => { const m = mask ? mask(s) : s; return list ? keepSecretRefs(m, (t) => redactToolText(t, list)) : m }
    try {
      const out = await def.execute(args, exec)
      return typeof out === 'string' ? clean(out) : out
    } catch (e) {
      if (e instanceof Error) e.message = clean(e.message)
      throw e
    }
  }
  return { ...def, execute }
}
