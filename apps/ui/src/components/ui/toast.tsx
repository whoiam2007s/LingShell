import { useEffect, useReducer } from 'react'
import { createPortal } from 'react-dom'
import { Check, X } from 'lucide-react'

type Item = { id: number; text: string; ok: boolean }
let items: Item[] = []
const subs = new Set<() => void>()
const emit = () => { for (const s of subs) s() }

/**
 * 全局轻提示：任何模块直接调 toast('已导入 3 项')。
 * 渲染 portal 到 body、固定右上角，所以弹窗关掉后提示仍然显示，也不会挡住弹窗内容。
 */
export function toast(text: string, ok = true): void {
  const id = Date.now() + Math.random()
  items = [...items, { id, text, ok }]
  emit()
  setTimeout(() => {
    items = items.filter((i) => i.id !== id)
    emit()
  }, 4000)
}

/** 挂在常驻组件里一次即可（目前挂在设置 → 列表页的导入按钮旁） */
export function ToastHost() {
  const [, force] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    subs.add(force)
    return () => { subs.delete(force) }
  }, [])
  if (!items.length) return null
  return createPortal(
    <div className="pointer-events-none fixed right-6 top-6 z-[100] flex flex-col gap-2">
      {items.map((i) => (
        <div key={i.id}
          className={`flex items-center gap-2 rounded-md px-3.5 py-2 text-[12.5px] text-white shadow-xl ${i.ok ? 'bg-[var(--color-success)]' : 'bg-[var(--color-danger)]'}`}>
          {i.ok ? <Check className="h-3.5 w-3.5 shrink-0" /> : <X className="h-3.5 w-3.5 shrink-0" />}{i.text}
        </div>
      ))}
    </div>,
    document.body,
  )
}
