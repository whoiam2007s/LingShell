import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AutoReplyEngine, type AutoReplyRule, type AutoReplyDeps } from './autoReply.js'

const SUDO: AutoReplyRule = { id: 'r1', name: 'sudo 密码', pattern: '[sudo] password for', regex: false, secret: true, response: 'S3cret!', appendEnter: true, scope: 'all', allowProd: false, enabled: true }

function setup(over: { rules?: AutoReplyRule[]; prod?: boolean; busy?: () => boolean } = {}) {
  const writes: string[] = []
  const notes: { rule: string; disabled?: boolean }[] = []
  let now = 0
  const e = new AutoReplyEngine({
    rules: () => over.rules ?? [SUDO],
    hostKey: () => 'h1',
    isProd: () => !!over.prod,
    aiBusy: over.busy ?? (() => false),
    write: (_id, d) => writes.push(d),
    notify: (_id, rule, disabled) => notes.push({ rule, disabled }),
    now: () => now,
    quietMs: 10,
  } satisfies AutoReplyDeps)
  e.attach('t')
  const feed = (...cs: string[]) => { for (const c of cs) e.data('t', c); vi.advanceTimersByTime(20) }
  return { e, writes, notes, feed, tick: (ms: number) => { now += ms } }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('AutoReplyEngine', () => {
  it('提示跨 chunk、带 ANSI 也能命中，发应答 + 回车并通知', () => {
    const { writes, notes, feed } = setup()
    feed('$ sudo ls\r\n\x1b[1m[su', 'do] pass\x1b[0m', 'word for ops: ')
    expect(writes).toEqual(['S3cret!\r'])
    expect(notes).toEqual([{ rule: 'sudo 密码', disabled: undefined }])
  })

  it('只看光标所在的最后一行：历史行里出现不触发', () => {
    const { writes, feed } = setup()
    feed('[sudo] password for ops: \r\nSorry, try again.\r\n$ ')
    expect(writes).toEqual([])
  })

  it('输出还在流时不判（停顿后才判）', () => {
    const { e, writes } = setup()
    e.data('t', 'Are you sure… [sudo] password for x')
    vi.advanceTimersByTime(5)
    e.data('t', ' and more output\r\n')
    vi.advanceTimersByTime(20)
    expect(writes).toEqual([])
  })

  it('AI execCapture 期间（锁定）绝不触发，回放的半截提示解锁后也不触发', () => {
    let busy = true
    const { writes, feed } = setup({ busy: () => busy })
    feed('[sudo] password for ops: ')        // AI 超时回放的半截输出
    expect(writes).toEqual([])
    busy = false
    vi.advanceTimersByTime(1000)
    feed('')                                  // 解锁后再来空数据：这一行仍是被污染的
    expect(writes).toEqual([])
    feed('^C\r\n$ sudo x\r\n[sudo] password for ops: ')   // 换行后用户自己的新提示才触发
    expect(writes).toEqual(['S3cret!\r'])
  })

  it('生产主机默认不触发，规则显式 allowProd 才触发', () => {
    const a = setup({ prod: true })
    a.feed('[sudo] password for ops: ')
    expect(a.writes).toEqual([])
    const b = setup({ prod: true, rules: [{ ...SUDO, allowProd: true }] })
    b.feed('[sudo] password for ops: ')
    expect(b.writes).toEqual(['S3cret!\r'])
  })

  it('作用范围 / 停用 / 未设应答 不触发', () => {
    for (const r of [{ ...SUDO, scope: ['other'] }, { ...SUDO, enabled: false }, { ...SUDO, response: undefined }]) {
      const s = setup({ rules: [r] })
      s.feed('[sudo] password for ops: ')
      expect(s.writes).toEqual([])
    }
    const s = setup({ rules: [{ ...SUDO, scope: ['h1'] }] })
    s.feed('[sudo] password for ops: ')
    expect(s.writes).toHaveLength(1)
  })

  it('每个提示只触发一次（同一行后续输出不重发）', () => {
    const { writes, feed } = setup({ rules: [{ ...SUDO, pattern: 'continue connecting', response: 'yes', secret: false }] })
    feed('Are you sure you want to continue connecting (yes/no)? ')
    feed('y', 'es')                           // 回显 yes 仍在同一行
    expect(writes).toEqual(['yes\r'])
  })

  it('1 分钟内超过 3 次即在该终端停用并通知；其它终端不受影响', () => {
    const { e, writes, notes, feed, tick } = setup()
    for (let i = 0; i < 5; i++) { feed('\r\nSorry, try again.\r\n[sudo] password for ops: '); tick(1000) }
    expect(writes).toHaveLength(3)
    expect(notes.at(-1)).toEqual({ rule: 'sudo 密码', disabled: true })
    expect(notes.filter((n) => n.disabled)).toHaveLength(1)
    e.attach('t2')
    e.data('t2', '[sudo] password for ops: '); vi.advanceTimersByTime(20)
    expect(writes).toHaveLength(4)
  })

  it('超过 1 分钟窗口的旧次数不计', () => {
    const { writes, feed, tick } = setup()
    for (let i = 0; i < 5; i++) { feed('\r\n[sudo] password for ops: '); tick(30_000) }
    expect(writes).toHaveLength(5)
  })

  it('正则模式不区分大小写；只回车的规则', () => {
    const { writes, feed } = setup({ rules: [{ ...SUDO, pattern: 'press (any key|enter) to continue', regex: true, response: '', secret: false }] })
    feed('Press ANY key to continue...')
    expect(writes).toEqual(['\r'])
  })

  it('detach 后不再触发', () => {
    const { e, writes } = setup()
    e.data('t', '[sudo] password for ops: ')
    e.detach('t')
    vi.advanceTimersByTime(20)
    expect(writes).toEqual([])
  })
})
