// 界面语言（简体中文 / English）。主进程和渲染层共用这一份：中文原文就是键，英文词典在 locales/en/。
// 用法：
//   tr('已复制')                       → 当前语言的文案（没翻译就原样返回中文，不会显示空白）
//   tr('删除 {n} 个文件', { n: 3 })     → 占位符 {名字}，中英文里的占位符必须一致（i18n 校验脚本 / 单测会查）
//   tk('只读')                         → 只标记「这是要翻译的文案」，值不变；用于模块顶层的常量表（显示时再 tr(label)）
//   tr('size|中')                      → 语境前缀（小写字母 + |）：同一个中文在不同地方意思不同时区分；中文界面显示时去掉前缀
// 约定：
// - 模块顶层不要直接 tr()：顶层代码在 import 时就执行，那时主进程还没读到语言设置
// - 不翻译：发给模型的提示词 / 工具说明、日志、解析命令输出用的中文匹配串（行尾标 // i18n-ignore）
// - 切换语言要重启应用才完全生效（菜单、托盘、主进程报错文案都在启动时定）
import { EN } from './locales/en/index.js'

export type Locale = 'zh-CN' | 'en'
/** 设置里的选项：auto = 跟随系统（系统是中文用中文，否则英文） */
export type UiLanguage = 'auto' | Locale
export const UI_LANGUAGES: { id: UiLanguage; label: string }[] = [
  { id: 'auto', label: tk('跟随系统') },
  { id: 'zh-CN', label: '简体中文' },   // i18n-ignore 语言名用各自的语言显示
  { id: 'en', label: 'English' },
]
export const isUiLanguage = (v: unknown): v is UiLanguage => v === 'auto' || v === 'zh-CN' || v === 'en'

const DICTS: Record<Locale, Record<string, string> | null> = { 'zh-CN': null, en: EN }
let cur: Locale = 'zh-CN'

/** 系统语言（navigator.language / app.getLocale()）+ 设置 → 实际使用的语言 */
export function resolveLocale(setting: unknown, systemLocale?: string): Locale {
  if (setting === 'zh-CN' || setting === 'en') return setting
  return /^zh\b/i.test(systemLocale ?? '') ? 'zh-CN' : 'en'
}
export const setLocale = (l: Locale) => { cur = l === 'en' ? 'en' : 'zh-CN' }
export const getLocale = (): Locale => cur
/** 日期 / 数字格式化用的 BCP 47 标签 */
export const dateLocale = () => (cur === 'en' ? 'en-US' : 'zh-CN')

const fill = (s: string, p?: Record<string, string | number>) =>
  p ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in p ? String(p[k]) : m)) : s

const CTX = /^[a-z][a-z0-9.-]*\|/
/** 翻译。key = 中文原文（可带语境前缀）；没有译文时退回中文 */
export function tr(key: string, params?: Record<string, string | number>): string {
  const d = DICTS[cur]
  return fill((d && d[key]) || key.replace(CTX, ''), params)
}
/** 标记待翻译的文案（值不变），显示时再 tr() */
export function tk<T extends string>(key: T): T { return key }

/** 文案里嵌组件：trParts('点 {btn} 保存', { btn: <Button/> }) → ['点 ', <Button/>, ' 保存']（交给 React 渲染） */
export function trParts<T>(key: string, parts: Record<string, T>, params?: Record<string, string | number>): (string | T)[] {
  const s = tr(key, params)   // i18n-ignore 转发调用方的键
  const out: (string | T)[] = []
  let last = 0
  for (const m of s.matchAll(/\{(\w+)\}/g)) {
    if (!(m[1] in parts)) continue
    if (m.index > last) out.push(s.slice(last, m.index))
    out.push(parts[m[1]])
    last = m.index + m[0].length
  }
  if (last < s.length) out.push(s.slice(last))
  return out
}

/** 占位符集合（校验中英文是否一致用） */
export const placeholdersOf = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort()
