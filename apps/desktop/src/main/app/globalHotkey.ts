// 全局呼出（同 Windows Terminal 的 Quake 模式）：设置 → 通用「连按两下 Alt 呼出」开着时，在后台检测双击 Alt。
// 应用在后台（最小化 / 被别的窗口挡住 / 没焦点）时双击 → 窗口还原、置前、聚焦，UI 把焦点交给当前终端；在前台时双击 → 最小化。
// 应用锁定时照样呼出，但不发聚焦事件：停在锁屏。
// 单按修饰键 globalShortcut 注册不了，这里每 20ms 用 GetAsyncKeyState 读一次键盘状态（koffi 调 user32，不装键盘钩子，
// 不会被杀软当键盘记录器，主进程忙时也不拖慢系统输入）。只支持 Windows。
// 置前：Windows 不让后台进程抢前台（SetForegroundWindow 只会闪任务栏，Electron 的 isFocused 却已经是 true），
// 所以「在不在前台」直接比 GetForegroundWindow，置前时临时 AttachThreadInput 到当前前台线程再 SetForegroundWindow。
import { createRequire } from 'node:module'
import { tr, tk, type AppEvent } from '@lingshell/shared'
import { log } from '../core/index.js'

/** 窗口的最小形状（便于测试注入） */
export interface SummonWindow {
  isVisible(): boolean; isMinimized(): boolean; isFocused(): boolean
  minimize(): void; restore(): void; show(): void; focus(): void
  getNativeWindowHandle?(): Buffer
}
/** 系统级前台判断 / 置前（Windows）；没有时退回 Electron 的 isFocused / focus */
export interface Foreground { isFront(): boolean; bringFront(): void }
/** 读键盘：vk 当前是否按下 */
export type KeyReader = (vk: number) => boolean
export interface GlobalHotkeyDeps {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  win: SummonWindow
  send(ev: AppEvent): void
  enabled(): boolean
  locked(): boolean
  keys?: KeyReader | null   // 测试注入；缺省在 Windows 上用 user32.GetAsyncKeyState，其它系统 null = 不支持
}
export interface GlobalHotkeyStatus { enabled: boolean; key: string | null; registered: boolean; error?: string }
export const SUMMON_KEY = tk('连按两下 Alt')   // 显示处 tr()

/** 双击呼出：前台 → 最小化；否则 → 呼出（未锁定时让 UI 聚焦当前终端） */
export function toggleSummon(win: SummonWindow, locked: boolean, send: (ev: AppEvent) => void, fg?: Foreground | null): 'hidden' | 'shown' {
  if (win.isVisible() && !win.isMinimized() && (fg ? fg.isFront() : win.isFocused())) { win.minimize(); return 'hidden' }
  if (win.isMinimized()) win.restore()
  win.show(); fg?.bringFront(); win.focus()
  if (!locked) send({ type: 'app:summon' })
  return 'shown'
}

/**
 * 双击 Alt 判定（喂采样，返回是否触发）：一次「点按」= Alt 按下到松开不超过 maxHold，期间没按别的键；
 * 第二次按下距第一次松开不超过 gap，且中间没按别的键，第二次松开时触发。Alt+Tab、Ctrl+Alt+… 等组合都不算
 */
export function createDoubleTap(o = { maxHold: 300, gap: 400 }) {
  let prev = false, downAt = 0, dirty = false, lastTap = 0
  return (alt: boolean, other: boolean, now: number): boolean => {
    let fired = false
    if (other) { dirty = true; lastTap = 0 }
    if (alt && !prev) { downAt = now; dirty = other }
    if (!alt && prev) {
      if (dirty || now - downAt > o.maxHold) lastTap = 0
      else if (lastTap && downAt - lastTap <= o.gap) { fired = true; lastTap = 0 }
      else lastTap = now
    }
    prev = alt
    return fired
  }
}

const ALT = new Set([0x12, 0xa4, 0xa5])   // VK_MENU / VK_LMENU / VK_RMENU
const OTHER_KEYS = Array.from({ length: 0xfe - 0x08 + 1 }, (_, i) => i + 0x08).filter((vk) => !ALT.has(vk))   // 跳过鼠标键 0x01–0x06

