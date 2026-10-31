// 本目录对外入口：其它目录只从这里引用（eslint no-restricted-imports 检查）。只导出外部实际用到的。
export { AppLock, installLockGate } from './appLock.js'
export { currentTheme, initNativeTheme, registerAppearance, windowBg } from './appearance.js'
export { beginQuit, cancelQuit, shouldHideOnClose } from './background.js'
export { initLocale } from './locale.js'
export { notify, notifyIfUnfocused, setNotifyLockState, userWatching } from './notify.js'
export { initSshUrl, receiveSshUrlArgv } from './sshUrl.js'
export { registerAppIpc } from './register.js'
