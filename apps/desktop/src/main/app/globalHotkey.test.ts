import { describe, it, expect, vi, afterEach } from 'vitest'
import type { AppEvent } from '@lingshell/shared'

vi.mock('../core/index.js', () => ({ log: vi.fn() }))
const { registerGlobalHotkey, toggleSummon, createDoubleTap } = await import('./globalHotkey.js')

function fakeWin(s: { visible?: boolean; minimized?: boolean; focused?: boolean }) {
  const calls: string[] = []
  return {
    calls,
    isVisible: () => s.visible ?? true, isMinimized: () => s.minimized ?? false, isFocused: () => s.focused ?? false,
    minimize: () => calls.push('minimize'), restore: () => calls.push('restore'), show: () => calls.push('show'), focus: () => calls.push('focus'),
  }
}

describe('toggleSummon', () => {
  it('前台 → 最小化，不发事件', () => {
    const w = fakeWin({ focused: true }), sent: AppEvent[] = []
    expect(toggleSummon(w, false, (e) => sent.push(e))).toBe('hidden')
    expect(w.calls).toEqual(['minimize']); expect(sent).toEqual([])
  })
  it('最小化 / 没焦点 → 还原置前并让 UI 聚焦终端；锁定中只呼出不聚焦', () => {
    const w = fakeWin({ minimized: true }), sent: AppEvent[] = []
    expect(toggleSummon(w, false, (e) => sent.push(e))).toBe('shown')
    expect(w.calls).toEqual(['restore', 'show', 'focus']); expect(sent).toEqual([{ type: 'app:summon' }])
    const w2 = fakeWin({ focused: false }), sent2: AppEvent[] = []
    toggleSummon(w2, true, (e) => sent2.push(e))
    expect(w2.calls).toEqual(['show', 'focus']); expect(sent2).toEqual([])
  })
  it('有系统级前台判断时以它为准：Electron 以为有焦点但实际被别的程序盖着 → 置前而不是最小化', () => {
    const w = fakeWin({ focused: true }), sent: AppEvent[] = [], fg = { isFront: () => false, bringFront: vi.fn() }
    expect(toggleSummon(w, false, (e) => sent.push(e), fg)).toBe('shown')
    expect(fg.bringFront).toHaveBeenCalled(); expect(w.calls).toEqual(['show', 'focus'])
    expect(toggleSummon(fakeWin({ focused: false }), false, () => {}, { isFront: () => true, bringFront: vi.fn() })).toBe('hidden')
  })
})

// 按时间轴喂采样：[时刻, alt, other]，返回触发的时刻
const run = (seq: [number, boolean, boolean?][]) => { const f = createDoubleTap(); return seq.filter(([t, a, o]) => f(a, !!o, t)).map(([t]) => t) }
describe('双击 Alt 判定', () => {
  it('两次快速点按 → 第二次松开时触发一次', () => {
    expect(run([[0, true], [80, false], [200, true], [280, false], [300, false]])).toEqual([280])
  })
  it('三连按只触发一次；再来两下又触发', () => {
    expect(run([[0, true], [80, false], [200, true], [280, false], [380, true], [460, false], [560, true], [640, false]])).toEqual([280, 640])
  })
  it('间隔太长 / 按太久 / 中间按了别的键（Alt+Tab、Ctrl+Alt）都不触发', () => {
    expect(run([[0, true], [80, false], [600, true], [680, false]])).toEqual([])
    expect(run([[0, true], [500, false], [600, true], [680, false]])).toEqual([])
    expect(run([[0, true], [40, true, true], [80, false], [200, true], [280, false]])).toEqual([])
    expect(run([[0, true], [80, false], [120, false, true], [200, true], [280, false]])).toEqual([])
    expect(run([[0, true, true], [80, false], [200, true], [280, false]])).toEqual([])
  })
})

describe('registerGlobalHotkey', () => {
  afterEach(() => vi.useRealTimers())
  const setup = (enabled: boolean, keys: ((vk: number) => boolean) | null) => {
    const handlers = new Map<string, (...a: unknown[]) => unknown>(), win = fakeWin({ minimized: true }), sent: AppEvent[] = []
    const s = { enabled }
    const h = registerGlobalHotkey({ handle: (ch, fn) => handlers.set(ch, fn), win, send: (e) => sent.push(e), enabled: () => s.enabled, locked: () => false, keys })
    return { h, handlers, s, win, sent }
  }
  it('关着不检测；开了开始检测，双击 Alt 呼出窗口；状态经 IPC 可查', async () => {
    vi.useFakeTimers()
    let alt = false
    const { h, handlers, s, win, sent } = setup(false, (vk) => vk === 0x12 && alt)
    expect(handlers.get('globalHotkey:status')!()).toEqual({ enabled: false, key: '连按两下 Alt', registered: false })
    s.enabled = true; h.apply(); await vi.advanceTimersByTimeAsync(0)
    expect(h.status()).toMatchObject({ enabled: true, registered: true })
    for (const [ms, a] of [[60, true], [80, false], [100, true], [80, false]] as const) { alt = a; await vi.advanceTimersByTimeAsync(ms) }
    expect(win.calls).toEqual(['restore', 'show', 'focus']); expect(sent).toEqual([{ type: 'app:summon' }])
    s.enabled = false; h.apply(); win.calls.length = 0
    for (const [ms, a] of [[60, true], [80, false], [100, true], [80, false]] as const) { alt = a; await vi.advanceTimersByTimeAsync(ms) }
    expect(win.calls).toEqual([])
  })
  it('开关没变时再 apply（设置自动保存）不重开检测，状态对象不变', async () => {
    vi.useFakeTimers()
    const { h } = setup(true, () => false)
    await vi.advanceTimersByTimeAsync(0)
    const st = h.status()
    expect(st).toMatchObject({ enabled: true, registered: true })
    expect(h.apply()).toBe(st)
    const spy = vi.spyOn(globalThis, 'clearInterval')
    h.apply(); h.apply()
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
  it('读不了键盘（非 Windows）→ 开着也 registered=false 带原因', async () => {
    const { h } = setup(true, null)
    await Promise.resolve(); await Promise.resolve()
    expect(h.status()).toMatchObject({ enabled: true, registered: false, error: expect.any(String) })
  })
})
