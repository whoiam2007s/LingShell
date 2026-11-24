// 编辑器「缓冲层」的纯逻辑：换行符判定、落盘文本、是否有未保存改动。
//
// 为什么单独抽出来：这三件互相耦合，0.1.19 就在这里翻过一次车 ——
// 给 dirty 补了「换行符也一起比」，却忘了让 discard() 复位 eol，于是切过 LF/CRLF 之后
// 点「丢弃」仍然显示有改动、关窗又弹一次。这种耦合放在组件里只能靠手点验证，抽出来就能单测。
import { eolInfo } from './editorOps.js'

export type Eol = 'lf' | 'crlf'

/** textarea 的 value 会把 CRLF 归一成 LF：编辑态一律按 LF 存 */
export const normalizeEolText = (t: string): string => t.replace(/\r\n/g, '\n')

/** 按原文件判定换行符：混用时按数量多的那种；没有内容时按 LF（附带两种换行符的行数，状态栏要用） */
export function eolOf(base: string | undefined): { eol: Eol; mixed: boolean; crlf: number; lf: number } | undefined {
  if (base === undefined) return undefined
  const i = eolInfo(base)
  return { eol: i.crlf > i.lf ? 'crlf' : 'lf', mixed: i.crlf > 0 && i.lf > 0, crlf: i.crlf, lf: i.lf }
}

/**
 * 要写到磁盘的文本：先按原文件补末尾换行（原文件以换行结尾就保持这个习惯，
 * 否则用户在最后那个空行里接着打字会丢掉末尾换行，cat 会和下一行粘在一起），再按选定的换行符替换。
 */
export function buildDiskText(text: string, o: { finalNewline: boolean; eol: Eol }): string {
  const withNl = o.finalNewline && text !== '' && !text.endsWith('\n') ? `${text}\n` : text
  return o.eol === 'crlf' ? withNl.replace(/\n/g, '\r\n') : withNl
}

/**
 * 有没有未保存的改动。两个判据缺一不可：
 *  ① 内容不同（比较时统一成 LF：只差换行符不算改动，否则打开就显示「有改动」、切不回查看）
 *  ② 换行符选择变了 —— 手动切 LF/CRLF 本身就是要保存的改动，只比内容会把保存按钮变灰
 */
export function isDirty(o: { base?: string; text: string; eol: Eol; baseEol: Eol }): boolean {
  if (o.base === undefined) return false
  const same = normalizeEolText(buildDiskText(o.text, { finalNewline: o.base.endsWith('\n'), eol: o.eol })) === normalizeEolText(o.base)
  return !same || o.eol !== o.baseEol
}

/** 丢弃改动：编辑区回到磁盘内容，换行符也回到磁盘那边（三步必须一起做，漏一步 dirty 就清不掉） */
export function discardedText(base: string): string { return normalizeEolText(base) }
