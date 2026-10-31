import { describe, it, expect } from 'vitest'
import { splitCommand, evaluateCommandRules, applyRuleVerdict, ruleError, ruleLabel, type CommandRule } from './commandRules.js'

const rule = (p: Partial<CommandRule> & Pick<CommandRule, 'pattern' | 'action'>): CommandRule =>
  ({ id: p.pattern, match: 'prefix', scope: 'all', ...p })

describe('splitCommand', () => {
  it('按 ; && || | & 换行拆段', () => {
    expect(splitCommand('ls; rm -rf /tmp/xx')).toEqual(['ls', 'rm -rf /tmp/xx'])
    expect(splitCommand('a && b || c | d\ne & f')).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(splitCommand('cat x |& grep y')).toEqual(['cat x', 'grep y'])
  })
  it('引号内的分隔符不拆', () => {
    expect(splitCommand(`echo "a; b && c" 'x | y'; ls`)).toEqual([`echo "a; b && c" 'x | y'`, 'ls'])
    expect(splitCommand(`echo a\\;b`)).toEqual([`echo a\\;b`])
  })
  it('重定向里的 & 不算分隔', () => {
    expect(splitCommand('make 2>&1 | tee log')).toEqual(['make 2>&1', 'tee log'])
    expect(splitCommand('cmd &> /dev/null')).toEqual(['cmd &> /dev/null'])
  })
  it('$( ) 与反引号里的子命令另拆一段（双引号里的也算），算术展开不算', () => {
    expect(splitCommand('echo $(rm -rf x; ls)')).toEqual(['echo $(rm -rf x; ls)', 'rm -rf x', 'ls'])
    expect(splitCommand('echo `whoami`')).toEqual(['echo `whoami`', 'whoami'])
    expect(splitCommand(`echo "now: $(date)"`)).toEqual([`echo "now: $(date)"`, 'date'])
    expect(splitCommand(`echo '$(date)'`)).toEqual([`echo '$(date)'`])
    expect(splitCommand('echo $((1+2))')).toEqual(['echo $((1+2))'])
    expect(splitCommand('diff <(sort a) b')).toEqual(['diff <(sort a) b', 'sort a'])
  })
  it('子 shell / 命令组的括号去掉', () => {
    expect(splitCommand('(cd /tmp && rm a)')).toEqual(['cd /tmp', 'rm a'])
    expect(splitCommand('{ ls; pwd; }')).toEqual(['ls', 'pwd'])
  })
})

