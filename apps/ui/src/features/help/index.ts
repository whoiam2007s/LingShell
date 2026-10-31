// 本目录对外入口：其它目录只从这里引用（eslint no-restricted-imports 检查）。只导出外部实际用到的。
export { HELP_INDEX, HELP_SECTIONS_FULL, HelpModal, Highlight, isHelpKey } from './HelpModal.js'
export { helpTokens, searchHelp } from './helpSearch.js'
export type { HelpTarget } from './helpSearch.js'
