import { describe, it, expect, vi } from 'vitest'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { PlanBook, planDecision, planToolDef, sanitizeSteps, type PlanRequest } from './plan.js'

const hostOf = (t: string) => (t === 'term_ssh' ? 'host_a' : 'local')
function deps(kind: 'allow' | 'prompt' | 'deny' = 'prompt') {
  return {
    resolveHostKey: hostOf,
    decide: vi.fn(() => (kind === 'deny' ? { kind, reason: 'readonly: write not allowed' } : kind === 'prompt' ? { kind, reason: 'first_access', risk: 'safe' } : { kind })) as never,
    audit: vi.fn(),
  }
}
const run = (command: string, terminal_id = 'term_1') => ({ terminal_id, command })

describe('PlanBook', () => {
  it('同主机逐字（去首尾空白）匹配，每步只能用一次', () => {
    const b = new PlanBook()
    b.approve('s1', [{ hostKey: 'local', command: ' apt install nginx ' }])
    expect(b.consume('s1', 'host_a', 'apt install nginx')).toBe(false)   // 主机不同
    expect(b.consume('s1', 'local', 'apt  install nginx')).toBe(false)   // 中间空白不同不算
    expect(b.consume('s1', 'local', '\tapt install nginx\n')).toBe(true)
    expect(b.consume('s1', 'local', 'apt install nginx')).toBe(false)    // 已用
  })

  it('重复命令的两步各能用一次；会话之间互不影响', () => {
    const b = new PlanBook()
    b.approve('s1', [{ hostKey: 'local', command: 'make' }, { hostKey: 'local', command: 'make' }])
    expect(b.consume('s2', 'local', 'make')).toBe(false)
    expect(b.consume('s1', 'local', 'make')).toBe(true)
    expect(b.consume('s1', 'local', 'make')).toBe(true)
    expect(b.consume('s1', 'local', 'make')).toBe(false)
  })

  it('clear（轮结束）后计划失效；新计划替换旧计划', () => {
    const b = new PlanBook()
    b.approve('s1', [{ hostKey: 'local', command: 'a' }, { hostKey: 'local', command: 'b' }])
    b.clear('s1')
    expect(b.remaining('s1')).toBe(0)
    expect(b.consume('s1', 'local', 'a')).toBe(false)
    b.approve('s1', [{ hostKey: 'local', command: 'a' }])
    b.approve('s1', [{ hostKey: 'local', command: 'c' }])
    expect(b.consume('s1', 'local', 'a')).toBe(false)
    expect(b.consume('s1', 'local', 'c')).toBe(true)
  })
})

describe('planDecision', () => {
  it('命中计划：放行并落 allow:plan（即便常规决策要弹卡/危险命令）', () => {
    const b = new PlanBook(); const d = deps('prompt')
    b.approve('s1', [{ hostKey: 'host_a', command: 'rm -rf /var/cache/app' }])
    expect(planDecision(d, b, 's1', 'exec_in_terminal', run('rm -rf /var/cache/app', 'term_ssh'))).toEqual({ kind: 'allow' })
    expect(d.audit).toHaveBeenCalledWith({ sessionId: 's1', terminalId: 'term_ssh', command: 'rm -rf /var/cache/app', decision: 'allow:plan' })
    // 第二次同命令不再放行，交回常规流程
    expect(planDecision(d, b, 's1', 'exec_in_terminal', run('rm -rf /var/cache/app', 'term_ssh'))).toBeUndefined()
  })

  it('计划外命令 / 非 exec 工具 → undefined（走常规授权）', () => {
    const b = new PlanBook(); const d = deps()
    b.approve('s1', [{ hostKey: 'local', command: 'ls' }])
    expect(planDecision(d, b, 's1', 'exec_in_terminal', run('pwd'))).toBeUndefined()
    expect(planDecision(d, b, 's1', 'start_background', run('ls'))).toBeUndefined()
    expect(planDecision(d, b, 's1', 'exec_in_terminal', { command: 'ls' })).toBeUndefined()
    expect(b.remaining('s1')).toBe(1)
    expect(d.audit).not.toHaveBeenCalled()
  })

  it('写文件步骤：write_file 写同主机同路径放行（每步一次）；路径不同 / exec 同名文本都不算', () => {
    const b = new PlanBook(); const d = deps('prompt')
    b.approve('s1', sanitizeSteps([
      { terminal_id: 'term_ssh', command: 'write_file(/tmp/p/a/README.txt, content="a")', path: ' /tmp/p/a/README.txt ' },
      { terminal_id: 'term_ssh', command: 'mkdir -p /tmp/p/a' },
    ]).map((s) => ({ hostKey: hostOf(s.terminal_id), command: s.command, path: s.path })))
    const write = (path: string) => ({ terminal_id: 'term_ssh', path, content: 'a' })
    expect(planDecision(d, b, 's1', 'write_file', write('/tmp/p/b/README.txt'))).toBeUndefined()
    expect(planDecision(d, b, 's1', 'exec_in_terminal', run('write_file(/tmp/p/a/README.txt, content="a")', 'term_ssh'))).toBeUndefined()
    expect(planDecision(d, b, 's1', 'write_file', write('/tmp/p/a/README.txt'))).toEqual({ kind: 'allow' })
    expect(d.audit).toHaveBeenCalledWith({ sessionId: 's1', terminalId: 'term_ssh', command: '写入 /tmp/p/a/README.txt', decision: 'allow:plan' })
    expect(planDecision(d, b, 's1', 'write_file', write('/tmp/p/a/README.txt'))).toBeUndefined()   // 已用
    expect(planDecision(d, b, 's1', 'exec_in_terminal', run('mkdir -p /tmp/p/a', 'term_ssh'))).toEqual({ kind: 'allow' })
  })

  it('只读信任档：计划内也不放行，且不消耗步骤', () => {
    const b = new PlanBook(); const d = deps('deny')
    b.approve('s1', [{ hostKey: 'local', command: 'ls' }])
    expect(planDecision(d, b, 's1', 'exec_in_terminal', run('ls'))).toBeUndefined()
    expect(b.remaining('s1')).toBe(1)
  })
})

