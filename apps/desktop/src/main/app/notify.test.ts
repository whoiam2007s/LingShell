import { describe, it, expect, vi, beforeEach } from 'vitest'

const shown: { title: string; body: string; click?: () => void }[] = []
vi.mock('electron', () => ({
  Notification: class {
    static isSupported() { return true }
    rec: { title: string; body: string; click?: () => void }
    constructor(o: { title: string; body: string }) { this.rec = { ...o }; shown.push(this.rec) }
    on(_ev: string, fn: () => void) { this.rec.click = fn }
    show() {}
  },
}))

const { notify, notifyIfUnfocused, setNotifyLockState, LOCKED_TITLE, LOCKED_BODY, clearNotifyCache } = await import('./notify.js')

const mkWin = (o: { focused?: boolean; minimized?: boolean; visible?: boolean } = {}) => ({
  isDestroyed: () => false, isFocused: () => o.focused ?? false, isMinimized: () => o.minimized ?? false, isVisible: () => o.visible ?? true,
  flashFrame: vi.fn(), once: vi.fn(), show: vi.fn(), focus: vi.fn(), restore: vi.fn(),
}) as unknown as Parameters<typeof notify>[0]

describe('notify 前台判定', () => {
  beforeEach(() => { shown.length = 0; clearNotifyCache(); setNotifyLockState(() => false) })
  it('最小化（即便系统仍报有焦点）照样提醒；前台可见时不打扰', () => {
    notifyIfUnfocused(mkWin({ focused: true, minimized: true }), '任务完成', '完成')
    expect(shown).toHaveLength(1)
    shown.length = 0; clearNotifyCache()
    notifyIfUnfocused(mkWin({ focused: true }), '任务完成', '完成')
    expect(shown).toHaveLength(0)
  })
})

describe('notify 锁定脱敏', () => {
  let locked = false
  beforeEach(() => { shown.length = 0; locked = false; setNotifyLockState(() => locked); clearNotifyCache() })

  it('未锁定：原样透传，点击执行 onClick', () => {
    const onClick = vi.fn()
    notify(mkWin(), '「部署」等待你授权', 'rm -rf /tmp/x @ prod-db', onClick)
    expect(shown[0]).toMatchObject({ title: '「部署」等待你授权', body: 'rm -rf /tmp/x @ prod-db' })
    shown[0].click?.()
    expect(onClick).toHaveBeenCalled()
  })

  it('锁定：只给通用文案，点击只回窗口不跳转', () => {
    locked = true
    const onClick = vi.fn(), win = mkWin()
    notify(win, '巡检「prod-db」异常', 'disk 98% on 10.0.0.5', onClick)
    expect(shown[0]).toEqual(expect.objectContaining({ title: LOCKED_TITLE, body: LOCKED_BODY }))
    shown[0].click?.()
    expect(win.show).toHaveBeenCalled()
    expect(onClick).not.toHaveBeenCalled()
  })

  it('任意新调用方（notifyIfUnfocused）同样被覆盖', () => {
    locked = true
    notifyIfUnfocused(mkWin(), '新功能：主机 web-01 有事', 'secret-token-123')
    expect(JSON.stringify(shown)).not.toMatch(/web-01|secret/)
    expect(shown[0]).toMatchObject({ title: LOCKED_TITLE, body: LOCKED_BODY })
  })
})
