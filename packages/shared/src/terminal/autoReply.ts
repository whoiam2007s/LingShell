// ── 自动应答 / 触发器（Xshell「触发器」）────────────────────
// 终端输出停在某个提示上（光标所在的最后一行，去 ANSI）且命中模式 → 自动发送应答。
// 引擎见 apps/desktop/src/main/terminal/autoReply.ts，存储见 packages/config/src/AutoReplyStore.ts。

// scope：'all' = 所有终端；数组 = 只在这些主机（已存主机 id，本地终端用 'local'）
export type AutoReplyScope = 'all' | string[]

interface AutoReplyBase {
  name: string
  pattern: string            // 文本 = 包含（不区分大小写）；regex = 正则（不区分大小写）
  regex: boolean
  secret: boolean            // 应答是密钥（如 sudo 密码）：加密存储，永不回传 UI
  appendEnter: boolean       // 应答后补回车
  scope: AutoReplyScope
  allowProd: boolean         // 生产主机默认不触发，需显式允许
  enabled: boolean
}

// 给 UI 的摘要：密钥应答不带 response，只给 hasResponse
export interface AutoReplySummary extends AutoReplyBase { id: string; response?: string; hasResponse: boolean }

// 保存入参：secret 时 response 留空 = 保持原值
export interface AutoReplyInput extends AutoReplyBase { id?: string; response?: string }

export const AUTO_REPLY_MAX_PER_MIN = 3   // 同一规则在同一终端 1 分钟内最多触发次数，超出即在该终端停用

import { tr } from '../i18n/i18n.js'

/** 校验模式：返回错误文案，合法返回 undefined。不允许能匹配空行的正则（会对每个提示都触发） */
export function checkAutoReplyPattern(pattern: string, regex: boolean): string | undefined {
  if (!pattern.trim()) return tr('匹配内容不能为空')
  if (!regex) return undefined
  let re: RegExp
  try { re = new RegExp(pattern, 'i') } catch { return tr('正则表达式无效') }
  if (re.test('') || re.test(' ')) return tr('正则不能匹配空行')
  return undefined
}

/** 一行是否命中模式（line 已去 ANSI） */
export function matchAutoReply(line: string, pattern: string, regex: boolean): boolean {
  if (!regex) return line.toLowerCase().includes(pattern.toLowerCase())
  try { return new RegExp(pattern, 'i').test(line) } catch { return false }
}
