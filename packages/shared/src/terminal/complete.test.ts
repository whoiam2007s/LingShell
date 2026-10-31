import { describe, it, expect } from 'vitest'
import { COMPLETION_SNIPPETS, buildCompletionPool, completionInsert, isSecretPrompt, matchCompletions, shouldComplete, typedBeforeCursor } from './complete.js'

const NOW = Date.parse('2026-10-14T12:00:00Z')
const ago = (h: number) => new Date(NOW - h * 3600_000).toISOString()
const texts = (pool: ReturnType<typeof buildCompletionPool>, q: string, n?: number) => matchCompletions(pool, q, n).map((m) => m.item.text)

describe('buildCompletionPool', () => {
  it('同一命令多次出现合并计数；频次多 / 更近的分高', () => {
    const pool = buildCompletionPool({ history: [
      { command: 'ls -la', at: ago(1) }, { command: 'ls -la', at: ago(2) }, { command: 'ls -lh', at: ago(1) },
      { command: 'ls /tmp', at: ago(24 * 30) },
    ] }, NOW)
    expect(pool).toHaveLength(3)
    const s = Object.fromEntries(pool.map((i) => [i.text, i.score]))
    expect(s['ls -la']).toBeGreaterThan(s['ls -lh'])
    expect(s['ls -lh']).toBeGreaterThan(s['ls /tmp'])
  })
  it('多行 / 空 / 超长丢弃；首尾空白去掉', () => {
    const pool = buildCompletionPool({ history: [
      { command: '  df -h  ', at: ago(1) }, { command: 'a\nb', at: ago(1) }, { command: '   ', at: ago(1) }, { command: 'x'.repeat(600), at: ago(1) },
    ] }, NOW)
    expect(pool.map((i) => i.text)).toEqual(['df -h'])
  })
  it('来源合并：历史优先当 kind（可删），快速命令名称保留；快速命令 > 内置片段', () => {
    const pool = buildCompletionPool({ history: [{ command: 'df -h', at: ago(1) }], quick: [{ command: 'df -h', label: '查看磁盘' }, { command: 'free -h', label: '内存' }], snippets: ['free -h', 'docker ps'] }, NOW)
    const by = Object.fromEntries(pool.map((i) => [i.text, i]))
    expect(by['df -h']).toMatchObject({ kind: 'history', label: '查看磁盘' })
    expect(by['free -h']).toMatchObject({ kind: 'quick', label: '内存' })
    expect(by['docker ps'].kind).toBe('snippet')
    expect(by['free -h'].score).toBeGreaterThan(by['docker ps'].score)
  })
  it('时间戳坏了也不炸', () => {
    expect(buildCompletionPool({ history: [{ command: 'ls', at: 'bad' }] }, NOW)[0].score).toBeGreaterThan(0)
  })
})

describe('matchCompletions', () => {
  const pool = buildCompletionPool({
    history: [
      { command: 'systemctl status nginx', at: ago(1) }, { command: 'systemctl status nginx', at: ago(2) },
      { command: 'systemctl restart nginx', at: ago(5) }, { command: 'tail -f /var/log/syslog', at: ago(3) },
      { command: 'Systemd-analyze', at: ago(1) }, { command: 'cat blog.txt', at: ago(1) },
    ],
    snippets: COMPLETION_SNIPPETS,
  }, NOW)

  it('前缀优先，同级按分数（常敲的在前）', () => {
    const r = texts(pool, 'systemctl')
    expect(r[0]).toBe('systemctl status nginx')
    expect(r.indexOf('systemctl restart nginx')).toBeLessThan(r.indexOf('systemctl status '))   // 历史 > 内置片段
  })
  it('大小写一致的前缀 > 忽略大小写的前缀 > 词首子串 > 其它子串', () => {
    const r = texts(pool, 'syst', 20)
    expect(r.indexOf('systemctl status nginx')).toBeLessThan(r.indexOf('Systemd-analyze'))
    const l = texts(pool, 'log', 20)
    expect(l.indexOf('docker logs -f --tail 200 ')).toBeLessThan(l.indexOf('cat blog.txt'))
  })
  it('子串匹配给出高亮区间（落在词首那处）', () => {
    const m = matchCompletions(pool, 'nginx').find((x) => x.item.text === 'systemctl status nginx')!
    expect(m.item.text.slice(m.start, m.end)).toBe('nginx')
    const d = matchCompletions(pool, 'logs').find((x) => x.item.text.startsWith('docker logs'))!
    expect([d.start, d.end]).toEqual([7, 11])
  })
  it('最多 limit 条；空 / 只有空格不出；和输入一样的不出', () => {
    expect(matchCompletions(pool, 's').length).toBeLessThanOrEqual(8)
    expect(matchCompletions(pool, '   ')).toEqual([])
    expect(matchCompletions(pool, '')).toEqual([])
    expect(texts(pool, 'docker ps')).not.toContain('docker ps')
    expect(texts(pool, 'tail -f')).not.toContain('tail -f ')   // 只差末尾空格也算敲完了
  })
  it('输入前导空格忽略，区间仍按候选算', () => {
    const m = matchCompletions(pool, '  tail -f /var')[0]
    expect(m.item.text).toBe('tail -f /var/log/syslog')
    expect([m.start, m.end]).toEqual([0, 12])
  })
  it('无匹配返回空', () => { expect(matchCompletions(pool, 'zzzz')).toEqual([]) })
})

