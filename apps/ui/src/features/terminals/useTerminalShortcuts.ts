import { useEffect, useRef } from 'react'
import { changeFontSize, getTermPrefs } from '../../lib/termPrefs.js'
import { DEFAULT_SYSTEM_SETTINGS, type PaneDir } from '@lingshell/shared'
import { actionOf, inTerminal } from '../../lib/keybindings.js'

const NO_REPEAT = new Set(['tab.new', 'tab.close', 'tab.broadcast', 'tab.duplicate', 'term.compose', 'explorer'])   // 长按不连发建/关终端、开关广播 / 撰写栏

// 终端区快捷键：window 冒泡阶段监听，按键由快捷键注册表 + 用户覆盖决定（见 lib/keybindings.ts）。
// 终端里的按键经 TerminalPane 的 attachCustomKeyEventHandler 放过（不发给 shell）后冒泡到这里。
// 字号三键只在焦点在终端时生效，其它输入框里保持原生行为。preventDefault 同时拦住 Electron 默认菜单的缩放加速键（Ctrl+-/Ctrl+0）。
// 命令面板 / 帮助 / 主机面板 / 锁定由 App 处理；搜索 / 跳命令 / 自然语言写命令由 TerminalPane 处理。
export function useTerminalShortcuts(h: { newTerm: () => void; closeTerm: () => void; cycle: (d: 1 | -1) => void; broadcast?: () => void; duplicate?: () => void; pane?: (d: PaneDir) => void; compose?: () => void; explorer?: () => void }) {
  const ref = useRef(h)
  ref.current = h
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const a = actionOf(e)
      if (!a || !(a.startsWith('tab.') || a.startsWith('pane.') || a.startsWith('term.font') || a === 'term.compose' || a === 'explorer')) return
      // 有弹窗开着（设置、确认框、授权/指纹弹窗…都是全屏 fixed inset-0 遮罩）时不响应：
      // 否则在设置里按 Ctrl+Shift+W 会把背后的终端关掉
      if (document.querySelector('.fixed.inset-0')) return
      if (a.startsWith('term.font') && !inTerminal(e.target)) return
      e.preventDefault()
      if (e.repeat && NO_REPEAT.has(a)) return
      const fs = getTermPrefs().fontSize
      if (a === 'term.compose') ref.current.compose?.()
      else if (a === 'explorer') ref.current.explorer?.()
      else if (a.startsWith('pane.')) ref.current.pane?.(a.slice(5) as PaneDir)
      else if (a === 'tab.broadcast') ref.current.broadcast?.()
      else if (a === 'tab.duplicate') ref.current.duplicate?.()
      else if (a === 'tab.new') ref.current.newTerm()
      else if (a === 'tab.close') ref.current.closeTerm()
      else if (a === 'tab.next') ref.current.cycle(1)
      else if (a === 'tab.prev') ref.current.cycle(-1)
      else if (a === 'term.fontUp') changeFontSize(fs + 1)
      else if (a === 'term.fontDown') changeFontSize(fs - 1)
      else if (a === 'term.fontReset') changeFontSize(DEFAULT_SYSTEM_SETTINGS.terminalFontSize)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
