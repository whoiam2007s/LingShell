// 下拉 / 候选面板挂在 body（Portal）上，不在业务弹层的 DOM 里。
// 业务里「点外面关闭 / Esc 关闭」的监听器先判一下：面板开着（或刚被这次点击关掉）时，这次点击 / Esc 归面板处理。
export const UI_LAYER = { 'data-ui-layer': '' } as const

let closedAt = 0
/** 面板因点外面 / Esc 关闭时调用：紧随其后的那次 click 不该再关外层 */
export function markUiLayerClosed() { closedAt = Date.now() }

/** 当前是否有统一组件的浮层（Select / Combobox 面板）开着 */
export function uiLayerOpen(): boolean {
  return typeof document !== 'undefined' && !!document.querySelector('[data-ui-layer]')
}

/** 点击类判断用：开着，或 300ms 内刚因点外面被关掉（pointerdown 关面板 → 同一次的 click 落到遮罩上） */
export function uiLayerBusy(): boolean {
  return uiLayerOpen() || Date.now() - closedAt < 300
}
