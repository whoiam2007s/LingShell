// 「打开左边的抽屉」：Git / 数据库这类跟当前项目、当前机器打交道，
// 但不依赖终端区停在哪儿的视图，按钮放在对话区那条活动栏上，抽屉也从左边滑出。
// 命令面板（Ctrl+K）里的同名条目也走这里，保证只有一个入口行为。
export type LeftDrawerKind = 'git' | 'database'

const EVT = 'lingshell:left-drawer'

export function openLeftDrawer(kind: LeftDrawerKind): void {
  window.dispatchEvent(new CustomEvent<LeftDrawerKind>(EVT, { detail: kind }))
}

export function onLeftDrawer(h: (k: LeftDrawerKind) => void): () => void {
  const f = (e: Event) => h((e as CustomEvent<LeftDrawerKind>).detail)
  window.addEventListener(EVT, f)
  return () => window.removeEventListener(EVT, f)
}
