import { describe, it, expect } from 'vitest'
import {
  ruleLayersFor, buildLayeredRules, normalizeRuleText, RULE_BLOCK_MAX, RULE_TEXT_MAX,
  aiReviewApplies, parseReviewReply, reviewAction, buildReviewPrompt,
  previewPlanOf, codeBlockSteps, previewRunMessage,
  needsElevation, applySudoLease, leaseRemainText, SUDO_LEASE_RULE,
} from './safety.js'

describe('分层规则', () => {
  const rules = { groups: { db: '禁止重启 mysqld，变更前先 mysqldump', web: 'web 组规则' }, hosts: { h1: '主库，只读排查', h9: '没用到的主机' } }
  const hosts = [{ hostKey: 'h1', label: 'db-1', group: 'db' }, { hostKey: 'h2', label: 'db-2', group: 'db' }]

  it('只出用到的主机：分组 → 主机 → 工作目录，空的不出', () => {
    const layers = ruleLayersFor(rules, hosts, [{ file: 'AGENTS.md', text: '回复用中文' }, { file: '.lingshell/rules.md', text: '  ' }])
    expect(layers.map((l) => l.label)).toEqual(['分组「db」', '主机「db-1」', '工作目录 AGENTS.md'])
    const s = buildLayeredRules(layers)
    expect(s).toContain('全局 → 分组 → 主机 → 工作目录')
    expect(s.indexOf('禁止重启 mysqld')).toBeLessThan(s.indexOf('主库，只读排查'))
    expect(s.indexOf('主库，只读排查')).toBeLessThan(s.indexOf('回复用中文'))
    expect(s).not.toContain('web 组规则')
    expect(s).not.toContain('没用到的主机')
  })
  it('没有规则返回空串（段落消失）', () => {
    expect(buildLayeredRules(ruleLayersFor(rules, [{ hostKey: 'local', label: '本机' }]))).toBe('')
  })
  it('单层截断；总长超限时优先保留更具体的层，放不下的列名字', () => {
    const long = 'x'.repeat(RULE_BLOCK_MAX + 500)
    expect(buildLayeredRules([{ kind: 'host', label: '主机「a」', text: long }])).toContain('…（已截断）')
    const s = buildLayeredRules([
      { kind: 'group', label: '分组「g」', text: 'G'.repeat(1400) },
      { kind: 'host', label: '主机「h」', text: 'H'.repeat(1400) },
      { kind: 'workdir', label: '工作目录 AGENTS.md', text: 'W'.repeat(1400) },
    ], 3400)
    expect(s).toContain('WWW')
    expect(s).toContain('HHH')
    expect(s).not.toContain('GGG')
    expect(s).toContain('另有 1 层规则因篇幅未展开：分组「g」')
    expect(s.indexOf('HHH')).toBeLessThan(s.indexOf('WWW'))   // 输出顺序仍是 主机 → 工作目录
  })
  it('保存前规整：去空白、超长截断、非字符串为空', () => {
    expect(normalizeRuleText('  a  ')).toBe('a')
    expect(normalizeRuleText('y'.repeat(RULE_TEXT_MAX + 10))).toHaveLength(RULE_TEXT_MAX)
    expect(normalizeRuleText(3)).toBe('')
  })
})

describe('AI 复核', () => {
  it('范围判定', () => {
    expect(aiReviewApplies('prodWrite', { prod: true, write: true, dangerous: false })).toBe(true)
    expect(aiReviewApplies('prodWrite', { prod: false, write: true, dangerous: true })).toBe(false)
    expect(aiReviewApplies('prodWrite', { prod: true, write: false, dangerous: false })).toBe(false)
    expect(aiReviewApplies('dangerous', { prod: false, write: true, dangerous: true })).toBe(true)
    expect(aiReviewApplies('dangerous', { prod: true, write: true, dangerous: false })).toBe(false)
    expect(aiReviewApplies('allWrite', { prod: false, write: true, dangerous: false })).toBe(true)
    expect(aiReviewApplies('allWrite', { prod: true, write: false, dangerous: false })).toBe(false)
  })
  it('解析回复：容忍代码块与废话、别名、无理由；认不出 = 未复核', () => {
    expect(parseReviewReply('```json\n{"verdict":"risky","reason":"会重启 nginx"}\n```')).toEqual({ verdict: 'risky', reason: '会重启 nginx' })
    expect(parseReviewReply('我认为 {"verdict": "BLOCK", "reason": "删库"} 。')).toEqual({ verdict: 'block', reason: '删库' })
    expect(parseReviewReply('{"verdict":"deny"}').verdict).toBe('block')
    expect(parseReviewReply('{"verdict":"safe"}').reason).toBe('（未给理由）')
    expect(parseReviewReply('看起来没问题').verdict).toBe('unreviewed')
    expect(parseReviewReply('{"verdict":"maybe","reason":"x"}').verdict).toBe('unreviewed')
  })
  it('处理策略：拦截 / 只提示 / safe 自动放行的条件', () => {
    const base = { onBlock: 'deny' as const, autoAllowSafe: true, prod: false, trust: 'confirm' as const, dangerous: false }
    expect(reviewAction({ verdict: 'block', reason: '' }, base)).toBe('deny')
    expect(reviewAction({ verdict: 'block', reason: '' }, { ...base, onBlock: 'warn' })).toBe('ask')
    expect(reviewAction({ verdict: 'safe', reason: '' }, base)).toBe('allow')
    expect(reviewAction({ verdict: 'safe', reason: '' }, { ...base, prod: true })).toBe('ask')            // 生产仍需人确认
    expect(reviewAction({ verdict: 'safe', reason: '' }, { ...base, trust: 'autonomous' })).toBe('ask')
    expect(reviewAction({ verdict: 'safe', reason: '' }, { ...base, dangerous: true })).toBe('ask')
    expect(reviewAction({ verdict: 'safe', reason: '' }, { ...base, autoAllowSafe: false })).toBe('ask')
    expect(reviewAction({ verdict: 'risky', reason: '' }, base)).toBe('ask')
    expect(reviewAction({ verdict: 'unreviewed', reason: '' }, base)).toBe('ask')
  })
  it('复核提示含命令、主机（生产）、规则、知识卡标题、上下文', () => {
    const p = buildReviewPrompt({ tool: 'exec_in_terminal', command: 'systemctl restart mysqld', explain: '重启数据库', hosts: [{ label: 'db-1', env: 'prod' }],
      context: '用户：数据库慢', rules: '### 分组「db」\n禁止重启 mysqld', knowledge: ['mysql 日志位置'] })
    expect(p.system).toContain('"verdict"')
    for (const s of ['systemctl restart mysqld', 'db-1（生产）', '禁止重启 mysqld', 'mysql 日志位置', '用户：数据库慢', '重启数据库']) expect(p.user).toContain(s)
  })
})