describe('evaluateCommandRules', () => {
  const ctx = { hostKey: 'h1', group: '生产' }
  it('所有段都放行才放行；有段没命中 → 不定论', () => {
    const rules = [rule({ pattern: 'echo', action: 'allow' }), rule({ pattern: 'ls', action: 'allow' })]
    expect(evaluateCommandRules(rules, 'echo hi', ctx)?.action).toBe('allow')
    expect(evaluateCommandRules(rules, 'ls && echo hi', ctx)?.action).toBe('allow')
    expect(evaluateCommandRules(rules, 'echo hi; cat x', ctx)).toBeUndefined()
    expect(evaluateCommandRules(rules, 'echo $(cat /etc/shadow)', ctx)).toBeUndefined()   // 子命令也得命中放行
  })
  it('任一段命中禁止即禁止（优先于放行）', () => {
    const rules = [rule({ pattern: 'ls', action: 'allow' }), rule({ match: 'regex', pattern: 'rm\\s', action: 'deny' })]
    const v = evaluateCommandRules(rules, 'ls; rm -rf /tmp/xx', ctx)
    expect(v).toMatchObject({ action: 'deny', segment: 'rm -rf /tmp/xx' })
    expect(evaluateCommandRules(rules, 'ls | xargs rm -f', ctx)?.action).toBe('deny')
    expect(evaluateCommandRules(rules, 'echo "rm -rf /"', ctx)?.action).toBe('deny')   // 正则在整段里搜索，引号里的也算
  })
  it('先匹配先生效；询问让原本免卡的也弹卡', () => {
    const rules = [rule({ pattern: 'rm ', action: 'ask' }), rule({ pattern: 'rm', action: 'allow' })]
    expect(evaluateCommandRules(rules, 'rm a', ctx)?.action).toBe('ask')
    expect(evaluateCommandRules(rules, 'rmdir a', ctx)?.action).toBe('allow')
  })
  it('范围：分组 / 主机；本地用 local', () => {
    const rules = [
      rule({ pattern: 'systemctl', action: 'deny', scope: 'groups', groups: ['生产'] }),
      rule({ pattern: 'echo', action: 'allow', scope: 'hosts', hosts: ['local'] }),
    ]
    expect(evaluateCommandRules(rules, 'systemctl restart x', ctx)?.action).toBe('deny')
    expect(evaluateCommandRules(rules, 'systemctl restart x', { hostKey: 'h2', group: '测试' })).toBeUndefined()
    expect(evaluateCommandRules(rules, 'echo 1', { hostKey: 'local' })?.action).toBe('allow')
    expect(evaluateCommandRules(rules, 'echo 1', ctx)).toBeUndefined()
  })
  it('不合法正则 / 空模式的规则不生效', () => {
    expect(ruleError({ match: 'regex', pattern: '(' })).toMatch(/正则不合法/)
    expect(ruleError({ match: 'prefix', pattern: '' })).toBeDefined()
    expect(evaluateCommandRules([rule({ match: 'regex', pattern: '(', action: 'deny' })], 'ls', ctx)).toBeUndefined()
  })
})

describe('applyRuleVerdict', () => {
  const allowBase = () => ({ kind: 'allow' as const })
  const promptBase = () => ({ kind: 'prompt' as const, reason: 'first_access', risk: 'safe' as const })
  const o = { prod: false, readonly: false, dangerous: false }
  const v = (action: 'allow' | 'ask' | 'deny') => ({ action, segment: 'x', rule: rule({ pattern: 'x', action }) })
  it('禁止：直接拒并写明规则', () => {
    expect(applyRuleVerdict(v('deny'), allowBase, o)).toEqual({ kind: 'deny', reason: `按规则：${ruleLabel(v('deny').rule)}`, rule: ruleLabel(v('deny').rule) })
  })
  it('放行：免卡；只读档与生产主机危险命令不突破', () => {
    expect(applyRuleVerdict(v('allow'), promptBase, o)).toMatchObject({ kind: 'allow', rule: expect.stringContaining('总是放行') })
    expect(applyRuleVerdict(v('allow'), () => ({ kind: 'deny', reason: 'readonly' }), { ...o, readonly: true })).toEqual({ kind: 'deny', reason: 'readonly' })
    const prodDanger = () => ({ kind: 'prompt' as const, reason: 'dangerous_command', risk: 'dangerous' as const })
    expect(applyRuleVerdict(v('allow'), prodDanger, { ...o, prod: true, dangerous: true })).toEqual(prodDanger())
    expect(applyRuleVerdict(v('allow'), promptBase, { ...o, dangerous: true }).kind).toBe('allow')   // 非生产主机：用户自己放行的照放
  })
  it('询问：原本放行的改成弹卡，原本要问的标上规则，原本拒绝的仍拒', () => {
    expect(applyRuleVerdict(v('ask'), allowBase, o)).toMatchObject({ kind: 'prompt', reason: 'elevation', rule: expect.any(String) })
    expect(applyRuleVerdict(v('ask'), promptBase, o)).toMatchObject({ kind: 'prompt', reason: 'first_access', rule: expect.any(String) })
    expect(applyRuleVerdict(v('ask'), () => ({ kind: 'deny', reason: 'r' }), o)).toEqual({ kind: 'deny', reason: 'r' })
  })
  it('没有定论：原样走原逻辑', () => {
    expect(applyRuleVerdict(undefined, promptBase, o)).toEqual(promptBase())
  })
})
