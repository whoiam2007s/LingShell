// 模型输出「工具参数不是合法 JSON」时的自动续跑（纯逻辑层，便于单测）。
//
// 为什么会这样：流式输出里工具参数是一段段拼出来的，模型偶尔会吐坏 / 某个字段没写完就被截断，
// dsh 在解析阶段就报错，整轮以 turn/end(reason=error) 结束 —— 界面上就是一条红条 +「工具未执行」。
// 这类错误不是环境问题，重发一次请求基本就好了，所以这里自动补一轮让模型重出，最多两次。
//
// 边界（很重要，别放大）：
//  - 只认「参数 JSON 语法」这一类错误；用户点停止、工具执行失败、鉴权 / 网络 / 限额错误一律不重试。
//  - 每个会话最多连着重试 MAX_AUTO_RETRIES 次；用户发新消息或一轮正常结束即清零，避免死循环烧钱。
//  - 重试提示词带 SENTINEL 前缀：模型看得到，界面不渲染（见 relay.ts），不给用户伪造一条「你说的话」。

/** 重试提示词的行首标记：relay 据此不在对话里渲染这条消息 */
export const RETRY_SENTINEL = '[[lingshell:auto-retry]]'

/** 每个会话最多自动重试几次（连着失败就交回用户） */
export const MAX_AUTO_RETRIES = 2

// 各家 / 各协议解析工具参数出错时的写法。都要求同时出现 json 与工具 / 参数字样，避免把工具结果里的
// 「invalid JSON」也算进来（那种是工具执行失败，重跑模型没用）。
const FORMAT_ERRORS: RegExp[] = [
  /\btool[- ]?input\b.{0,40}\binvalid json\b/i,                    // DeepSeek Messages stream: tool input is invalid JSON
  /\bunexpected end of json input\b/i,                             // 参数被截断（Go 网关常见写法）
  /\b(tool[- ]?call|function[- ]?call|arguments?)\b.{0,40}\b(invalid|malformed|not valid|failed to parse)\b.{0,20}\bjson\b/i,
  /\b(invalid|malformed|not valid)\s+json\b.{0,40}\b(tool[- ]?call|arguments?)\b/i,
  /\bfailed to parse\b.{0,30}\b(arguments?|tool[- ]?input)\b/i,     // failed to parse arguments
]

/** 这次回合失败是不是「模型吐的参数不是合法 JSON」，值不值得自动补一轮 */
export function isRetryableFormatError(error: unknown): boolean {
  const msg = typeof error === 'string' ? error : String((error as { message?: unknown } | null)?.message ?? '')
  if (!msg.trim()) return false
  return FORMAT_ERRORS.some((re) => re.test(msg))
}

/** 自动重试预算：按会话记「连着重试了几次」，超限就不再来 */
export class RetryBudget {
  private n = new Map<string, number>()

  /** 取一次重试额度：返回本次是第几次（1..MAX），超限返回 undefined */
  take(sessionId: string): number | undefined {
    const used = this.n.get(sessionId) ?? 0
    if (used >= MAX_AUTO_RETRIES) return undefined
    this.n.set(sessionId, used + 1)
    return used + 1
  }

  /** 已用次数（日志 / 测试用） */
  used(sessionId: string): number { return this.n.get(sessionId) ?? 0 }

  /** 用户发新消息、或一轮正常结束 → 清零 */
  reset(sessionId: string): void { this.n.delete(sessionId) }

  clear(sessionId: string): void { this.n.delete(sessionId) }
}

/**
 * 补发给模型的重试提示词（模型提示词，保持中文，不进界面词表）。
 * 说清三件事：上一轮为什么失败、这次要做什么、别重复已经成功的调用。
 */
export function retryPrompt(attempt: number, max: number): string {
  return `${RETRY_SENTINEL} 上一轮的回复中断了：你输出的工具调用参数不是合法 JSON，解析失败，那个工具没有执行（这是第 ${attempt}/${max} 次自动重试）。`   // i18n-ignore 模型提示词
    + '请重新输出这次工具调用：参数必须是合法 JSON（字符串里的换行、引号要正确转义，不要输出注释或多余文本）。'   // i18n-ignore 模型提示词
    + '已经成功执行过的工具不要再调一遍；如果拿不准参数，先用更简单的参数或先做只读排查。'   // i18n-ignore 模型提示词
}
