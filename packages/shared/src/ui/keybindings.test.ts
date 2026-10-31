import { describe, it, expect } from 'vitest'
import {
  KEY_ACTIONS, KEY_ACTION_BY_ID, KEY_GROUPS, cleanOverrides, findConflict, findConflicts, formatKey, keyOfEvent, keyParts, keymapOf, normalizeKey, parseKey,
  resolveKeybindings, shellKeyConflict, validateKey, keymapsOf, pickAction, scopesOverlap, type KeyAction,
} from './keybindings.js'

const ev = (code: string, m: Partial<{ ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }> = {}) =>
  ({ code, ctrlKey: !!m.ctrl, altKey: !!m.alt, shiftKey: !!m.shift, metaKey: !!m.meta })

describe('注册表', () => {
  it('id 唯一、动作名 ≤ 10 字、分组合法、可改项默认键合法且互不冲突', () => {
    const ids = KEY_ACTIONS.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
    const groups = new Set(KEY_GROUPS.map((g) => g.id))
    const seen: KeyAction[] = []
    for (const a of KEY_ACTIONS) {
      expect([...a.name].length).toBeLessThanOrEqual(10)
      expect(groups.has(a.group)).toBe(true)
      expect(a.desc.trim()).not.toBe('')
      if (!a.editable) continue
      expect(normalizeKey(a.keys)).toBe(a.keys)   // 默认键已是规范形式
      expect(validateKey(a.keys)).toBeNull()
      // 同键只允许分给作用范围互斥的动作（终端里 / 终端外）
      expect(seen.filter((b) => b.keys === a.keys && scopesOverlap(a.scope, b.scope)).map((b) => b.id), a.id).toEqual([])
      seen.push(a)
    }
  })
  it('对话区快捷键与终端同键动作按焦点分开', () => {
    const b = resolveKeybindings()
    const m = keymapsOf(b)
    expect(m.get('Ctrl+Up')).toEqual(['term.prevCmd', 'chat.prevMsg'])
    expect(pickAction(m.get('Ctrl+Up'), true)).toBe('term.prevCmd')
    expect(pickAction(m.get('Ctrl+Up'), false)).toBe('chat.prevMsg')
    expect(pickAction(m.get('Ctrl+Down'), false)).toBe('chat.nextMsg')
    // Ctrl+F 两边共用：焦点在终端 → 终端内搜索，在对话区 → 会话内搜索
    expect(pickAction(m.get('Ctrl+F'), true)).toBe('term.find')
    expect(pickAction(m.get('Ctrl+F'), false)).toBe('chat.find')
    expect(KEY_ACTIONS.find((a) => a.id === 'chat.find')?.scope).toBe('outside')
    // 改键冲突只看会同时生效的：终端外的动作改成终端里在用的键不算冲突，改成全局键算
    expect(findConflict('chat.prevMsg', 'Ctrl+Up', b)).toBeNull()
    expect(findConflict('chat.find', 'Ctrl+Shift+P', b)).toBe('palette')
    // 同一个键可能同时和终端内 / 终端外两个动作冲突：替换时要全清，不能只清一个
    expect(findConflicts('palette', 'Ctrl+F', b)).toEqual(expect.arrayContaining(['term.find', 'chat.find']))
    expect(findConflict('chat.find', 'Ctrl+K', b)).toBe('palette.alt')
    expect(findConflict('term.find', 'Ctrl+F', b)).toBeNull()
  })
  it('scopesOverlap', () => {
    expect(scopesOverlap('terminal', 'outside')).toBe(false)
    expect(scopesOverlap('outside', 'outside')).toBe(true)
    expect(scopesOverlap('global', 'outside')).toBe(true)
  })
  it('鼠标操作与补全浮层键不可改', () => {
    const fixed = KEY_ACTIONS.filter((a) => !a.editable).map((a) => a.id)
    expect(fixed).toEqual(expect.arrayContaining(['term.cmdMark', 'term.link', 'term.compNav', 'term.compAccept', 'term.compClose', 'term.compDelete']))
  })
})

