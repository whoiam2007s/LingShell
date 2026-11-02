// 本目录对外入口：其它目录只从这里引用（eslint no-restricted-imports 检查）。只导出 外部实际用到的。
// 授权抽屉低频：懒加载；ReviewBadge / SudoLeasePick / ToolRollback 是聊天里随时要用的，保持同步。
import { lazy } from 'react'

export const AuthDrawer = lazy(() => import('./AuthDrawer.js').then((m) => ({ default: m.AuthDrawer })))
export { ReviewBadge, SudoLeasePick } from './SafetyBits.js'
export { ToolRollback, ToolSessionContext } from './ToolRollback.js'
