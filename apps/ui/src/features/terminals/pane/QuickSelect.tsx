// 快速选择（同 WezTerm Quick Select，默认 Alt+S；WezTerm 的 Ctrl+Shift+Space 会被中文输入法吞掉）：可见区域里的 IP / URL / 路径 / 哈希 / 端口 / 数字标上字母提示，
// 按字母复制，大写（Shift+字母）复制并粘贴到提示符，Esc / 其它键 / 点鼠标退出。匹配规则与字母分配在 shared/terminal/quickSelect.ts
import { useEffect, useRef, useState } from 'react'
import type { Terminal } from '@xterm/xterm'
import { assignHints, findQuickSelect, hintOrder, matchHint, stripEndMarks, tr } from '@lingshell/shared'

/** 一个候选在终端区域里的位置（相对定位容器）、提示字母与要复制的文本 */
export interface QsItem { left: number; top: number; width: number; height: number; hint: string; text: string }

/** 读当前可见的每一行（按单元格拼，宽字符只算一个字符），找候选并换算成像素位置 */
export function collectQuickSelect(term: Terminal, el: HTMLElement, box: HTMLElement): QsItem[] {
  const scr = el.querySelector('.xterm-screen')?.getBoundingClientRect(), bx = box.getBoundingClientRect()
  if (!scr) return []
  const cw = scr.width / term.cols, ch = scr.height / term.rows, b = term.buffer.active
  const lines: string[] = [], maps: number[][] = []   // maps[r][i] = 第 r 行第 i 个字符所在的列；末尾多一项 = 行尾列
  for (let r = 0; r < term.rows; r++) {
    const line = b.getLine(b.viewportY + r)
    let s = ''; const map: number[] = []; let x = 0
    for (; line && x < term.cols; ) {
      const c = line.getCell(x)
      if (!c) break
      const w = c.getWidth()
      if (w === 0) { x++; continue }   // 宽字符的后半格
      const chars = c.getChars() || ' '
      for (let i = 0; i < chars.length; i++) map.push(x)
      s += chars; x += w
    }
    map.push(x)
    lines.push(stripEndMarks(s, true)); maps.push(map)   // AI 命令的隐藏结束标记换成等长空格：别把里面的 id 当哈希标出来
  }
  const ms = findQuickSelect(lines)
  const order = hintOrder(ms), hints = assignHints(ms.length)
  return order.slice(0, hints.length).map((i, k) => {
    const m = ms[i], map = maps[m.row]
    const x1 = map[m.start], x2 = map[m.end] ?? map.at(-1)!
    return { left: scr.left - bx.left + x1 * cw, top: scr.top - bx.top + m.row * ch, width: Math.max(1, x2 - x1) * cw, height: ch, hint: hints[k], text: m.text }
  })
}

export function QuickSelectOverlay({ items, onPick, onExit }: { items: QsItem[]; onPick: (it: QsItem, paste: boolean) => void; onExit: () => void }) {
  const [typed, setTyped] = useState('')
  const cb = useRef({ onPick, onExit }); cb.current = { onPick, onExit }   // 父组件重渲染不重挂监听（已键入的前缀不丢）
  useEffect(() => {
    const onPick = (it: QsItem, paste: boolean) => cb.current.onPick(it, paste), onExit = () => cb.current.onExit()
    const hints = items.map((x) => x.hint)
    let buf = ''
    // 捕获阶段截下所有按键（别漏给 xterm / 应用快捷键）。按 code 取字母：中文输入法开着也能用
    const onKey = (e: KeyboardEvent) => {
      if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return
      e.preventDefault(); e.stopPropagation()
      const m = /^Key([A-Z])$/.exec(e.code)
      if (!m || e.ctrlKey || e.altKey || e.metaKey) { onExit(); return }
      buf += m[1].toLowerCase()
      const hit = matchHint(buf, hints)
      if (hit === 'more') { setTyped(buf); return }
      if (hit === null) { onExit(); return }
      onPick(items[hit], e.shiftKey)
    }
    const onDown = () => onExit()
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousedown', onDown, true)
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('mousedown', onDown, true) }
  }, [items])
  return (
    <div data-quick-select className="pointer-events-none absolute inset-0 z-30">
      {items.map((it) => {
        const dim = typed && !it.hint.startsWith(typed)
        return (
          <div key={it.hint} style={{ left: it.left, top: it.top, width: it.width, height: it.height }}
            className={`absolute rounded-sm bg-[color:color-mix(in_srgb,var(--color-accent)_22%,transparent)] ring-1 ring-[color:color-mix(in_srgb,var(--color-accent)_60%,transparent)] ${dim ? 'opacity-25' : ''}`}>
            <span data-qs-hint={it.hint} className="absolute -top-[1px] left-0 -translate-x-[2px] rounded-[3px] bg-[var(--color-warn)] px-[3px] font-mono text-[11px] font-bold leading-[14px] text-[var(--color-bg-base)] shadow">
              {typed && it.hint.startsWith(typed) ? <><span className="opacity-50">{typed}</span>{it.hint.slice(typed.length)}</> : it.hint}
            </span>
          </div>
        )
      })}
      <div className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] px-2 py-1 text-[11px] text-[var(--color-text-secondary)] shadow-lg">
        {tr('快速选择：按字母复制 · Shift+字母 复制并粘贴 · Esc 退出')}
      </div>
    </div>
  )
}
