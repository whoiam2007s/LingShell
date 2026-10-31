import { describe, it, expect } from 'vitest'
import type { TransferProgressEvent } from '@lingshell/shared'
import { registerTransfer } from './transferIpc.js'

function setup(active: number, answer: boolean) {
  const h = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
  const log: string[] = []
  let onClose!: (e: { preventDefault(): void }) => void
  const list = [{ taskId: 't1', reveal: { local: 'D:\\dl\\a.txt' } }, { taskId: 't2', reveal: { hostId: 'h', path: '/srv' } }] as TransferProgressEvent[]
  registerTransfer({
    handle: (ch, fn) => h.set(ch, fn),
    transfer: { list: () => list, retry: (id) => log.push(`retry ${id}`), clearFinished: () => log.push('clear'), reorder: (id, to) => log.push(`reorder ${id} ${to}`), activeCount: () => active, cancelAll: () => log.push('cancelAll') },
    showItemInFolder: (p) => log.push(`show ${p}`),
    onWindowClose: (f) => { onClose = f },
    closeWindow: () => log.push('close'),
    confirmQuit: async (n) => { log.push(`ask ${n}`); return answer },
  })
  const close = () => { let prevented = false; onClose({ preventDefault: () => { prevented = true } }); return prevented }
  return { call: (ch: string, ...a: unknown[]) => h.get(ch)!(null, ...a), log, close }
}

describe('registerTransfer', () => {
  it('定位只认队列里记下的本地落点；参数校验', () => {
    const { call, log } = setup(0, true)
    call('transfer:revealLocal', 't1')
    call('transfer:revealLocal', 't2')   // 远程的不走这里
    call('transfer:retry', 't9')
    expect(log).toEqual(['show D:\\dl\\a.txt', 'retry t9'])
    expect(() => call('transfer:retry', 5)).toThrow(/非法/)
  })

  it('排队顺序：只认 top/up/down', () => {
    const { call, log } = setup(0, true)
    call('transfer:reorder', 't1', 'top')
    expect(() => call('transfer:reorder', 't1', 'bottom')).toThrow(/非法/)
    expect(() => call('transfer:reorder', 3, 'up')).toThrow(/非法/)
    expect(log).toEqual(['reorder t1 top'])
  })

  it('没有进行中的传输：直接关', () => {
    const { close, log } = setup(0, false)
    expect(close()).toBe(false)
    expect(log).toEqual([])
  })

  it('有进行中的：先问；取消则不关，仍要退出则全部中止后关窗口', async () => {
    const no = setup(2, false)
    expect(no.close()).toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(no.log).toEqual(['ask 2'])
    const yes = setup(1, true)
    expect(yes.close()).toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(yes.log).toEqual(['ask 1', 'cancelAll', 'close'])
    expect(yes.close()).toBe(false)   // 确认过的第二次关闭直接放行
  })
})