describe('事件 → 按键串', () => {
  it('修饰键顺序固定，按 code 取键名', () => {
    expect(keyOfEvent(ev('KeyT', { shift: true, ctrl: true }))).toBe('Ctrl+Shift+T')
    expect(keyOfEvent(ev('ArrowLeft', { ctrl: true, alt: true }))).toBe('Ctrl+Alt+Left')
    expect(keyOfEvent(ev('F1'))).toBe('F1')
    expect(keyOfEvent(ev('Digit0', { ctrl: true }))).toBe('Ctrl+0')
    expect(keyOfEvent(ev('Tab', { ctrl: true, shift: true }))).toBe('Ctrl+Shift+Tab')
  })
  it('小键盘 + / - / 数字归到主键盘', () => {
    expect(keyOfEvent(ev('NumpadAdd', { ctrl: true }))).toBe('Ctrl+=')
    expect(keyOfEvent(ev('NumpadSubtract', { ctrl: true }))).toBe('Ctrl+-')
    expect(keyOfEvent(ev('Numpad0', { ctrl: true }))).toBe('Ctrl+0')
  })
  it('纯修饰键 / 不认识的键返回 null', () => {
    expect(keyOfEvent(ev('ControlLeft', { ctrl: true }))).toBeNull()
    expect(keyOfEvent(ev('ShiftRight', { shift: true }))).toBeNull()
    expect(keyOfEvent(ev('IntlRo'))).toBeNull()
  })
})

describe('解析与格式化', () => {
  it('容忍大小写、空格、修饰键乱序与别名', () => {
    expect(normalizeKey('shift + ctrl + t')).toBe('Ctrl+Shift+T')
    expect(normalizeKey('Control+Alt+left')).toBe('Ctrl+Alt+Left')
    expect(normalizeKey('cmd+k')).toBe('Meta+K')
    expect(normalizeKey('f12')).toBe('F12')
    expect(normalizeKey('Ctrl+=')).toBe('Ctrl+=')
  })
  it('非法串返回 null', () => {
    expect(parseKey('')).toBeNull()
    expect(parseKey('Ctrl+Shift')).toBeNull()
    expect(parseKey('Hyper+T')).toBeNull()
    expect(parseKey('Ctrl+Foo')).toBeNull()
  })
  it('键帽分块与展示', () => {
    expect(keyParts('Ctrl+Shift+Up')).toEqual(['Ctrl', 'Shift', '↑'])
    expect(formatKey('Ctrl+Alt+Right')).toBe('Ctrl+Alt+→')
    expect(formatKey(null)).toBe('未设置')
  })
})

describe('合并与精简覆盖', () => {
  it('覆盖生效、null = 未设置、未知 id 与非法值忽略', () => {
    const b = resolveKeybindings({ 'tab.new': 'ctrl+alt+t', 'tab.close': null, nope: 'Ctrl+J', 'help': 'garbage+' })
    expect(b['tab.new']).toBe('Ctrl+Alt+T')
    expect(b['tab.close']).toBeNull()
    expect(b.help).toBe('F1')
    expect(b.nope).toBeUndefined()
    expect(b['term.cmdMark']).toBeUndefined()   // 不可改项不进
  })
  it('只存改过的：与默认相同、未知、不可改的都去掉', () => {
    expect(cleanOverrides({ 'tab.new': 'Ctrl+Shift+T', 'tab.close': null, 'help': 'f2', x: 'Ctrl+J', 'term.link': 'Ctrl+J' }))
      .toEqual({ 'tab.close': null, help: 'F2' })
  })
  it('反查表跳过未设置', () => {
    const m = keymapOf(resolveKeybindings({ 'tab.close': null }))
    expect(m.get('Ctrl+Shift+T')).toBe('tab.new')
    expect([...m.values()]).not.toContain('tab.close')
  })
})