describe('completionInsert', () => {
  it('前缀：只写剩余部分', () => {
    expect(completionInsert('systemctl st', 'systemctl status nginx')).toBe('atus nginx')
    expect(completionInsert('  df', 'df -h')).toBe(' -h')
  })
  it('子串 / 大小写不同：按字符数退格后写整条（中文一个字一个退格）', () => {
    expect(completionInsert('nginx', 'systemctl status nginx')).toBe('\x7f'.repeat(5) + 'systemctl status nginx')
    expect(completionInsert('SYS', 'systemctl')).toBe('\x7f\x7f\x7fsystemctl')
    expect(completionInsert('日志', 'cat 日志.txt')).toBe('\x7f\x7fcat 日志.txt')
  })
})

describe('shouldComplete', () => {
  it('空 / 空白 / undefined / 多行 不弹', () => {
    expect(shouldComplete(undefined)).toBe(false)
    expect(shouldComplete('')).toBe(false)
    expect(shouldComplete('   ')).toBe(false)
    expect(shouldComplete('a\nb')).toBe(false)
    expect(shouldComplete('ls')).toBe(true)
  })
})

describe('isSecretPrompt', () => {
  it.each([
    '[sudo] password for cj: ', 'Password:', "root@10.0.0.1's password: ", "Enter passphrase for key '/home/u/.ssh/id_rsa':",
    'Enter PEM pass phrase:', 'Enter password: ', "Password for 'https://u@github.com':", '请输入密码：', 'Verification code:', 'Passcode:',
  ])('密码类提示：%s', (s) => expect(isSecretPrompt(s)).toBe(true))
  it.each(['user@host:~$ ', 'bypass the cache', 'echo password', 'Continue? [y/N] ', '', 'compass:'])('不是：%s', (s) => expect(isSecretPrompt(s)).toBe(false))
})

describe('typedBeforeCursor', () => {
  // 简易缓冲：每行一个字符串，wrapped 标记软折行
  const mk = (lines: string[], wrapped: boolean[] = []) => ({
    getLine: (y: number) => y < lines.length ? {
      isWrapped: !!wrapped[y],
      translateToString: (trim?: boolean, s = 0, e?: number) => { const t = lines[y].slice(s, e); return trim ? t.replace(/\s+$/, '') : t },
    } : undefined,
  })
  it('读输入起点到光标', () => {
    expect(typedBeforeCursor(mk(['$ git st      ']), { line: 0, col: 2 }, { line: 0, col: 8 }, 14)).toBe('git st')
  })
  it('光标后面还有字（← 回去编辑）→ undefined', () => {
    expect(typedBeforeCursor(mk(['$ git status  ']), { line: 0, col: 2 }, { line: 0, col: 5 }, 14)).toBeUndefined()
  })
  it('光标在输入起点之前 → undefined；就在起点 → 空串', () => {
    expect(typedBeforeCursor(mk(['$ ']), { line: 0, col: 2 }, { line: 0, col: 1 }, 10)).toBeUndefined()
    expect(typedBeforeCursor(mk(['$         ']), { line: 0, col: 2 }, { line: 0, col: 2 }, 10)).toBe('')
  })
  it('软折行拼回一行', () => {
    expect(typedBeforeCursor(mk(['$ abcdefgh', 'ij        '], [false, true]), { line: 0, col: 2 }, { line: 1, col: 2 }, 10)).toBe('abcdefghij')
  })
})
