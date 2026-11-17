// 对话输入框的容量控制（纯逻辑，UI 与主进程共用）。
//
// 为什么必须有：用户粘贴 6MB 文本曾把界面卡死——受控 textarea 每次变更都重渲染整条对话，
// 自动增高还要对几 MB 文本做布局计算。光靠 maxLength 不行（浏览器会先把内容插进 DOM 再裁剪），
// 所以粘贴必须在 onPaste 里先截断。

/** 一条消息最多多少字（键入、粘贴、模板填入都受这个限制） */
export const INPUT_MAX = 5000

export interface InsertResult {
  /** 插入后的完整文本 */
  value: string
  /** 插入后光标应该落在哪（1 起 = 文本下标） */
  caret: number
  /** 实际插入了多少个字 */
  kept: number
  /** 被截掉多少个字（0 = 没截断） */
  cut: number
}

/**
 * 把 insert 文本按剩余额度塞进 current 里（替换 [selStart, selEnd) 选区）。
 * 超出 INPUT_MAX 的部分直接丢弃——不报错、不弹窗，UI 只提示截了多少。
 */
export function insertCapped(current: string, insert: string, selStart?: number, selEnd?: number, max = INPUT_MAX): InsertResult {
  const len = current.length
  const start = Math.max(0, Math.min(selStart ?? len, len))
  const end = Math.max(start, Math.min(selEnd ?? len, len))
  const room = Math.max(0, max - (len - (end - start)))
  const take = String(insert ?? '').slice(0, room)
  return {
    value: current.slice(0, start) + take + current.slice(end),
    caret: start + take.length,
    kept: take.length,
    cut: Math.max(0, String(insert ?? '').length - take.length),
  }
}

/** 直接按上限裁剪一段文本（模板 / 摘要 / 命令带入时用） */
export function capInput(text: string, max = INPUT_MAX): InsertResult {
  const s = String(text ?? '')
  const take = s.slice(0, max)
  return { value: take, caret: take.length, kept: take.length, cut: s.length - take.length }
}

/** 超过上限了吗（主进程发消息前兜底用） */
export const tooLong = (text: string, max = INPUT_MAX): boolean => String(text ?? '').length > max
