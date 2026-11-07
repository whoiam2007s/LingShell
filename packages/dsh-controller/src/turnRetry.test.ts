import { describe, it, expect } from 'vitest'
import { MAX_AUTO_RETRIES, RETRY_SENTINEL, RetryBudget, isRetryableFormatError, retryPrompt } from './turnRetry.js'

describe('isRetryableFormatError：只认「模型吐的参数不是合法 JSON」', () => {
  it('各家报错写法都认（DeepSeek 流 / 截断 / 网关写法）', () => {
    expect(isRetryableFormatError('DeepSeek Messages stream: tool input is invalid JSON')).toBe(true)
    expect(isRetryableFormatError('unexpected end of JSON input')).toBe(true)
    expect(isRetryableFormatError('Upstream error: tool_calls arguments is not valid JSON')).toBe(true)
    expect(isRetryableFormatError('failed to parse arguments for tool exec_in_terminal')).toBe(true)
    expect(isRetryableFormatError({ message: 'Malformed JSON in tool call arguments' })).toBe(true)
  })

  it('环境类 / 用户主动停止 / 工具执行失败不重试', () => {
    for (const msg of [
      '', 'unknown',
      'Request failed with status code 429',
      'fetch failed: ECONNRESET',
      'Invalid API key',
      'tool execution failed: exit code 1',
      'permission denied by user',
      'context length exceeded',
    ]) expect(isRetryableFormatError(msg)).toBe(false)
  })

  it('工具结果里出现 invalid JSON（不是模型输出）不算', () => {
    // 这条是 tools/execute 的结果文本，不是流解析错误；重跑模型没用
    expect(isRetryableFormatError('exec_in_terminal 输出：Error: invalid JSON at line 3')).toBe(false)
  })
})

describe('RetryBudget：连着重试有上限，可重置', () => {
  it(`每个会话最多 ${MAX_AUTO_RETRIES} 次，不同会话互不影响`, () => {
    const b = new RetryBudget()
    expect(b.take('s1')).toBe(1)
    expect(b.take('s1')).toBe(2)
    expect(b.take('s1')).toBeUndefined()
    expect(b.used('s1')).toBe(MAX_AUTO_RETRIES)
    expect(b.take('s2')).toBe(1)          // 别的会话还有额度
  })

  it('用户发新消息 / 正常结束后重置，能再次重试', () => {
    const b = new RetryBudget()
    b.take('s1'); b.take('s1')
    expect(b.take('s1')).toBeUndefined()
    b.reset('s1')
    expect(b.used('s1')).toBe(0)
    expect(b.take('s1')).toBe(1)
  })
})

describe('retryPrompt：给模型的重试说明', () => {
  it('带 sentinel（界面不渲染）、说清原因与要求、标注第几次', () => {
    const t = retryPrompt(1, MAX_AUTO_RETRIES)
    expect(t.startsWith(RETRY_SENTINEL)).toBe(true)
    expect(t).toContain('不是合法 JSON')
    expect(t).toContain('1/2')
    expect(t).toContain('已经成功执行过的工具不要再调一遍')
  })
})
