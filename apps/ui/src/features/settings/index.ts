// 本目录对外入口：其它目录只从这里引用（eslint no-restricted-imports 检查）。只导出 外部实际用到的。
//
// 设置弹窗是低频面板（十几个子面板、六千多行），做成懒加载：启动时只需要 TITLES 与索引，
// 用户真正点开设置时才去解析弹窗本体。TITLES 因此移到了 titles.ts（否则那几个标题字符串
// 会把整个设置模块重新拖回首屏）。
import { lazy } from 'react'

export const SettingsModal = lazy(() => import('./SettingsModal.js').then((m) => ({ default: m.SettingsModal })))
export type { SettingsFocus } from './SettingsModal.js'
export { TITLES, type SettingsTab } from './titles.js'

export { CertSoonBadge } from './productivity/CertManager.js'
export { SETTINGS_INDEX } from './settingsIndex.gen.js'
