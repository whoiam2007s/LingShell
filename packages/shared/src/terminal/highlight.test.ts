import { describe, expect, it } from 'vitest'
import { compileAlerts, compileHighlight, createAlertScanner, createHighlightStream, DEFAULT_HIGHLIGHT_RULES, markText, type HighlightRule } from './highlight.js'

const rule = (p: Partial<HighlightRule>): HighlightRule => ({ id: 'x', pattern: 'ERROR', isRegex: false, caseSensitive: true, color: 'red', enabled: true, ...p })
const RED = (s: string) => `\x1b[31m${s}\x1b[39m`
const C = compileHighlight([rule({})])!
const run = (chunks: string[], c = C) => {
  const h = createHighlightStream()
  return chunks.map((x) => h.push(x, c)).join('') + h.flush(c)
}

describe('compileHighlight', () => {
  it('无启用规则 / 全部非法 → null', () => {
    expect(compileHighlight([])).toBeNull()
    expect(compileHighlight([rule({ enabled: false })])).toBeNull()
    expect(compileHighlight([rule({ isRegex: true, pattern: '(' })])).toBeNull()
    expect(compileHighlight([rule({ isRegex: true, pattern: 'a*' })])).toBeNull()   // 可匹配空串
  })
  it('非法正则被跳过，其余规则照常', () => {
    const c = compileHighlight([rule({ isRegex: true, pattern: '[' }), rule({ pattern: 'WARN', color: 'yellow' })])!
    expect(markText('ERROR WARN', c)).toBe('ERROR \x1b[33mWARN\x1b[39m')
  })
  it('普通文本按字面匹配（不当正则）', () => {
    const c = compileHighlight([rule({ pattern: 'a.b' })])!
    expect(markText('axb a.b', c)).toBe(`axb ${RED('a.b')}`)
  })
  it('大小写选项', () => {
    expect(markText('error ERROR', C)).toBe(`error ${RED('ERROR')}`)
    const ci = compileHighlight([rule({ caseSensitive: false })])!
    expect(markText('error ERROR', ci)).toBe(`${RED('error')} ${RED('ERROR')}`)
  })
  it('规则自带捕获组时颜色仍对应正确规则；背景/粗体', () => {
    const c = compileHighlight([
      rule({ isRegex: true, pattern: '(a)(b)' }),
      rule({ pattern: 'OK', color: 'green', bg: 'blue', bold: true }),
    ])!
    expect(markText('ab OK', c)).toBe(`${RED('ab')} \x1b[32;44;1mOK\x1b[39;49;22m`)
  })
  it('大小写混合两桶：重叠时先开始者优先', () => {
    const c = compileHighlight([rule({ pattern: 'FOO BAR' }), rule({ pattern: 'bar baz', caseSensitive: false, color: 'green' })])!
    expect(markText('FOO BAR BAZ', c)).toBe(`${RED('FOO BAR')} BAZ`)
  })
  it('默认规则', () => {
    const c = compileHighlight(DEFAULT_HIGHLIGHT_RULES)!
    expect(markText('Permission denied', c)).toContain('\x1b[31mdenied')
    expect(markText('java.lang.NullPointerException', c)).toContain('\x1b[31mNullPointerException')
    expect(markText('Active: active (running) since', c)).toContain('\x1b[32mactive (running)')
    expect(markText('inet 192.168.1.20/24', c)).toContain('\x1b[36m192.168.1.20\x1b[39m')
    expect(markText('version 1.2.3.4567', c)).not.toContain('\x1b[36m')
    expect(markText('[WARNING] x', c)).toContain('\x1b[33mWARNING')
  })
})

