import { describe, it, expect } from 'vitest'
import { compactErrorText } from './compactError.js'

// 注意：测试环境里 tr() 返回中文原文（词条未初始化），所以直接断言中文片段
describe('compactErrorText', () => {
  it('空原因给默认文案', () => {
    expect(compactErrorText()).toContain('压缩失败')
    expect(compactErrorText('   ')).toContain('压缩失败')
  })

  it('摘要不比原文短 → 压不动了，建议新开会话', () => {
    const s = compactErrorText('summary is not smaller than the shadowed content (3172 tokens)')
    expect(s).toContain('压不动')
    expect(s).toContain('新开一个会话')
  })

  it('surface changed → 再点一次', () => {
    expect(compactErrorText('surface changed during compaction')).toContain('再点一次')
  })

  it('busy / in progress / turn running → 等本轮结束', () => {
    expect(compactErrorText('agent is busy')).toContain('本轮还在跑')
    expect(compactErrorText('compaction already in progress')).toContain('本轮还在跑')
    expect(compactErrorText('turn is running')).toContain('本轮还在跑')
  })

  it('超时 → 给重试与新开会话两条路', () => {
    expect(compactErrorText('request timed out')).toContain('超时')
    expect(compactErrorText('ETIMEDOUT')).toContain('超时')
  })

  it('中断 → 再点一次', () => {
    expect(compactErrorText('aborted')).toContain('再点一次')
    expect(compactErrorText('cancel requested')).toContain('再点一次')
  })

  it('不认识的原因保留原文，方便复制', () => {
    const s = compactErrorText('some engine exploded: code 42')
    expect(s).toContain('some engine exploded: code 42')
    expect(s).toContain('开发者')
  })
})
