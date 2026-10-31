// 本目录对外入口：其它目录只从这里引用（eslint no-restricted-imports 检查）。只导出外部实际用到的。
export { summaryPathOf } from './aiLinkIpc.js'
export { registerAiIpc } from './register.js'
