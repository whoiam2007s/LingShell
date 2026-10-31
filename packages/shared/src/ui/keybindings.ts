// 快捷键注册表：所有应用快捷键的唯一来源（按键处理、终端放行、设置页、帮助、命令面板都读这里）。
// 按键串规范形如 `Ctrl+Alt+Shift+Meta+键`（修饰键顺序固定），键名由 KeyboardEvent.code 归一（不受输入法 / 键盘布局 / Shift 影响）。
// 用户覆盖存 SystemSettings.keybindings：只存改过的，值为新按键串，null = 未设置。
import { tk, tr } from '../i18n/i18n.js'

export type KeyGroup = 'terminal' | 'tabs' | 'panels' | 'app' | 'chat'
/** global = 任何时候（终端有焦点也拦下、不发给 shell）；terminal = 焦点在终端时；outside = 焦点不在终端时（终端里交给 shell） */
export type KeyScope = 'global' | 'terminal' | 'outside'

export interface KeyAction {
  id: string
  name: string           // 动作名（短）
  group: KeyGroup
  keys: string           // 默认按键（可改项为规范按键串；不可改项为展示文字）
  desc: string           // 完整说明（进问号 tip / 帮助）
  scope: KeyScope
  editable: boolean      // 鼠标操作、补全浮层内的键等只展示不可改
}

export const KEY_GROUPS: { id: KeyGroup; label: string }[] = [
  { id: 'terminal', label: tk('终端') },
  { id: 'tabs', label: tk('标签与分屏') },
  { id: 'panels', label: tk('面板与窗口') },
  { id: 'app', label: tk('应用') },
  { id: 'chat', label: tk('AI 对话') },
]
export const KEY_SCOPE_LABEL: Record<KeyScope, string> = { global: tk('全局（终端有焦点也生效）'), terminal: tk('焦点在终端时'), outside: tk('焦点不在终端时') }

const A = (id: string, name: string, group: KeyGroup, keys: string, scope: KeyScope, desc: string, editable = true): KeyAction => ({ id, name, group, keys, scope, desc, editable })

