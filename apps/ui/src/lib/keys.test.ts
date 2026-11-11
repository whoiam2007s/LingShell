import { describe, it, expect } from 'vitest'
import { shouldAuthHotkey, type AuthHotkeyCtx } from './keys.js'

// 守门：确认卡接管 Enter / Esc 的六个条件，少一个都可能误放行危险命令
const ok: AuthHotkeyCtx = { pending: true, latest: true, typing: false, modal: false, cardEditing: false, visible: true }

describe('确认卡键盘守卫 shouldAuthHotkey', () => {
  it('条件全满足才接管', () => {
    expect(shouldAuthHotkey(ok)).toBe(true)
  })

  const cases: [string, Partial<AuthHotkeyCtx>][] = [
    ['卡片已处理（允许 / 拒绝 / 超时）', { pending: false }],
    ['不是最新一张未处理卡', { latest: false }],
    ['焦点在输入框 / 终端', { typing: true }],
    ['有模态弹层', { modal: true }],
    ['卡片正在改命令或写拒绝原因', { cardEditing: true }],
    ['卡片不可见或被抽屉盖住', { visible: false }],
  ]

  for (const [name, patch] of cases) {
    it(`${name}时不响应`, () => {
      expect(shouldAuthHotkey({ ...ok, ...patch })).toBe(false)
    })
  }
})
