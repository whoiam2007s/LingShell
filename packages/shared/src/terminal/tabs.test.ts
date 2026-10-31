import { describe, it, expect } from 'vitest'
import { RECONNECT_DELAYS_SEC, SHELL_EXITED, reconnectDelay, reconnectStep, tabAccent, toLayoutItem, TAB_COLORS, type ReconnectState } from './tabs.js'
import { moveTab, pushComposeHistory, planCompose, COMPOSE_HISTORY_MAX, pinFirst, clampTabDrop, closeTargets, pinnedLabel } from './tabs.js'
import type { TerminalInfo } from '../protocol/index.js'

describe('moveTab', () => {
  const l = ['a', 'b', 'c', 'd']
  it('to 是按原列表算的插入位', () => {
    expect(moveTab(l, 0, 2)).toEqual(['b', 'a', 'c', 'd'])
    expect(moveTab(l, 0, 4)).toEqual(['b', 'c', 'd', 'a'])
    expect(moveTab(l, 3, 0)).toEqual(['d', 'a', 'b', 'c'])
    expect(moveTab(l, 2, 1)).toEqual(['a', 'c', 'b', 'd'])
  })
  it('原位 / 越界不变（返回原数组）', () => {
    expect(moveTab(l, 1, 1)).toBe(l)
    expect(moveTab(l, 1, 2)).toBe(l)
    expect(moveTab(l, -1, 0)).toBe(l)
    expect(moveTab(l, 0, 5)).toBe(l)
  })
})

describe('撰写栏', () => {
  it('历史：最新在前、去重、最多 50 条、空白不记', () => {
    expect(pushComposeHistory(['a', 'b'], 'b')).toEqual(['b', 'a'])
    expect(pushComposeHistory(['a'], '  ')).toEqual(['a'])
    const many = Array.from({ length: 60 }, (_, i) => `c${i}`)
    expect(pushComposeHistory(many, 'x')).toHaveLength(COMPOSE_HISTORY_MAX)
  })
  const t = (id: string, p: Partial<TerminalInfo> = {}): TerminalInfo => ({ id, title: id, type: 'ssh', status: 'running', locked: false, ...p })
  const terms = [t('a'), t('b', { env: 'prod' }), t('c', { status: 'disconnected' }), t('d', { locked: true })]
  it('换行同粘贴：统一成回车，末尾补回车，去掉结尾空行', () => {
    expect(planCompose('ls\r\npwd\n\n', 'active', 'a', terms, null).data).toBe('ls\rpwd\r')
    expect(planCompose('', 'active', 'a', terms, null).data).toBe('\r')
  })
  it('目标：当前 / 广播组（没开广播退化为当前）/ 全部，跳过断开与 AI 占用', () => {
    expect(planCompose('ls', 'active', 'a', terms, null).sends.map((x) => x.id)).toEqual(['a'])
    expect(planCompose('ls', 'broadcast', 'a', terms, null).sends.map((x) => x.id)).toEqual(['a'])
    expect(planCompose('ls', 'broadcast', 'a', terms, new Set(['a', 'c'])).sends.map((x) => x.id)).toEqual(['a'])
    const all = planCompose('ls', 'all', 'a', terms, null)
    expect(all.sends.map((x) => x.id)).toEqual(['a', 'b'])
    expect(all.skipped.map((x) => x.id)).toEqual(['c', 'd'])
  })
  it('确认：危险命令，或多行发到生产', () => {
    expect(planCompose('ls', 'active', 'b', terms, null).confirm).toBe(false)
    expect(planCompose('ls\npwd', 'active', 'b', terms, null).confirm).toBe(true)
    expect(planCompose('ls\npwd', 'active', 'a', terms, null).confirm).toBe(false)
    const p = planCompose('rm -rf /', 'active', 'a', terms, null)
    expect(p.confirm).toBe(true)
    expect(p.dangerous).toEqual(['rm -rf /'])
  })
  it('确认：含隐藏字符（同粘贴安全检查）；零宽拆开的危险命令照样标出', () => {
    const zw = String.fromCharCode(0x200b)
    expect(planCompose('echo \x1b[2J', 'active', 'a', terms, null)).toMatchObject({ confirm: true, hidden: true })
    expect(planCompose(`r${zw}m -rf /`, 'active', 'a', terms, null)).toMatchObject({ hidden: true, dangerous: [`r${zw}m -rf /`] })
    expect(planCompose('ls', 'active', 'a', terms, null).hidden).toBe(false)
  })
})

describe('固定标签', () => {
  const pin = new Set(['c', 'e'])
  const isPin = (x: string) => pin.has(x)
  it('pinFirst：固定的排前面，各自保持相对顺序；已有序返回原数组', () => {
    expect(pinFirst(['a', 'b', 'c', 'd', 'e'], isPin)).toEqual(['c', 'e', 'a', 'b', 'd'])
    const ok = ['c', 'e', 'a']
    expect(pinFirst(ok, isPin)).toBe(ok)
  })
  it('clampTabDrop：固定标签只在固定区挪，普通标签不能插到固定区之前', () => {
    expect(clampTabDrop(2, 5, true, 4)).toBe(2)
    expect(clampTabDrop(2, 5, true, 0)).toBe(0)
    expect(clampTabDrop(2, 5, false, 0)).toBe(2)
    expect(clampTabDrop(2, 5, false, 5)).toBe(5)
    expect(clampTabDrop(0, 3, false, 1)).toBe(1)
  })
  it('closeTargets：关闭其他 / 右侧 / 全部都跳过固定的', () => {
    const list = ['c', 'e', 'a', 'b'].map((id) => ({ id }))
    const p = (x: { id: string }) => pin.has(x.id)
    expect(closeTargets(list, 'a', 'others', p)).toEqual(['b'])
    expect(closeTargets(list, 'c', 'right', p)).toEqual(['a', 'b'])
    expect(closeTargets(list, 'a', 'all', p)).toEqual(['a', 'b'])
  })
  it('pinnedLabel：短名；toLayoutItem 带 pinned', () => {
    expect(pinnedLabel('root@10.0.0.5')).toBe('root@1…')
    expect(pinnedLabel('生产数据库')).toBe('生产数据库')
    expect(toLayoutItem('local', undefined, { pinned: true })).toEqual({ kind: 'local', pinned: true })
    expect(toLayoutItem('local', undefined, { pinned: false })).toEqual({ kind: 'local' })
  })
})