type Fn = (...a: unknown[]) => unknown
async function winApi(win: SummonWindow): Promise<{ keys: KeyReader; fg: Foreground | null } | null> {
  if (process.platform !== 'win32') return null
  // koffi 是 dsh 会话持久化(jsonl)带进来的 FFI 依赖（原生件已 asarUnpack），从那个包的位置加载，不另加依赖
  const koffi = createRequire(import.meta.resolve('@deepseek-ai/dsh-session-persistence-jsonl'))('koffi') as { load(lib: string): { func(sig: string): Fn } }
  const u = koffi.load('user32.dll'), k = koffi.load('kernel32.dll')
  const getKey = u.func('short __stdcall GetAsyncKeyState(int vKey)') as (vk: number) => number
  const keys: KeyReader = (vk) => (getKey(vk) & 0x8000) !== 0
  const buf = win.getNativeWindowHandle?.()
  if (!buf) return { keys, fg: null }
  const hwnd = buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0))
  const getFg = u.func('intptr_t __stdcall GetForegroundWindow()'), tidOf = u.func('uint32_t __stdcall GetWindowThreadProcessId(intptr_t hWnd, void *pid)')
  const myTid = k.func('uint32_t __stdcall GetCurrentThreadId()'), attach = u.func('bool __stdcall AttachThreadInput(uint32_t a, uint32_t b, bool on)')
  const setFg = u.func('bool __stdcall SetForegroundWindow(intptr_t hWnd)'), toTop = u.func('bool __stdcall BringWindowToTop(intptr_t hWnd)')
  const fg: Foreground = {
    isFront: () => BigInt(getFg() as number | bigint) === hwnd,
    bringFront: () => {
      const front = getFg() as number | bigint, a = tidOf(front, null) as number, b = myTid() as number
      const linked = a !== 0 && a !== b && attach(b, a, true)
      try { toTop(hwnd); setFg(hwnd) } finally { if (linked) attach(b, a, false) }
    },
  }
  return { keys, fg }
}

/** 注册 IPC + 按设置开 / 关检测。返回 apply：系统设置保存后调用 */
export function registerGlobalHotkey(d: GlobalHotkeyDeps): { apply(): GlobalHotkeyStatus; status(): GlobalHotkeyStatus } {
  let st: GlobalHotkeyStatus = { enabled: false, key: tr(SUMMON_KEY), registered: false }
  let timer: ReturnType<typeof setInterval> | null = null
  const apiP = d.keys !== undefined ? Promise.resolve(d.keys && { keys: d.keys, fg: null }) : winApi(d.win).catch((e) => {
    log('warn', 'main', 'globalHotkey', '读键盘接口加载失败', { error: String(e) }); return null   // i18n-ignore 日志
  })
  const start = ({ keys, fg }: { keys: KeyReader; fg: Foreground | null }) => {
    const tap = createDoubleTap()
    let watchUntil = 0   // 只在 Alt 按着及松开后一小段时间里查其它键，平时每次只读一个键
    timer = setInterval(() => {
      const now = Date.now(), alt = keys(0x12)
      if (alt) watchUntil = now + 800
      const other = now < watchUntil && OTHER_KEYS.some(keys)
      if (tap(alt, other, now)) toggleSummon(d.win, d.locked(), d.send, fg)
    }, 20)
  }
  let applied = false
  const apply = (): GlobalHotkeyStatus => {
    // 设置是改了即自动保存的，每次保存都会调到这里：开关没变就不重开检测（免得频繁重置连按状态）
    if (applied && st.enabled === (d.enabled() === true)) return st
    applied = true
    if (timer) { clearInterval(timer); timer = null }
    st = { enabled: d.enabled() === true, key: tr(SUMMON_KEY), registered: false }
    if (!st.enabled) return st
    const s = st
    void apiP.then((api) => {
      if (st !== s) return   // 期间又 apply 过
      if (!api) { s.error = process.platform === 'win32' ? tr('读键盘接口加载失败，见日志') : tr('目前只支持 Windows'); return }
      start(api); s.registered = true
    })
    return st
  }
  d.handle('globalHotkey:status', () => st)
  apply()
  return { apply, status: () => st }
}
