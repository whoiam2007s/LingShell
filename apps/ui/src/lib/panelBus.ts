// 左右两侧的抽屉面板互斥：同屏只留一个（左侧开着时右侧要自动收起，反之亦然）。
//
// 两侧的状态在两个不同的组件里：左侧（历史 / 授权 / 资源管理器 / Git / 数据库）在 App，
// 右侧（终端区的资源管理器 / 进程 / 端口 / 告警…）在 TerminalView。这里只做一件事：
// 某侧**打开**时广播一声，另一侧收到就把自己关掉。只广播「打开」，不广播关闭，
// 免得两边互相触发成死循环。
export type PanelSide = 'left' | 'right'

type Listener = (side: PanelSide) => void

const listeners = new Set<Listener>()

/** 订阅「某一侧刚打开了抽屉」；返回取消订阅函数 */
export const onPanelOpened = (fn: Listener): (() => void) => {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** 某一侧打开抽屉时调用 */
export const emitPanelOpened = (side: PanelSide): void => {
  for (const fn of [...listeners]) {
    try { fn(side) } catch { /* 单个订阅出错不影响其它 */ }
  }
}