export const KEY_ACTIONS: KeyAction[] = [
  // 终端
  A('term.find', tk('终端内搜索'), 'terminal', 'Ctrl+F', 'terminal', tk('在当前终端的输出里搜索；选中了单行文字时自动填入。和对话区的「会话内搜索」共用 Ctrl+F：焦点在哪边就搜哪边。代价是终端程序收不到 Ctrl+F（vim / less 下翻页改用 PageDown 或空格，readline 光标右移用 →）；需要时可改回 Ctrl+Shift+F。')),
  A('term.prevCmd', tk('上一条命令'), 'terminal', 'Ctrl+Up', 'terminal', tk('滚到上一条命令的提示符处（bash 终端行首的绿 / 红点标出每条命令成败）。同 VS Code 终端。')),
  A('term.nextCmd', tk('下一条命令'), 'terminal', 'Ctrl+Down', 'terminal', tk('滚到下一条命令的提示符处。同 VS Code 终端。')),
  A('term.nl', tk('自然语言写命令'), 'terminal', 'Ctrl+I', 'terminal', tk('在光标处输入描述，AI 生成一条命令填进提示符（不回车，需提示符为空）。同 VS Code 终端的内联 AI（Ctrl+I）；Tab 键补全不受影响。')),
  A('term.fontUp', tk('放大字号'), 'terminal', 'Ctrl+=', 'terminal', tk('终端字号加 1（小键盘 + 同效），改动会保存。')),
  A('term.fontDown', tk('缩小字号'), 'terminal', 'Ctrl+-', 'terminal', tk('终端字号减 1（小键盘 - 同效）。')),
  A('term.fontReset', tk('重置字号'), 'terminal', 'Ctrl+0', 'terminal', tk('终端字号恢复默认。')),
  A('term.quickSelect', tk('快速选择'), 'terminal', 'Alt+S', 'terminal', tk('屏幕上的 IP、URL、路径、哈希 / 容器 ID、端口、PID 等标上字母，按字母复制，按大写字母（Shift+字母）复制并粘贴到提示符，Esc 退出。同 WezTerm Quick Select。')),
  A('term.replay', tk('即时回放'), 'terminal', 'Ctrl+Alt+R', 'terminal', tk('打开本终端最近一段输出的回放，拖时间轴回看任意时刻的屏幕（含被 clear / top / vim 刷掉的画面），Esc 退出。同 iTerm2 Instant Replay；缓冲大小在 设置 → 终端 调。没用 Ctrl+Shift+R：开发版 Electron 默认菜单把它当「强制重新加载」。')),
  A('term.compose', tk('撰写栏'), 'terminal', 'Alt+C', 'global',tk('开 / 关终端底部的多行输入框，写好再发到当前 / 广播组 / 全部终端（终端里这个键不再发给 shell）。')),
  A('term.cmdMark', tk('命令标记菜单'), 'terminal', tk('点行首绿 / 红点'), 'terminal', tk('复制命令 / 复制输出 / 重新执行 / 问 AI / 存为快速命令 / 加入运维手册。'), false),
  A('term.link', tk('打开链接'), 'terminal', tk('Ctrl+点击'), 'terminal', tk('按住 Ctrl 点击终端里的 http / https 链接，用系统浏览器打开。'), false),
  A('term.compNav', tk('补全：选择'), 'terminal', '↑ / ↓', 'terminal', tk('命令补全浮层开着时选择候选。'), false),
  A('term.compAccept', tk('补全：接受'), 'terminal', 'Tab / →', 'terminal', tk('命令补全浮层开着时接受选中的候选。'), false),
  A('term.compClose', tk('补全：关闭'), 'terminal', 'Esc', 'terminal', tk('关闭命令补全浮层。'), false),
  A('term.compDelete', tk('补全：删历史'), 'terminal', 'Shift+Delete', 'terminal', tk('从历史里删掉选中的补全候选。'), false),
  // 标签与分屏
  A('tab.new', tk('新建本地终端'), 'tabs', 'Ctrl+Shift+T', 'global', tk('新开一个本地终端标签。')),
  A('tab.close', tk('关闭当前终端'), 'tabs', 'Ctrl+Shift+W', 'global', tk('关闭当前终端标签。')),
  A('tab.duplicate', tk('复制当前会话'), 'tabs', 'Ctrl+Shift+D', 'global', tk('同主机 / 同目录再开一个终端（标签右键菜单另有改色、重命名）。')),
  A('tab.next', tk('下一个标签'), 'tabs', 'Ctrl+Tab', 'global', tk('切到下一个终端标签。')),
  A('tab.prev', tk('上一个标签'), 'tabs', 'Ctrl+Shift+Tab', 'global', tk('切到上一个终端标签。')),
  A('tab.broadcast', tk('广播输入'), 'tabs', 'Ctrl+Shift+B', 'global', tk('开 / 关多终端广播输入。')),
  A('pane.left', tk('焦点移到左窗格'), 'tabs', 'Alt+Left', 'global', tk('分屏时焦点移到左边的窗格。同 Windows Terminal / VS Code 终端（Alt+方向键）。')),
  A('pane.right', tk('焦点移到右窗格'), 'tabs', 'Alt+Right', 'global', tk('分屏时焦点移到右边的窗格。')),
  A('pane.up', tk('焦点移到上窗格'), 'tabs', 'Alt+Up', 'global', tk('分屏时焦点移到上边的窗格。')),
  A('pane.down', tk('焦点移到下窗格'), 'tabs', 'Alt+Down', 'global', tk('分屏时焦点移到下边的窗格。')),
  // 面板与窗口
  A('palette', tk('命令面板'), 'panels', 'Ctrl+Shift+P', 'global', tk('搜主机 / 会话 / 手册 / 快速命令 / 模板 / 设置 / 动作。前缀 > 动作、@ 主机、# 会话、? 帮助。')),
  A('palette.alt', tk('命令面板（备用）'), 'panels', 'Ctrl+K', 'outside', tk('同命令面板。终端里 Ctrl+K 留给 shell 删到行尾，所以只在焦点不在终端时生效。')),
  A('help', tk('使用帮助'), 'panels', 'F1', 'outside', tk('打开使用帮助（标题栏 ? 按钮同效）。终端里 F1 留给 mc / htop 等程序。')),
  A('settings', tk('设置'), 'panels', 'Ctrl+,', 'global', tk('打开设置。同 VS Code。')),
  A('focus.chat', tk('聚焦对话输入框'), 'panels', 'Ctrl+Alt+I', 'global', tk('光标跳到左侧 AI 对话的输入框。同 VS Code 打开 Chat（Ctrl+Alt+I）。')),
  A('focus.terminal', tk('聚焦终端'), 'panels', 'Ctrl+`', 'global', tk('光标跳回右侧当前终端。同 VS Code（Ctrl+`）。')),
  A('explorer', tk('资源管理器'), 'panels', 'Ctrl+Shift+E', 'global', tk('开 / 关当前终端的资源管理器（右侧活动栏同名按钮同效）。同 VS Code（Ctrl+Shift+E）。')),
  A('hostPanel', tk('主机面板'), 'panels', 'Ctrl+Shift+H', 'global', tk('开 / 关主机面板：收藏、最近连接、分组、延迟、工作区（标题栏「主机」按钮同效）。')),
  // 应用
  A('app.lock', tk('锁定应用'), 'app', 'Ctrl+Shift+L', 'global', tk('立即锁定应用（需先在「设置 → AI 与安全」里启用应用锁；标题栏的锁按钮同效）。未启用应用锁时这个键照常交给终端。')),
  A('app.zoomIn', tk('放大界面'), 'app', 'Ctrl+Shift+=', 'global', tk('整个界面放大一档（文字、图标、间距一起，80%–150%），改动会保存（设置 → 通用 → 外观 同项）。VS Code 放大视图是 Ctrl+=，这里 Ctrl+= 留给终端字号，所以加 Shift。')),
  A('app.zoomOut', tk('缩小界面'), 'app', 'Ctrl+Shift+-', 'global', tk('整个界面缩小一档。')),
  A('app.zoomReset', tk('界面缩放复位'), 'app', 'Ctrl+Alt+0', 'global', tk('界面缩放恢复 100%。没用 Ctrl+Shift+0：Windows 默认把它留给切换输入法 / 键盘布局，按键到不了应用。')),
  // AI 对话（焦点在对话区时；与终端里同键的「上一条 / 下一条命令」、shell 的 Ctrl+F 互不干扰）
  A('chat.prevMsg', tk('上一条提问'), 'chat', 'Ctrl+Up', 'outside', tk('对话区里跳到上一条「我的提问」（跳过工具步骤）。终端里同一个键是「上一条命令」。')),
  A('chat.nextMsg', tk('下一条提问'), 'chat', 'Ctrl+Down', 'outside', tk('对话区里跳到下一条「我的提问」。')),
  A('chat.find', tk('会话内搜索'), 'chat', 'Ctrl+F', 'outside', tk('焦点在对话区时打开会话内搜索条：高亮命中，Enter / Shift+Enter 下一个 / 上一个，Esc 关闭。终端里 Ctrl+F 照常给 shell。')),
]
/** 两个作用范围会不会同时生效：global 与谁都重叠；terminal（焦点在终端）与 outside（焦点不在终端）互斥，可以用同一个键 */
export const scopesOverlap = (a: KeyScope, b: KeyScope) => a === 'global' || b === 'global' || a === b
export const KEY_ACTION_BY_ID: Record<string, KeyAction> = Object.fromEntries(KEY_ACTIONS.map((a) => [a.id, a]))

