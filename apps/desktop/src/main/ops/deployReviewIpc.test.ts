// 部署评审主进程流程：假模型 + 本机 bash 充当目标主机（runner.exec 直接起 bash 跑预检脚本）
import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deployProbeScript, parseDeployProbe, type DeployReview, type HostSummary } from '@lingshell/shared'
import { execFileSync } from 'node:child_process'
import { registerDeployReview, probeReadOnly } from './deployReviewIpc.js'
import { DOC_TEXT_MAX_CHARS } from '../files/index.js'
import { isReadOnlyCommand } from './readonlyCommand.js'

const PLAN = {
  summary: '升级订单服务到 2.1',
  prerequisites: [
    { item: '磁盘', requirement: '/ 剩余 1G 以上', check: 'df -h /' },
    { item: 'JDK', requirement: '17', check: 'java -version 2>&1' },
    { item: '清理旧包', requirement: '无', check: 'rm -rf /tmp/never-run-this' },
    { item: '端口', requirement: '8080 空闲', check: 'echo port-free' },
  ],
  steps: [{ title: '停服务', command: 'systemctl stop order', downtime: true }, { title: '替换 jar', command: 'cp order-2.1.jar /opt/order/' }],
  configChanges: [], dbChanges: [], verify: ['curl health'], rollback: ['还原旧 jar'],
  risks: [{ level: 'high', category: '顺序', title: '先替换再停服务', detail: 'd' }],
}

function setup(opts: { prompts?: string[]; judge?: string; plan?: unknown; opens?: string[]; hold?: Promise<void> | (() => Promise<void> | undefined); onComplete?: () => void } = {}) {
  const handlers = new Map<string, (...a: unknown[]) => unknown>()
  const hosts: HostSummary[] = [{ id: 'h1', label: 'web1' } as HostSummary, { id: 'h2', label: 'web2' } as HostSummary]
  const prompts = opts.prompts ?? []
  const pick: string[][] = []
  registerDeployReview({
    handle: (ch, fn) => handlers.set(ch, fn), dir: mkdtempSync(join(tmpdir(), 'lingshell-dr-')),
    pickFiles: async () => pick.shift() ?? [],
    complete: async (s, u) => {
      prompts.push(s + '\n' + u)
      opts.onComplete?.()
      const hold = typeof opts.hold === 'function' ? opts.hold() : opts.hold
      if (hold) await hold
      return s.includes('部署清单') ? JSON.stringify(opts.plan ?? PLAN) : (opts.judge ?? '[{"i":0,"status":"pass","note":"够"},{"i":1,"status":"fail","note":"实际 11"}]')
    },
    redact: (t) => t.replace(/S3cret!pw/g, '[已脱敏]'),
    hosts: () => hosts,
    open: (h) => {
      opts.opens?.push(h.id)
      return async () => {
        if (h.id === 'h2') throw new Error('连不上')
        return { close: () => {}, exec: (cmd) => new Promise((res) => execFile('bash', ['-c', cmd.replace('java -version 2>&1', 'echo openjdk 11')], (e, out) => res({ code: e ? 1 : 0, output: out, truncated: false }))) }
      }
    },
    isReadOnly: isReadOnlyCommand,
    saveRunbook: (input) => ({ ...input, id: 'rb_1', updatedAt: '' }),
    savePdf: async () => undefined,
  })
  const call = <T,>(ch: string, ...a: unknown[]) => handlers.get(ch)!(undefined, ...a) as Promise<T> | T
  return { call, prompts, pick }
}

describe('预检只读判定', () => {
  const no = () => false
  it('放行固定形态（单行）', () => {
    expect(probeReadOnly('java -version 2>&1', no)).toBe(true)
    expect(probeReadOnly('timeout 3 bash -c "</dev/tcp/127.0.0.1/22" && echo open', no)).toBe(true)
    expect(probeReadOnly('ulimit -n', no)).toBe(true)
  })
  it('多行命令不能借版本形态绕过：crontab\\n-v 实际执行的是 crontab 本体', () => {
    expect(probeReadOnly('crontab\n-v', no)).toBe(false)
    expect(probeReadOnly('reboot\n-v', no)).toBe(false)
    expect(probeReadOnly('rm -rf /\n-v', no)).toBe(false)
  })
  it('回落到通用只读白名单', () => {
    expect(probeReadOnly('df -h /', isReadOnlyCommand)).toBe(true)
    expect(probeReadOnly('crontab\n-l', isReadOnlyCommand)).toBe(false)
    expect(probeReadOnly('crontab -l', isReadOnlyCommand)).toBe(true)
  })
})

