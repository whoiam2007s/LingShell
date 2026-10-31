import { useEffect, useRef, useState } from 'react'
import { Settings, Minus, Square, Copy, X, Lock, Search, CircleHelp, Server, BarChart3, LayoutDashboard, Sun, Moon, Check, Monitor } from 'lucide-react'
import { UI_THEMES, kindOf, themeLabel, tr, type UiTheme } from '@lingshell/shared'
import { saveLook, useLook } from '../../lib/appearance.js'
import { Logo } from '../../components/Logo'
import { client } from '../../client/index.js'
import { keyHint, keyLabel, useKeybindings } from '../../lib/keybindings.js'

// 访问 preload 暴露的窗口控制 API
interface WindowAPI {
  minimize: () => Promise<void>
  toggleMaximize: () => Promise<boolean>
  close: () => Promise<void>
  isMaximized: () => Promise<boolean>
  platform: () => Promise<string>
  onMaximizedChange: (h: (m: boolean) => void) => () => void
}
function winApi(): WindowAPI | undefined {
  return (window as unknown as { electronAPI?: { window?: WindowAPI } }).electronAPI?.window
}

// onOpenSettings 不传 = 不显示设置按钮（锁屏上用）
// onToggleHosts：主机面板开关（锁屏上不传 = 不显示）；onOpenUsage：用量统计弹窗（同上）
export function TitleBar({ onOpenSettings, onOpenPalette, onOpenHelp, onOpenUsage, onToggleHosts, hostsOpen, onOpenDashboard }: { onOpenSettings?: () => void; onOpenPalette?: () => void; onOpenHelp?: () => void; onOpenUsage?: () => void; onToggleHosts?: () => void; hostsOpen?: boolean; onOpenDashboard?: () => void }) {
  const [platform, setPlatform] = useState<string>('win32')
  const [maximized, setMaximized] = useState(false)
  useKeybindings()   // 按钮 title 里的快捷键随自定义即时更新

  useEffect(() => {
    const api = winApi()
    api?.platform().then(setPlatform)
    api?.isMaximized().then(setMaximized)
    const off = api?.onMaximizedChange(setMaximized)
    return off
  }, [])

  // 启用了应用锁才显示锁按钮。启用/关闭在设置里做，没有事件：窗口重新获得焦点、鼠标移进标题栏时重查一次
  const [lockOn, setLockOn] = useState(false)
  const refreshLock = () => { client.lock.status().then((s) => setLockOn(s.enabled)).catch(() => {}) }
  useEffect(() => {
    refreshLock()
    window.addEventListener('focus', refreshLock)
    return () => window.removeEventListener('focus', refreshLock)
  }, [])

  const isMac = platform === 'darwin'

  return (
    <header
      onMouseEnter={refreshLock}
      className="flex h-9 shrink-0 select-none items-center justify-between border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)]"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* 左：mac 给红绿灯留位（hiddenInset 系统画红绿灯，这里留 ~70px 空白）+ logo */}
      <div className="flex items-center gap-2 px-3" style={{ paddingLeft: isMac ? 78 : 12 }}>
        <Logo shape="bare" className="h-[18px] w-[18px]" />
        <span className="text-[13px] font-semibold tracking-tight">灵壳 LingShell</span>{/* i18n-ignore 品牌名 */}
        {/* 主机面板入口：贴着 logo，浮层就在它正下方展开 */}
        {onToggleHosts && (
          <button data-host-panel-toggle onClick={onToggleHosts} title={tr('主机与工作区') + keyHint('hostPanel')} style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            className={`ml-2 flex h-6 items-center gap-1 rounded-md px-2 text-[12px] transition-colors hover:bg-[var(--color-bg-hover)] ${hostsOpen ? 'bg-[var(--color-accent-bg)] text-[var(--color-accent)]' : 'text-[var(--color-text-secondary)]'}`}>
            <Server className="h-3.5 w-3.5" />{tr('主机')}
          </button>
        )}
        {onOpenDashboard && (
          <button data-dashboard-open onClick={onOpenDashboard} title={tr('主机仪表盘：所有主机的 CPU / 内存 / 磁盘 / 负载一览')} style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            className="flex h-6 items-center gap-1 rounded-md px-2 text-[12px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)]">
            <LayoutDashboard className="h-3.5 w-3.5" />{tr('仪表盘')}
          </button>
        )}
      </div>

      {/* 中：命令面板入口（不可拖拽） */}
      {onOpenPalette && (
        <button onClick={onOpenPalette} title={tr('命令面板') + keyHint('palette.alt', 'palette')} style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          className="flex h-6 w-[min(320px,30vw)] items-center gap-2 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-2.5 text-[12px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-default)] hover:text-[var(--color-text-secondary)]">
          <Search className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{tr('搜索主机、会话、命令、帮助…')}</span>
          <kbd className="ml-auto shrink-0 text-[10px]">{keyLabel('palette.alt') || 'Ctrl+K'}</kbd>
        </button>
      )}

      {/* 右：设置 + （Windows）窗口控制 —— 这些按钮不可拖拽 */}
      <div className="flex items-center" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        {onOpenSettings && lockOn && <button
          onClick={() => client.lock.lock().catch(() => {})}
          title={tr('立即锁定') + keyHint('app.lock')}
          className="flex h-9 w-10 items-center justify-center text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-secondary)]"
        >
          <Lock className="h-4 w-4" />
        </button>}
        {onOpenUsage && <button
          onClick={onOpenUsage}
          title={tr('用量统计')}
          className="flex h-9 w-10 items-center justify-center text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-secondary)]"
        >
          <BarChart3 className="h-4 w-4" />
        </button>}
        {onOpenSettings && <ThemeToggle />}
        {onOpenHelp && <button
          onClick={onOpenHelp}
          title={tr('使用帮助') + keyHint('help')}
          className="flex h-9 w-10 items-center justify-center text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-secondary)]"
        >
          <CircleHelp className="h-4 w-4" />
        </button>}
        {onOpenSettings && <button
          onClick={onOpenSettings}
          title={tr('设置')}
          className="flex h-9 w-10 items-center justify-center text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-secondary)]"
        >
          <Settings className="h-4 w-4" />
        </button>}

        {!isMac && <WindowsControls maximized={maximized} />}
      </div>
    </header>
  )
}

