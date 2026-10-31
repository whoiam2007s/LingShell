// 文案里嵌组件（链接、按键、加粗……）：trx('点 {btn} 保存', { btn: <Kbd>Enter</Kbd> })
// 译文里组件的位置可以和中文不同（英文语序不一样），所以整句做键，组件用占位符
import { Fragment, type ReactNode } from 'react'
import { trParts } from '@lingshell/shared'

export function trx(key: string, parts: Record<string, ReactNode>, params?: Record<string, string | number>): ReactNode {
  return trParts(key, parts, params).map((p, i) => <Fragment key={i}>{p}</Fragment>)
}