describe('校验与冲突', () => {
  it('须含 Ctrl / Alt / Meta，或为 F1–F12', () => {
    expect(validateKey('Ctrl+Alt+T')).toBeNull()
    expect(validateKey('F5')).toBeNull()
    expect(validateKey('Shift+F3')).toBeNull()
    expect(validateKey('T')).not.toBeNull()
    expect(validateKey('Shift+T')).not.toBeNull()
    expect(validateKey('F13')).not.toBeNull()
  })
  it('与其它项冲突返回对方 id，自身不算', () => {
    const b = resolveKeybindings()
    expect(findConflict('tab.new', 'Ctrl+Shift+W', b)).toBe('tab.close')
    expect(findConflict('tab.new', 'Ctrl+Shift+T', b)).toBeNull()
    expect(findConflict('tab.new', 'Ctrl+Alt+T', b)).toBeNull()
    expect(findConflict('tab.new', 'Ctrl+Shift+W', resolveKeybindings({ 'tab.close': null }))).toBeNull()
  })
  it('终端常用键警告', () => {
    expect(shellKeyConflict('Ctrl+C')).toBe('Ctrl+C')
    expect(shellKeyConflict('ctrl+r')).toBe('Ctrl+R')
    expect(shellKeyConflict('Ctrl+S')).toBe('Ctrl+S')   // 流控暂停
    expect(shellKeyConflict('Ctrl+Q')).toBe('Ctrl+Q')   // 流控恢复
    expect(shellKeyConflict('Ctrl+J')).toBe('Ctrl+J')
    expect(shellKeyConflict('Alt+B')).toBe('Alt+B')
    expect(shellKeyConflict('Ctrl+Shift+T')).toBeNull()
    expect(shellKeyConflict('Ctrl+Alt+T')).toBeNull()
  })
})

describe('默认键不撞系统保留键', () => {
  it('新增的终端键不和系统保留键（Ctrl+Space 切输入法、Ctrl+Shift+0）撞', () => {
    expect(KEY_ACTION_BY_ID['term.quickSelect']).toMatchObject({ keys: 'Alt+S', scope: 'terminal' })   // Ctrl+Shift+Space 被中文输入法吞掉空格（真机实测）；Ctrl+Shift+S 是很多软件的「另存为」，用户嫌易冲突
    expect(KEY_ACTION_BY_ID['term.replay']).toMatchObject({ keys: 'Ctrl+Alt+R', scope: 'terminal' })
    for (const k of ['Ctrl+Space', 'Ctrl+Shift+0', 'Alt+Shift+Space', 'Ctrl+Shift+Space']) expect(Object.values(resolveKeybindings())).not.toContain(k)
  })
})

describe('默认快捷键', () => {
  it('可改项互不冲突、都能解析成规范按键串', () => {
    const b = resolveKeybindings()
    for (const a of KEY_ACTIONS.filter((x) => x.editable)) {
      expect(normalizeKey(a.keys), a.keys).toBe(a.keys)
      expect(findConflict(a.id, a.keys, b), a.id).toBeNull()
    }
  })
  it('终端里生效的默认键不占终端常用键（Ctrl+字母、readline 的 Alt 键、复制粘贴）', () => {
    // 例外：term.find=Ctrl+F 是用户要求的（和对话区搜索共用一个键），接受 vim / less 里收不到 Ctrl+F；
    // term.nl=Ctrl+I 是仿 VS Code 的有意默认（按 code 判定，Tab 补全不受影响）
    const hit = KEY_ACTIONS.filter((a) => a.editable && a.scope !== 'outside' && shellKeyConflict(a.keys)).map((a) => `${a.id}=${a.keys}`)
    expect(hit).toEqual(['term.find=Ctrl+F', 'term.nl=Ctrl+I'])
  })
})