// 主题下拉：10 套主题 + 跟随系统（带色点，当前项打勾）；详细设置在 设置 → 通用 → 外观
function ThemeToggle() {
  const { look, theme } = useLook()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey, true) }
  }, [open])
  const pick = (t: UiTheme) => { setOpen(false); void saveLook({ uiTheme: t }).catch(() => {}) }
  const item = (t: UiTheme, dot: React.ReactNode) => (
    <button key={t} role="menuitemradio" aria-checked={look.uiTheme === t} data-value={t} onClick={() => pick(t)}
      className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12.5px] hover:bg-[var(--color-bg-hover)] ${look.uiTheme === t ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-primary)]'}`}>
      {dot}<span className="flex-1">{tr(themeLabel(t))}</span>{look.uiTheme === t && <Check className="h-3.5 w-3.5" />}
    </button>
  )
  return (
    <div ref={ref} className="relative">
      <button data-theme-toggle onClick={() => setOpen(!open)} title={tr('切换主题')} aria-haspopup="menu" aria-expanded={open}
        className={`flex h-9 w-10 items-center justify-center transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-secondary)] ${open ? 'bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)]' : 'text-[var(--color-text-muted)]'}`}>
        {kindOf(theme) === 'dark' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
      </button>
      {open && (
        <div role="menu" data-theme-menu className="absolute right-0 top-9 z-[300] w-40 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-raised)] p-1 shadow-lg">
          {UI_THEMES.map((t) => item(t.id, <span className="h-3 w-3 shrink-0 rounded-full border border-[var(--color-border-strong)]" style={{ background: `linear-gradient(135deg, ${t.swatch.bg} 50%, ${t.swatch.accent} 50%)` }} />))}
          <div className="my-1 h-px bg-[var(--color-border-subtle)]" />
          {item('system', <Monitor className="h-3 w-3 shrink-0 text-[var(--color-text-muted)]" />)}
        </div>
      )}
    </div>
  )
}

// Windows 窗口控制按钮（右侧）
function WindowsControls({ maximized }: { maximized: boolean }) {
  const api = winApi()
  return (
    <div className="flex items-center">
      <button
        onClick={() => api?.minimize()}
        className="flex h-9 w-11 items-center justify-center text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]"
        title={tr('最小化')}
      >
        <Minus className="h-4 w-4" />
      </button>
      <button
        onClick={() => api?.toggleMaximize()}
        className="flex h-9 w-11 items-center justify-center text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]"
        title={maximized ? tr('还原') : tr('最大化')}
      >
        {maximized ? <Copy className="h-3.5 w-3.5 -scale-x-100" /> : <Square className="h-3.5 w-3.5" />}
      </button>
      <button
        onClick={() => api?.close()}
        className="flex h-9 w-11 items-center justify-center text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-danger)] hover:text-[var(--color-on-danger)]"
        title={tr('关闭')}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}