describe('deployReview 主流程', () => {
  it('导入 → 解读 → 预检 → 评审意见 → 转手册', async () => {
    const prompts: string[] = []
    const { call, pick } = setup({ prompts })
    const r0 = await call<DeployReview>('deployReview:create')
    expect(r0.id).toMatch(/^dr_/)
    // 文档：导入 docx 之外的普通文本，第二次导入进历史
    const dir = mkdtempSync(join(tmpdir(), 'lingshell-drdoc-'))
    writeFileSync(join(dir, '订单服务部署.md'), '# 部署\n数据库密码 password=S3cret!pw\n```\nsystemctl stop order\n```')
    pick.push([join(dir, '订单服务部署.md')])
    let r = (await call<DeployReview>('deployReview:importDoc', r0.id))!
    expect(r.title).toBe('订单服务部署')
    r = await call<DeployReview>('deployReview:pasteDoc', r.id, 'v2.md', '# 部署 v2\npassword=S3cret!pw')
    expect(r.history.map((h) => h.name)).toEqual(['订单服务部署.md'])

    r = await call<DeployReview>('deployReview:analyze', r.id)
    expect(prompts[0]).not.toContain('S3cret!pw')   // 发给模型前脱敏
    expect(r.plan!.steps).toHaveLength(2)
    expect(r.risks.map((x) => x.id)).toContain('rule-secret')
    expect(r.risks.some((x) => x.source === 'ai' && x.title === '先替换再停服务')).toBe(true)
    expect(r.risks.find((x) => x.id === 'rule-secret')!.evidence).not.toContain('S3cret!pw')

    // 评审意见：重新解读后保留
    const aiId = r.risks.find((x) => x.source === 'ai')!.id
    r = await call<DeployReview>('deployReview:update', r.id, { hostIds: ['h1', 'h2'], reviewer: '张三', decisions: { [aiId]: { decision: 'ignore', note: '实际先停了' } } })
    r = await call<DeployReview>('deployReview:analyze', r.id)
    expect(r.risks.find((x) => x.id === aiId)).toMatchObject({ decision: 'ignore', note: '实际先停了' })

    r = await call<DeployReview>('deployReview:probe', r.id)
    const web1 = r.probes.filter((x) => x.hostId === 'h1')
    expect(web1.map((x) => [x.item, x.status])).toEqual([['磁盘', 'pass'], ['JDK', 'fail'], ['清理旧包', 'skipped'], ['端口', 'warn']])
    expect(web1[1].output).toBe('openjdk 11')
    expect(web1[3].output).toBe('port-free')
    expect(r.probes.filter((x) => x.hostId === 'h2').every((x) => x.status === 'error' || x.status === 'skipped')).toBe(true)
    expect(r.risks.map((x) => x.title)).toEqual(expect.arrayContaining(['1 台主机不满足：JDK', '1 台主机没能检查：磁盘']))

    expect(await call('deployReview:toRunbook', r.id)).toBe('rb_1')
    expect((await call<{ id: string }[]>('deployReview:list')).map((x) => x.id)).toEqual([r.id])
    await call('deployReview:delete', r.id)
    expect(await call<unknown[]>('deployReview:list')).toEqual([])
  })
  it('id 不能越出目录', async () => {
    const { call } = setup()
    expect(() => call('deployReview:get', '../x')).toThrow('评审不存在')
  })
  it('风险备注可以清空', async () => {
    const { call } = setup()
    let r = await call<DeployReview>('deployReview:create')
    r = await call<DeployReview>('deployReview:pasteDoc', r.id, 'd.md', '# 部署\n回滚 还原，验证 curl')
    r = await call<DeployReview>('deployReview:analyze', r.id)
    const aiId = r.risks.find((x) => x.source === 'ai')!.id
    r = await call<DeployReview>('deployReview:update', r.id, { decisions: { [aiId]: { decision: 'ignore', note: '已知顺序问题' } } })
    expect(r.risks.find((x) => x.id === aiId)).toMatchObject({ decision: 'ignore', note: '已知顺序问题' })
    r = await call<DeployReview>('deployReview:update', r.id, { decisions: { [aiId]: { decision: 'ignore', note: '' } } })
    expect(r.risks.find((x) => x.id === aiId)!.note).toBeUndefined()
  })
  it('全是非只读检查时不连主机，直接标未执行', async () => {
    const opens: string[] = []
    const plan = { ...PLAN, prerequisites: [{ item: '清理旧包', requirement: '无', check: 'rm -rf /tmp/x' }], risks: [] }
    const { call } = setup({ plan, opens })
    let r = await call<DeployReview>('deployReview:create')
    r = await call<DeployReview>('deployReview:pasteDoc', r.id, 'd.md', '# 部署\n回滚 还原，验证 curl')
    r = await call<DeployReview>('deployReview:analyze', r.id)
    r = await call<DeployReview>('deployReview:update', r.id, { hostIds: ['h1', 'h2'] })
    r = await call<DeployReview>('deployReview:probe', r.id)
    expect(opens).toEqual([])
    expect(r.probes.map((x) => x.status)).toEqual(['skipped', 'skipped'])
  })
  it('解读期间评审被删除：不要把它写回来', async () => {
    let release!: () => void
    const hold = new Promise<void>((r) => { release = r })
    let started!: () => void
    const startedP = new Promise<void>((r) => { started = r })
    const { call } = setup({ hold, onComplete: () => started() })
    let r = await call<DeployReview>('deployReview:create')
    r = await call<DeployReview>('deployReview:pasteDoc', r.id, 'd.md', '# 部署\n回滚 还原，验证 curl')
    const p = Promise.resolve(call<DeployReview>('deployReview:analyze', r.id))
    await startedP
    await call('deployReview:delete', r.id)
    release()
    await expect(p).rejects.toThrow('评审已被删除')
    expect(await call<unknown[]>('deployReview:list')).toEqual([])
  })
  it('解读期间改过的处理意见不丢', async () => {
    let release!: () => void, armed = false
    const gate = new Promise<void>((x) => { release = x })
    let started!: () => void
    const startedP = new Promise<void>((r) => { started = r })
    const { call } = setup({ hold: () => (armed ? gate : undefined), onComplete: () => { if (armed) started() } })
    let r = await call<DeployReview>('deployReview:create')
    r = await call<DeployReview>('deployReview:pasteDoc', r.id, 'd.md', '# 部署\n回滚 还原，验证 curl')
    r = await call<DeployReview>('deployReview:analyze', r.id)   // 第一次：不挂起
    const aiId = r.risks.find((x) => x.source === 'ai')!.id
    armed = true
    const p = Promise.resolve(call<DeployReview>('deployReview:analyze', r.id))
    await startedP
    await call('deployReview:update', r.id, { decisions: { [aiId]: { decision: 'rework', note: '等研发改' } } })
    release()
    await p
    const after = await call<DeployReview>('deployReview:get', r.id)
    expect(after.risks.find((x) => x.id === aiId)).toMatchObject({ decision: 'rework', note: '等研发改' })
  })
  it('粘贴超长文档被拒绝', async () => {
    const { call } = setup()
    const r = await call<DeployReview>('deployReview:create')
    expect(() => call('deployReview:pasteDoc', r.id, 'x.md', 'x'.repeat(DOC_TEXT_MAX_CHARS + 1))).toThrow('文档文字过长')
  })
})

describe('预检脚本在真 shell 里', () => {
  it('bash / sh：输出、退出码、命令结尾的注释不吞括号', () => {
    const s = deployProbeScript(['echo hi', 'exit 2 # 注释', 'printf x; false'])
    for (const sh of ['bash', 'sh']) expect(parseDeployProbe(execFileSync(sh, ['-c', s], { encoding: 'utf8' }), 3)).toEqual([{ output: 'hi', code: 0 }, { output: '', code: 2 }, { output: 'x', code: 1 }])
  })
})
