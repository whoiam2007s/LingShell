// 主进程界面语言：启动最早期（建 splash / 主窗之前）读 settings.json 定好，之后不变（切换语言要重启，见 shared/i18n.ts）。
// 菜单、托盘、对话框、通知、主进程抛给界面的报错都按这里的语言出
import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveLocale, setLocale, getLocale } from '@lingshell/shared'

export function initLocale(configDir: string) {
  let lang: unknown
  try { lang = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'))?.system?.language } catch { /* 没有设置 = 跟随系统 */ }
  setLocale(resolveLocale(lang, app.getLocale()))
  return getLocale()
}