export type KeybindingOverrides = Record<string, string | null>
/** 生效的按键：id → 按键串（null = 未设置）。只含可改项 */
export type Keybindings = Record<string, string | null>

// KeyboardEvent.code → 键名。小键盘 + / - / 数字归到主键盘同名键（原先 Ctrl+小键盘+ 也能放大字号）
const CODE_ALIAS: Record<string, string> = {
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
  NumpadAdd: '=', NumpadSubtract: '-', NumpadEnter: 'Enter', NumpadMultiply: '*', NumpadDivide: '/', NumpadDecimal: '.',
}
const MODIFIER_CODES = new Set(['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'CapsLock', 'OSLeft', 'OSRight'])
const KNOWN_KEYS = new Set(['Tab', 'Enter', 'Space', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'Escape', '*', ...Object.values(CODE_ALIAS)])

/** code → 键名；不认识 / 纯修饰键返回 null */
export function keyNameOfCode(code: string): string | null {
  if (MODIFIER_CODES.has(code)) return null
  let m = /^Key([A-Z])$/.exec(code) ?? /^Digit(\d)$/.exec(code) ?? /^Numpad(\d)$/.exec(code)
  if (m) return m[1]
  m = /^F([1-9]|1\d|2[0-4])$/.exec(code)
  if (m) return code
  if (CODE_ALIAS[code]) return CODE_ALIAS[code]
  return KNOWN_KEYS.has(code) ? code : null
}

export interface KeyEventLike { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }
/** 键盘事件 → 规范按键串；纯修饰键 / 不认识的键返回 null */
export function keyOfEvent(e: KeyEventLike): string | null {
  const k = keyNameOfCode(e.code)
  if (!k) return null
  return [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Meta', k].filter(Boolean).join('+')
}

export interface ParsedKey { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean; key: string }
/** 解析按键串（容忍大小写、空格、修饰键乱序；Control/Cmd 等别名）；不合法返回 null */
export function parseKey(s: string): ParsedKey | null {
  const parts = s.split('+').map((p) => p.trim()).filter(Boolean)
  if (!parts.length) return null
  const r: ParsedKey = { ctrl: false, alt: false, shift: false, meta: false, key: '' }
  for (const [i, raw] of parts.entries()) {
    const p = raw.toLowerCase()
    if (i < parts.length - 1) {
      if (p === 'ctrl' || p === 'control') r.ctrl = true
      else if (p === 'alt' || p === 'option') r.alt = true
      else if (p === 'shift') r.shift = true
      else if (p === 'meta' || p === 'cmd' || p === 'win' || p === 'super') r.meta = true
      else return null
      continue
    }
    const k = raw.length === 1 ? raw.toUpperCase() : [...KNOWN_KEYS].find((x) => x.toLowerCase() === p) ?? (/^f([1-9]|1\d|2[0-4])$/.test(p) ? p.toUpperCase() : '')
    if (!k || !(/^[A-Z0-9]$/.test(k) || /^F\d+$/.test(k) || KNOWN_KEYS.has(k))) return null
    r.key = k
  }
  return r.key ? r : null
}
/** 规范化按键串；不合法返回 null */
export function normalizeKey(s: string): string | null {
  const p = parseKey(s)
  if (!p) return null
  return [p.ctrl && 'Ctrl', p.alt && 'Alt', p.shift && 'Shift', p.meta && 'Meta', p.key].filter(Boolean).join('+')
}

const KEY_DISPLAY: Record<string, string> = { Up: '↑', Down: '↓', Left: '←', Right: '→', Escape: 'Esc', Delete: 'Del', Backspace: '⌫' }
/** 键帽分块：'Ctrl+Shift+Up' → ['Ctrl', 'Shift', '↑'] */
export function keyParts(s: string): string[] {
  const n = normalizeKey(s)
  if (!n) return [s]
  return n.split('+').map((p, i, a) => (i === a.length - 1 ? KEY_DISPLAY[p] ?? p : p))
}
/** 展示用文字：'Ctrl+Shift+↑' */
export const formatKey = (s: string | null | undefined) => (s ? keyParts(s).join('+') : tr('未设置'))

/** 合并默认与用户覆盖（覆盖里的未知 id / 非法按键串忽略） */
export function resolveKeybindings(overrides?: KeybindingOverrides | null): Keybindings {
  const r: Keybindings = {}
  for (const a of KEY_ACTIONS) {
    if (!a.editable) continue
    const o = overrides && Object.prototype.hasOwnProperty.call(overrides, a.id) ? overrides[a.id] : undefined
    r[a.id] = o === null ? null : (typeof o === 'string' && normalizeKey(o)) || a.keys
  }
  return r
}
/** 精简覆盖：去掉未知 id、非法值、与默认相同的项（只存改过的） */
export function cleanOverrides(overrides?: KeybindingOverrides | null): KeybindingOverrides {
  const r: KeybindingOverrides = {}
  for (const [id, v] of Object.entries(overrides ?? {})) {
    const a = KEY_ACTION_BY_ID[id]
    if (!a?.editable) continue
    if (v === null) { r[id] = null; continue }
    const n = typeof v === 'string' ? normalizeKey(v) : null
    if (n && n !== a.keys) r[id] = n
  }
  return r
}

/** 按键 → 动作 id 的反查表（未设置的不进） */
export function keymapOf(b: Keybindings): Map<string, string> {
  const m = new Map<string, string>()
  for (const [id, k] of Object.entries(b)) if (k && !m.has(k)) m.set(k, id)
  return m
}
/** 按键 → 绑定它的全部动作 id（同键可分给作用范围互斥的动作，如终端里 / 终端外各一个） */
export function keymapsOf(b: Keybindings): Map<string, string[]> {
  const m = new Map<string, string[]>()
  for (const [id, k] of Object.entries(b)) if (k) m.set(k, [...(m.get(k) ?? []), id])
  return m
}
/** 同键多个动作时按焦点挑：焦点在终端 → 非 outside 的；不在终端 → 非 terminal 的 */
export function pickAction(ids: string[] | undefined, inTerminal: boolean): string | null {
  if (!ids?.length) return null
  return ids.find((id) => { const s = KEY_ACTION_BY_ID[id]?.scope; return inTerminal ? s !== 'outside' : s !== 'terminal' }) ?? ids[0]
}

/** 校验录到的按键：须含 Ctrl / Alt / Meta，或是 F1–F12。合法返回 null，否则返回原因 */
export function validateKey(s: string): string | null {
  const p = parseKey(s)
  if (!p) return tr('无法识别的按键')
  if (/^F([1-9]|1[0-2])$/.test(p.key)) return null
  if (!p.ctrl && !p.alt && !p.meta) return tr('需要带 Ctrl / Alt 等修饰键，或使用 F1–F12')
  return null
}

/** 与其它可改项的冲突（同键且作用范围会同时生效）：返回对方 id */
export function findConflicts(id: string, key: string, b: Keybindings): string[] {
  const n = normalizeKey(key)
  if (!n) return []
  const s = KEY_ACTION_BY_ID[id]?.scope ?? 'global'
  return Object.keys(b).filter((x) => x !== id && b[x] === n && scopesOverlap(s, KEY_ACTION_BY_ID[x]?.scope ?? 'global'))
}
/** 兼容旧调用：只取第一个冲突 */
export function findConflict(id: string, key: string, b: Keybindings): string | null {
  return findConflicts(id, key, b)[0] ?? null
}

// 终端常用键：Ctrl+字母都是控制字符（Ctrl+C 中断、Ctrl+D 退出、Ctrl+Z 挂起、Ctrl+R 搜历史、Ctrl+A/E 行首行尾、Ctrl+U/W/K 删除…），
// Alt+B/F/D/. 是 readline 按词移动 / 删除 / 取上条参数，Ctrl+V / Ctrl+Shift+C/V 是复制粘贴
// 全部 Ctrl+字母都是控制字符（含 Ctrl+S 流控暂停 / Ctrl+Q 恢复 / Ctrl+O / Ctrl+J / Ctrl+M / Ctrl+I），一个都不能漏
const SHELL_KEYS = new Set([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((c) => `Ctrl+${c}`).concat(['Alt+B', 'Alt+F', 'Alt+D', 'Alt+.', 'Ctrl+Shift+C', 'Ctrl+Shift+V', 'Ctrl+[', 'Ctrl+\\', 'Ctrl+Space']))
/** 占用终端常用键时返回该键的展示文字（用于警告）；不占用返回 null */
export function shellKeyConflict(key: string): string | null {
  const n = normalizeKey(key)
  return n && SHELL_KEYS.has(n) ? formatKey(n) : null
}
