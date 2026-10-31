import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuthRegistry } from '@lingshell/auth-registry'
import { DEFAULT_SYSTEM_SETTINGS, SUDO_LEASE_RULE, type HostSummary, type SafetyChangedEvent, type SystemSettings } from '@lingshell/shared'
import type { ApprovalRequest, ReviewRequest } from '@lingshell/dsh-controller'
import { registerSafety, type SafetyDeps } from './safetyIpc.js'

const host = (id: string, label: string, o: Partial<HostSummary> = {}) => ({ id, label, host: 'x', port: 22, username: 'ops', authType: 'password', ...o }) as HostSummary
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.useRealTimers() })

function setup(o: { sys?: Partial<SystemSettings>; complete?: SafetyDeps['complete']; trust?: 'confirm' | 'autonomous'; redact?: SafetyDeps['redact'] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'safety-'))
  dirs.push(dir)
  const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
  const events: SafetyChangedEvent[] = []
  const auth = new AuthRegistry({ store: { load: () => ({ records: [], trust: {} }), save: () => {} } })
  if (o.trust) auth.setTrust('s1', o.trust)
  const calls: { user: string; profileId?: string }[] = []
  const preview = new Set<string>()
  const s = registerSafety({
    handle: (ch, fn) => { handlers.set(ch, fn) }, dir,
    hosts: () => [host('h1', 'db-1', { group: 'db', env: 'prod' }), host('h2', 'web-1', { group: 'web' }), host('h3', 'root-box', { username: 'root' })],
    sys: () => ({ ...DEFAULT_SYSTEM_SETTINGS, ...o.sys }),
    auth, isReadOnly: (c) => /^(ls|cat)\b/.test(c), knowledgeTitles: (k) => (k === 'h1' ? ['mysql 日志位置'] : []),
    complete: o.complete ?? (async (_s, user, _sig, _src, profileId) => { calls.push({ user, profileId }); return '{"verdict":"risky","reason":"会重启数据库"}' }),
    profileName: (id) => (id ? `配置 ${id}` : '默认'),
    preview: { get: (sid) => preview.has(sid), set: (sid, on) => { if (on) preview.add(sid); else preview.delete(sid) }, approve: (sid) => { preview.delete(sid); return 1 } },
    send: (ev) => events.push(ev), redact: o.redact,
  })
  const call = (ch: string, ...a: unknown[]) => handlers.get(ch)!(undefined, ...a)
  return { s, call, dir, auth, events, calls, preview }
}

const req = (o: Partial<ReviewRequest> = {}): ReviewRequest => ({ sessionId: 's1', tool: 'exec_in_terminal', hostKeys: ['h1'], command: 'systemctl restart mysqld', reason: 'elevation', risk: 'safe', context: '用户：数据库慢', ...o })

describe('分层规则', () => {
  it('分组 / 主机规则读写（空 = 删除），只注入用到的主机 + 工作目录文件', () => {
    const { s, call, dir } = setup()
    call('safety:setGroupRules', 'db', '  禁止重启 mysqld，变更前先 mysqldump ')
    call('safety:setHostRules', 'h1', '主库，只读排查')
    call('safety:setHostRules', 'h2', 'web 规则')
    call('safety:setHostRules', 'h2', '   ')
    expect(call('safety:rules')).toEqual({ groups: { db: '禁止重启 mysqld，变更前先 mysqldump' }, hosts: { h1: '主库，只读排查' } })
    expect(() => call('safety:setGroupRules', '', 'x')).toThrow()

    const wd = join(dir, 'proj')
    mkdirSync(join(wd, '.lingshell'), { recursive: true })
    writeFileSync(join(wd, 'AGENTS.md'), '回复用中文')
    expect(s.layeredRules([], undefined)).toBe('')
    const t = s.layeredRules(['h1'], wd)
    expect(t).toContain('### 分组「db」\n禁止重启 mysqld')
    expect(t).toContain('### 主机「db-1」\n主库，只读排查')
    expect(t).toContain('### 工作目录 AGENTS.md\n回复用中文')
    expect(s.layeredRules(['h2'], undefined)).toBe('')
    // 改了文件下一次就读到新内容
    writeFileSync(join(wd, '.lingshell', 'rules.md'), '新规则')
    expect(s.layeredRules([], wd)).toContain('### 工作目录 .lingshell/rules.md\n新规则')
  })
})