describe('预演模式', () => {
  it('propose_plan 的预演结果 → 方案；非预演 / 坏 JSON 不认', () => {
    const out = JSON.stringify({ preview: true, title: '修 nginx', steps: [{ terminal_id: 't1', command: 'systemctl reload nginx', hostKey: 'h1' }, { terminal_id: 't1', command: '' }] })
    expect(previewPlanOf(out)).toEqual({ title: '修 nginx', steps: [{ terminal_id: 't1', command: 'systemctl reload nginx', hostKey: 'h1' }] })
    expect(previewPlanOf(JSON.stringify({ approved: true, steps: [] }))).toBeUndefined()
    expect(previewPlanOf('oops')).toBeUndefined()
  })
  it('兜底：回复里 bash 代码块的命令（去 $ 提示符和注释）', () => {
    expect(codeBlockSteps('先看\n```bash\n# 备份\n$ cp a a.bak\nsystemctl restart x\n```\n```python\nprint(1)\n```')).toEqual(['cp a a.bak', 'systemctl restart x'])
  })
  it('执行消息：有终端的写成已批准计划', () => {
    const m = previewRunMessage('修 nginx', [{ terminal_id: 't1', command: 'nginx -t', purpose: '检查' }])
    expect(m).toContain('1. [t1] nginx -t  —— 检查')
    expect(m).toContain('逐字一致')
    expect(previewRunMessage('x', [{ command: 'ls' }])).toContain('照常走授权')
  })
})

describe('sudo 限时提权', () => {
  it('识别需要提权：sudo / doas / su 开头的段，跳过 VAR=；root 登录的写命令', () => {
    expect(needsElevation('sudo systemctl restart nginx')).toBe(true)
    expect(needsElevation('cd /etc && sudo -u app ls')).toBe(true)
    expect(needsElevation('FOO=1 sudo ls')).toBe(true)
    expect(needsElevation('echo $(sudo cat /etc/shadow)')).toBe(true)
    expect(needsElevation('/usr/bin/sudo ls')).toBe(true)
    expect(needsElevation('su -c "ls"')).toBe(true)
    expect(needsElevation('echo sudo')).toBe(false)
    expect(needsElevation('pseudo-cmd')).toBe(false)
    expect(needsElevation('systemctl restart nginx', { rootUser: true, readOnly: false })).toBe(true)
    expect(needsElevation('cat /etc/hosts', { rootUser: true, readOnly: true })).toBe(false)
    expect(needsElevation(undefined)).toBe(false)
  })
  it('期内只免掉「首次 / 确认」的卡；危险命令、规则询问、拒绝不变', () => {
    const on = { active: true, elevation: true }
    expect(applySudoLease({ kind: 'prompt', reason: 'elevation' }, on)).toEqual({ kind: 'allow', rule: SUDO_LEASE_RULE })
    expect(applySudoLease({ kind: 'prompt', reason: 'first_access' }, on).kind).toBe('allow')
    expect(applySudoLease({ kind: 'prompt', reason: 'dangerous_command' }, on).kind).toBe('prompt')
    expect(applySudoLease({ kind: 'prompt', reason: 'elevation', rule: '前缀 sudo · 总是询问' }, on).kind).toBe('prompt')
    expect(applySudoLease({ kind: 'deny', reason: 'readonly' }, on).kind).toBe('deny')
    expect(applySudoLease({ kind: 'prompt', reason: 'elevation' }, { active: false, elevation: true }).kind).toBe('prompt')
    expect(applySudoLease({ kind: 'prompt', reason: 'elevation' }, { active: true, elevation: false }).kind).toBe('prompt')
  })
  it('剩余时间文案', () => {
    expect(leaseRemainText(1_000 + 725_000, 1_000)).toBe('12 分 05 秒')
    expect(leaseRemainText(0, 5_000)).toBe('0 分 00 秒')
  })
})