describe('propose_plan 工具', () => {
  const exec = (signal?: AbortSignal) => ({ agent: { id: 'dsh_1' }, signal })
  const setup = (answer: (req: PlanRequest) => unknown) => {
    const book = new PlanBook()
    const requestPlan = vi.fn(async (req: PlanRequest) => answer(req)) as never
    const def = planToolDef({ resolveHostKey: hostOf, requestPlan, sessionIdOf: () => 's1' }, book)
    return { book, def, requestPlan: requestPlan as ReturnType<typeof vi.fn> }
  }
  const args = { title: '装 nginx', steps: [
    { terminal_id: 'term_ssh', command: 'apt install -y nginx', purpose: '安装' },
    { terminal_id: 'term_ssh', command: 'rm -rf /etc/nginx/sites-enabled/default', purpose: '删默认站点' },
    { terminal_id: 'term_ssh', command: 'systemctl restart nginx', purpose: '重启' },
  ] }

  it('schema 能被 dsh defineTool 接受', () => {
    const { def } = setup(() => ({ decision: 'allow' }))
    expect(() => defineTool(def as never)).not.toThrow()
  })

  it('请求带主机与危险标记；批准（删改后）的步骤记入 PlanBook 并回给模型', async () => {
    const { def, book, requestPlan } = setup(() => ({ decision: 'allow', steps: [
      { terminal_id: 'term_ssh', command: 'apt install -y nginx-full' },
      { terminal_id: 'term_ssh', command: 'systemctl restart nginx' },
      { terminal_id: 'term_other', command: 'whoami' },   // 原计划没有的终端：不认
    ] }))
    const out = JSON.parse(await def.execute(args, exec()))
    const req = requestPlan.mock.calls[0][0] as PlanRequest
    expect(req).toMatchObject({ sessionId: 's1', title: '装 nginx' })
    expect(req.steps.map((s) => [s.hostKey, s.dangerous])).toEqual([['host_a', false], ['host_a', true], ['host_a', false]])
    expect(out.steps.map((s: { command: string }) => s.command)).toEqual(['apt install -y nginx-full', 'systemctl restart nginx'])
    expect(book.remaining('s1')).toBe(2)
    expect(book.consume('s1', 'host_a', 'apt install -y nginx')).toBe(false)   // 原命令已被改掉
    expect(book.consume('s1', 'host_a', 'apt install -y nginx-full')).toBe(true)
  })

  it('拒绝：带原因抛给模型，不记计划', async () => {
    const { def, book } = setup(() => ({ decision: 'deny', note: '先备份配置' }))
    await expect(def.execute(args, exec())).rejects.toThrow('用户拒绝了计划。原因：先备份配置')
    expect(book.remaining('s1')).toBe(0)
  })

  it('turn 取消时不再挂着等用户', async () => {
    const ac = new AbortController()
    const { def } = setup(() => new Promise(() => {}))
    const p = def.execute(args, exec(ac.signal))
    ac.abort()
    await expect(p).rejects.toThrow('aborted')
  })
})

describe('sanitizeSteps', () => {
  it('丢掉缺字段/空命令的步骤，命令去首尾空白', () => {
    expect(sanitizeSteps([{ terminal_id: 't', command: '  ls ' }, { terminal_id: 't', command: ' ' }, { command: 'x' }, null])).toEqual([{ terminal_id: 't', command: 'ls' }])
    expect(sanitizeSteps('nope')).toEqual([])
  })
})
