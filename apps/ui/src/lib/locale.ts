// 渲染层界面语言：必须是 main.tsx 的第一个 import（模块按 import 顺序求值，别的模块求值前语言就要定好）。
// 设置缓存在 localStorage：启动时同步读出来先用；读到已存设置后若不一致（导入配置 / 缓存被清）刷新一次页面。
// 悬浮球窗口（ball.html）同源，共用这份缓存
import { isUiLanguage, resolveLocale, setLocale, getLocale, type UiLanguage } from '@lingshell/shared'

export const LOCALE_CACHE_KEY = 'lingshell.language'

function cached(): UiLanguage {
  try { const v = localStorage.getItem(LOCALE_CACHE_KEY); return isUiLanguage(v) ? v : 'auto' } catch { return 'auto' }
}
let setting: UiLanguage = cached()
setLocale(resolveLocale(setting, navigator.language))
document.documentElement.lang = getLocale()

export const getUiLanguage = () => setting
/** 记下新的语言设置（落盘由调用方走 saveSystemPatch）；返回是否需要重启才能生效 */
export function rememberUiLanguage(v: unknown): boolean {
  setting = isUiLanguage(v) ? v : 'auto'
  try { localStorage.setItem(LOCALE_CACHE_KEY, setting) } catch { /* 存不了就下次按系统语言 */ }
  return resolveLocale(setting, navigator.language) !== getLocale()
}
/** 读到已存设置后校正：缓存与设置不一致 → 记下并刷新页面（终端和会话都在主进程，刷新不丢） */
export function syncUiLanguage(v: unknown) {
  if ((isUiLanguage(v) ? v : 'auto') === setting) return
  if (rememberUiLanguage(v)) location.reload()
}