describe('createHighlightStream', () => {
  it('关闭（c=null）时原样输出', () => {
    const s = 'ERROR\r\n\x1b[1mERROR\x1b[0m'
    expect(run([s.slice(0, 3), s.slice(3)], null as never)).toBe(s)
  })
  it('转义序列原样保留，只给文本着色', () => {
    const s = '\x1b]0;ERROR title\x07\x1b[2J\x1b[H ERROR\r\n'
    expect(run([s])).toBe(`\x1b]0;ERROR title\x07\x1b[2J\x1b[H ${RED('ERROR')}\r\n`)
  })
  it('已有颜色/属性的文本不动，复位后恢复高亮', () => {
    expect(run(['\x1b[32mERROR\x1b[0m ERROR\n'])).toBe(`\x1b[32mERROR\x1b[0m ${RED('ERROR')}\n`)
    expect(run(['\x1b[1mERROR\x1b[22m ERROR\n'])).toBe(`\x1b[1mERROR\x1b[22m ${RED('ERROR')}\n`)
    expect(run(['\x1b[38;5;196mERROR\x1b[39m ERROR\n'])).toBe(`\x1b[38;5;196mERROR\x1b[39m ${RED('ERROR')}\n`)
    expect(run(['\x1b[7mERROR\x1b[m ERROR\n'])).toBe(`\x1b[7mERROR\x1b[m ${RED('ERROR')}\n`)
  })
  it('关键字跨块拆开：块尾扣留拼接后命中', () => {
    expect(run(['line1\nfoo ER', 'ROR bar\n'])).toBe(`line1\nfoo ${RED('ERROR')} bar\n`)
  })
  it('无换行的小块（键入回显）不扣留', () => {
    const h = createHighlightStream()
    expect(h.push('ER', C)).toBe('ER')
    expect(h.pending).toBe('')
  })
  it('扣留后 flush 吐出', () => {
    const h = createHighlightStream()
    expect(h.push('x\nERROR', C)).toBe('x\n')
    expect(h.pending).toBe('ERROR')
    expect(h.flush(C)).toBe(RED('ERROR'))
    expect(h.flush(C)).toBe('')
  })
  it('转义序列跨块拆开', () => {
    expect(run(['\x1b[3', '1mERROR\x1b[', '0m ERROR\n'])).toBe(`\x1b[31mERROR\x1b[0m ${RED('ERROR')}\n`)
    expect(run(['\x1b]0;ERR', 'OR\x1b', '\\ERROR\n'])).toBe(`\x1b]0;ERROR\x1b\\${RED('ERROR')}\n`)
  })
  it('备用屏（vim/top/less）内原样透传，退出后恢复', () => {
    const s = '\x1b[?1049hERROR\r\nERROR\x1b[?1049l ERROR\n'
    expect(run([s])).toBe(`\x1b[?1049hERROR\r\nERROR\x1b[?1049l ${RED('ERROR')}\n`)
    expect(run(['\x1b[?47hERROR\n'])).toBe('\x1b[?47hERROR\n')
    expect(run(['\x1b[?10', '49hERROR\n'])).toBe('\x1b[?1049hERROR\n')
  })
  it('超大块不卡：预算外原样透传', () => {
    const big = 'ERROR xxxxxxxxxx\n'.repeat(40000)   // ~680KB
    const t = Date.now()
    const out = run([big])
    expect(Date.now() - t).toBeLessThan(2000)
    expect(out.startsWith(RED('ERROR'))).toBe(true)
    expect(out.endsWith('ERROR xxxxxxxxxx\n')).toBe(true)
    expect(out.split('\x1b[31m').join('').split('\x1b[39m').join('')).toBe(big)
  })
})

describe('关键字告警', () => {
  it('只编译启用且勾了告警的规则；非法 / 匹配空串的忽略', () => {
    expect(compileAlerts([rule({})])).toBeNull()
    expect(compileAlerts([rule({ notify: true, enabled: false })])).toBeNull()
    expect(compileAlerts([rule({ notify: true, isRegex: true, pattern: '(' }), rule({ id: 'y', notify: true, isRegex: true, pattern: 'a*' })])).toBeNull()
    expect(compileAlerts([rule({ notify: true }), rule({ id: 'y', pattern: 'OOM', notify: true })])!.rules.map((r) => r.id)).toEqual(['x', 'y'])
  })

  it('按完整行匹配，跨块拼接，去掉颜色再比（已着色的输出照样告警）', () => {
    const c = compileAlerts([rule({ notify: true, caseSensitive: false })])
    const s = createAlertScanner()
    expect(s.scan('foo ER', c, 0)).toEqual([])
    expect(s.scan('ROR bar\r\nnext', c, 1)).toEqual([{ id: 'x', pattern: 'ERROR', line: 'foo ERROR bar' }])
    const s2 = createAlertScanner()
    expect(s2.scan('\x1b[31merr\x1b[0mor: x\n', c, 0)).toHaveLength(1)
  })

  it('每条规则冷却期内只报一次，规则之间互不影响', () => {
    const c = compileAlerts([rule({ notify: true }), rule({ id: 'y', pattern: 'OOM', notify: true })])
    const s = createAlertScanner(30_000)
    expect(s.scan('ERROR 1\nERROR 2\n', c, 0).map((h) => h.line)).toEqual(['ERROR 1'])
    expect(s.scan('ERROR 3\nOOM killed\n', c, 10_000).map((h) => h.id)).toEqual(['y'])
    expect(s.scan('ERROR 4\n', c, 29_999)).toEqual([])
    expect(s.scan('ERROR 5\n', c, 30_000).map((h) => h.line)).toEqual(['ERROR 5'])
  })

  it('没有告警规则时清空扣留的半行', () => {
    const c = compileAlerts([rule({ notify: true })])
    const s = createAlertScanner()
    s.scan('ERR', c, 0)
    expect(s.scan('x\n', null, 0)).toEqual([])
    expect(s.scan('OR\n', c, 0)).toEqual([])
  })
})