describe('AI 复核', () => {
  it('没开 / 不在范围 → 不复核', async () => {
    expect(await setup().s.review(req())).toBeUndefined()
    const { s, calls } = setup({ sys: { aiReview: { enabled: true, scope: 'prodWrite', onBlock: 'deny', autoAllowSafe: false } } })
    expect(await s.review(req({ hostKeys: ['h2'] }))).toBeUndefined()     // 非生产
    expect(await s.review(req({ command: 'cat /etc/my.cnf' }))).toBeUndefined()   // 只读
    expect(calls).toHaveLength(0)
  })
  it('命中范围：用指定配置调复核模型，提示带规则 / 知识卡标题 / 上下文', async () => {
    const { s, call, calls } = setup({ sys: { aiReview: { enabled: true, profileId: 'cheap', scope: 'prodWrite', onBlock: 'deny', autoAllowSafe: false } } })
    call('safety:setGroupRules', 'db', '禁止重启 mysqld')
    const r = await s.review(req())
    expect(r).toEqual({ review: { verdict: 'risky', reason: '会重启数据库', model: '配置 cheap' }, action: 'ask' })
    expect(calls[0].profileId).toBe('cheap')
    for (const x of ['systemctl restart mysqld', 'db-1（生产）', '禁止重启 mysqld', 'mysql 日志位置', '用户：数据库慢']) expect(calls[0].user).toContain(x)
  })
  it('复核提示先脱敏：命令、write_file 的 diff、说明与上下文里的机密都换掉，占位符保持原样', async () => {
    const redact = (s: string) => s.split('SECRETPW').join('[已脱敏]')
    const { s, calls } = setup({ sys: { aiReview: { enabled: true, scope: 'allWrite', onBlock: 'deny', autoAllowSafe: false } }, redact })
    await s.review(req({
      tool: 'write_file', command: 'mysql -pSECRETPW {{secret:db}}',
      diff: '+ password=SECRETPW', explain: '用 SECRETPW 登录', rollback: 'mysql -pSECRETPW', context: '用户提到 SECRETPW {{secret:db}}',
    }))
    expect(calls[0].user).not.toContain('SECRETPW')
    expect(calls[0].user).toContain('{{secret:db}}')
    expect(calls[0].user).toContain('文件改动（diff）')
  })
  it('block → 按设置拒绝 / 只提示；safe 在非生产 + 确认档 + 开关开时自动放行', async () => {
    const block = async () => '{"verdict":"block","reason":"违反规则"}'
    const safe = async () => '{"verdict":"safe","reason":"只是重载"}'
    const cfg = { enabled: true, scope: 'allWrite' as const, onBlock: 'deny' as const, autoAllowSafe: true }
    expect((await setup({ sys: { aiReview: cfg }, complete: block }).s.review(req()))?.action).toBe('deny')
    expect((await setup({ sys: { aiReview: { ...cfg, onBlock: 'warn' } }, complete: block }).s.review(req()))?.action).toBe('ask')
    expect((await setup({ sys: { aiReview: cfg }, complete: safe, trust: 'confirm' }).s.review(req({ hostKeys: ['h2'] })))?.action).toBe('allow')
    expect((await setup({ sys: { aiReview: cfg }, complete: safe, trust: 'confirm' }).s.review(req()))?.action).toBe('ask')   // 生产
    expect((await setup({ sys: { aiReview: cfg }, complete: safe, trust: 'autonomous' }).s.review(req({ hostKeys: ['h2'] })))?.action).toBe('ask')
  })
  it('15 秒超时 / 出错 → 未复核，照常弹卡', async () => {
    vi.useFakeTimers()
    const cfg = { enabled: true, scope: 'allWrite' as const, onBlock: 'deny' as const, autoAllowSafe: false }
    let aborted = false
    const hang: SafetyDeps['complete'] = (_s, _u, sig) => new Promise(() => { sig.addEventListener('abort', () => { aborted = true }) })
    const p = setup({ sys: { aiReview: cfg }, complete: hang }).s.review(req())
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await p).toMatchObject({ review: { verdict: 'unreviewed', reason: expect.stringContaining('超时') }, action: 'ask' })
    expect(aborted).toBe(true)
    vi.useRealTimers()
    const err = await setup({ sys: { aiReview: cfg }, complete: async () => { throw new Error('401 bad key') } }).s.review(req())
    expect(err?.review).toMatchObject({ verdict: 'unreviewed', reason: '复核失败：401 bad key' })
  })
})

