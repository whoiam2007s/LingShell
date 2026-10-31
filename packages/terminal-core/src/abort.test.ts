import { describe, it, expect } from 'vitest'
import { BaseTerminal } from './Terminal.js'

// 测试用最小终端：writeRaw 记录写入，不连真 IO。
class FakeTerminal extends BaseTerminal {
  public written: string[] = []
  protected writeRaw(data: string): void { this.written.push(data) }
  protected killRaw(): void {}
  resize(): void {}
  // 暴露 onRawData 供测试喂数据
  feed(d: string): void { this.onRawData(d) }
}

describe('execCapture abort', () => {
  it('rejects with aborted and sends Ctrl-C when signal aborts', async () => {
    const t = new FakeTerminal('t1')
    const ctrl = new AbortController()
    const p = t.execCapture('sleep 60', 50000, ctrl.signal)
    ctrl.abort()
    await expect(p).rejects.toThrow('aborted')
    expect(t.written.some((w) => w.includes('\x03'))).toBe(true)   // 发了 Ctrl-C
  })

  it('rejects immediately if signal already aborted', async () => {
    const t = new FakeTerminal('t2')
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(t.execCapture('ls', 50000, ctrl.signal)).rejects.toThrow('aborted')
  })

  it('still resolves normally when no signal and sentinel seen', async () => {
    const t = new FakeTerminal('t3')
    const p = t.execCapture('echo hi')
    const wrapped = t.written.find((w) => w.includes('__CW_START_'))!
    const id = /__CW_START_([0-9a-f]+)__/.exec(wrapped)![1]
    t.feed(`__CW_START_${id}__\nhi\n__CW_END_${id}__0__\n`)
    const r = await p
    expect(r.exitCode).toBe(0)
    expect(r.output).toContain('hi')
  })
})
