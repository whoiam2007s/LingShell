// 本目录对外入口：其它目录只从这里引用（eslint no-restricted-imports 检查）。只导出 外部实际用到的。
// 用量弹窗低频：懒加载；openUsage 是启动路径要用的轻量函数，保持同步导出。
import { lazy } from 'react'

export const UsageModal = lazy(() => import('./UsageModal.js').then((m) => ({ default: m.UsageModal })))
export { openUsage } from './usageData.js'