describe('sudo 限时提权', () => {
  const prompt = { kind: 'prompt' as const, reason: 'elevation', risk: 'safe' as const }
  const appr = (o: Partial<ApprovalRequest> = {}): ApprovalRequest => ({ sessionId: 's1', terminalId: 'h2', needed: 'write', reason: 'elevation', risk: 'safe', tool: 'exec_in_terminal', command: 'sudo systemctl restart nginx', ...o })
  it('授权卡标记：sudo 命令 / root 登录的写命令；多主机、只读、无关命令不标', () => {
    const { s } = setup()
    expect(s.decorate(appr()).sudo).toBe(true)
    expect(s.decorate(appr({ terminalId: 'h3', command: 'systemctl restart nginx' })).sudo).toBe(true)
    expect(s.decorate(appr({ terminalId: 'h3', command: 'ls /' })).sudo).toBeUndefined()
    expect(s.decorate(appr({ command: 'systemctl restart nginx' })).sudo).toBeUndefined()
    expect(s.decorate(appr({ tool: 'exec_on_terminals', targets: [{ terminalId: 't', hostKey: 'h2', label: 'x' }] })).sudo).toBeUndefined()
  })
  it('选了时长才记；期内同主机提权命令免卡（标「限时提权」），收回后恢复', () => {
    const { s, call, auth, events } = setup()
    const r = s.decorate(appr())
    s.onAnswer(r, { decision: 'allow' })
    expect(auth.listSudo('s1')).toEqual([])
    s.onAnswer(r, { decision: 'deny', sudoMinutes: 15 })
    expect(auth.listSudo('s1')).toEqual([])
    s.onAnswer(r, { decision: 'allow', sudoMinutes: 15 })
    expect(auth.listSudo('s1')).toHaveLength(1)
    expect(events).toContainEqual({ type: 'safety:changed', sessionId: 's1', what: 'sudo' })
    expect(s.leaseDecide('s1', 'h2', 'sudo apt-get install -y jq', prompt)).toEqual({ kind: 'allow', rule: SUDO_LEASE_RULE })
    expect(s.leaseDecide('s1', 'h2', 'apt-get install -y jq', prompt)).toBe(prompt)          // 不需要提权的照常
    expect(s.leaseDecide('s1', 'h1', 'sudo ls', prompt)).toBe(prompt)                        // 别的主机
    expect(s.leaseDecide('s2', 'h2', 'sudo ls', prompt)).toBe(prompt)                        // 别的会话
    expect(call('safety:sudoLeases', 's1')).toHaveLength(1)
    call('safety:revokeSudo', 's1', 'h2')
    expect(s.leaseDecide('s1', 'h2', 'sudo apt-get install -y jq', prompt)).toBe(prompt)
  })
})

describe('预演开关', () => {
  it('开关 / 执行选中步骤都发事件', () => {
    const { call, preview, events } = setup()
    call('safety:setPreview', 's1', true)
    expect(call('safety:preview', 's1')).toBe(true)
    call('safety:approvePlan', 's1', [{ terminal_id: 't1', command: 'ls' }])
    expect(preview.has('s1')).toBe(false)
    expect(events.filter((e) => e.what === 'preview')).toHaveLength(2)
  })
})
