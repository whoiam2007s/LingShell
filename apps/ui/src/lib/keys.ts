// 键盘守卫：确认卡（Enter 允许 / Esc 拒绝）与确认框共用。
//
// 这里只有两件事：判断「这一下按键该不该归我们管」，以及几个 DOM 小工具。
// 纯函数部分（shouldAuthHotkey）不碰 DOM，单独可测 —— 条件改动必须同步改单测。
const EDITABLE = 'input, textarea, select, [contenteditable="true"], [contenteditable=""], [data-password-input]'

/** 焦点是否在可输入控件 / 终端里：在输入框里按 Enter 是换行或提交、在终端里是发给 shell，都不能拿来确认授权 */
export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof Element)) return false
  if (t.closest('.xterm')) return true
  if (t instanceof HTMLElement && t.isContentEditable) return true
  return !!t.closest(EDITABLE)
}

/** 有没有模态弹层（设置 / 帮助 / 命令面板 / 确认框 / 各类弹窗）：它们自己处理键盘，确认卡不抢键 */
export function hasModalOverlay(): boolean {
  return !!document.querySelector('.fixed.inset-0')
}

/** 元素是否真的露在最上层：取卡片中心点做命中测试，被抽屉 / 弹层盖住或滚出视口都算不可见 */
export function isOnTop(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect()
  if (r.width < 4 || r.height < 4) return false
  if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) return false
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 40))
  return !!hit && el.contains(hit)
}

export interface AuthHotkeyCtx {
  /** 这张卡还没处理（已允许 / 已拒绝 / 已超时都不算） */
  pending: boolean
  /** 是当前最新一张未处理卡（同屏多张时避免歧义） */
  latest: boolean
  /** 焦点在输入框 / 终端 / 密码框 */
  typing: boolean
  /** 有模态弹层 */
  modal: boolean
  /** 卡片自己在「改命令」或「写拒绝原因」状态 */
  cardEditing: boolean
  /** 卡片真在屏幕上且没被盖住 */
  visible: boolean
}

/** 确认卡是否该接管 Enter / Esc：六个条件全满足才响应 */
export const shouldAuthHotkey = (c: AuthHotkeyCtx): boolean =>
  c.pending && c.latest && !c.typing && !c.modal && !c.cardEditing && c.visible