describe('tabAccent', () => {
  it('用户选色优先；未选时生产主机自动红色；其余无', () => {
    expect(tabAccent('blue', 'prod')).toBe(TAB_COLORS.blue)
    expect(tabAccent(undefined, 'prod')).toBe(TAB_COLORS.red)
    expect(tabAccent(undefined, 'test')).toBeUndefined()
    expect(tabAccent('bogus')).toBeUndefined()
  })
})

describe('toLayoutItem', () => {
  it('带上颜色 / 重命名，空值不写', () => {
    expect(toLayoutItem('local', undefined)).toEqual({ kind: 'local' })
    expect(toLayoutItem('ssh', 'h1', { color: 'red', title: '' })).toEqual({ kind: 'ssh', hostId: 'h1', color: 'red' })
    expect(toLayoutItem('local', undefined, { title: '构建' })).toEqual({ kind: 'local', title: '构建' })
  })
  it('保持会话：ssh 带上 tmux 会话名（重启接回）；本地 / 未开启不写', () => {
    expect(toLayoutItem('ssh', 'h1', undefined, 'lingshell-0123abcd')).toEqual({ kind: 'ssh', hostId: 'h1', tmux: 'lingshell-0123abcd' })
    expect(toLayoutItem('ssh', 'h1', undefined, undefined)).toEqual({ kind: 'ssh', hostId: 'h1' })
    expect(toLayoutItem('local', undefined, undefined, 'lingshell-0123abcd')).toEqual({ kind: 'local' })
    // 本地终端带上次目录与默认标题（渲染页重载后按它把布局项对回终端）
    expect(toLayoutItem('local', undefined, undefined, undefined, 'powershell', 'D:\\work', '本地 1'))
      .toEqual({ kind: 'local', shell: 'powershell', cwd: 'D:\\work', baseTitle: '本地 1' })
  })
})

describe('reconnectDelay', () => {
  it('按表退避，用完返回 null', () => {
    expect([1, 2, 3, 4].map(reconnectDelay)).toEqual([2, 5, 10, 30])
    expect(reconnectDelay(RECONNECT_DELAYS_SEC.length)).toBe(60)
    expect(reconnectDelay(RECONNECT_DELAYS_SEC.length + 1)).toBeNull()
  })
})

describe('reconnectStep', () => {
  const idle: ReconnectState = { phase: 'idle' }
  const drop = { type: 'disconnected' as const, ssh: true, enabled: true, now: 1000 }

  it('开启时断线 → 2s 后第 1 次', () => {
    expect(reconnectStep(idle, drop)).toEqual({ phase: 'waiting', attempt: 1, at: 3000 })
  })
  it('未开启 / 本地终端 / 远端正常 exit → 不自动重连', () => {
    expect(reconnectStep(idle, { ...drop, enabled: false })).toEqual({ phase: 'off', why: 'disabled' })
    expect(reconnectStep(idle, { ...drop, ssh: false })).toEqual({ phase: 'off', why: 'local' })
    expect(reconnectStep(idle, { ...drop, reason: SHELL_EXITED })).toEqual({ phase: 'off', why: 'exited' })
  })
  it('失败按退避递增，次数用完放弃', () => {
    let s = reconnectStep(idle, drop)
    const waits: number[] = []
    for (let i = 0; i < RECONNECT_DELAYS_SEC.length; i++) {
      s = reconnectStep(s, { type: 'fire' })
      expect(s.phase).toBe('connecting')
      s = reconnectStep(s, { type: 'failed', now: 0 })
      if (s.phase === 'waiting') waits.push(s.at / 1000)
    }
    expect(waits).toEqual(RECONNECT_DELAYS_SEC.slice(1))
    expect(s).toEqual({ phase: 'off', why: 'gaveUp' })
  })
  it('成功 → idle；重连中重复的断线事件不重置计数', () => {
    const w: ReconnectState = { phase: 'waiting', attempt: 3, at: 5 }
    expect(reconnectStep(w, drop)).toBe(w)
    expect(reconnectStep({ phase: 'connecting', attempt: 3 }, { type: 'connected' })).toEqual(idle)
  })
  it('取消：等待/连接中 → off；之后迟到的失败与 fire 不再重启', () => {
    let s = reconnectStep({ phase: 'connecting', attempt: 2 }, { type: 'cancel' })
    expect(s).toEqual({ phase: 'off', why: 'cancelled' })
    s = reconnectStep(s, { type: 'failed', now: 0 })
    s = reconnectStep(s, { type: 'fire' })
    expect(s).toEqual({ phase: 'off', why: 'cancelled' })
    expect(reconnectStep({ phase: 'waiting', attempt: 1, at: 0 }, { type: 'cancel' })).toEqual({ phase: 'off', why: 'cancelled' })
    expect(reconnectStep(idle, { type: 'cancel' })).toBe(idle)
  })
})
