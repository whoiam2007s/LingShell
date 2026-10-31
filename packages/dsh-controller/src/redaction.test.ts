import { describe, it, expect, vi } from 'vitest'
import { terminalToolDefs, type TerminalToolDeps } from './terminalTools.js'
import { withRedaction, placeholderError, REDACT_GUIDANCE } from './redaction.js'

const R = '[已脱敏]'
const PW = 'S3cr3t.Pa$$(1)'

function deps(on: boolean, over: Partial<TerminalToolDeps> = {}) {
  const writeFile = vi.fn(async (_t: string, p: string) => ({ path: p }))
  const execCapture = vi.fn(async (_id: string, cmd: string) => ({ output: `ran ${cmd}\nDB_PASSWORD=${PW}\nuser=root`, exitCode: 0 }))
  const d = {
    terminals: {
      list: () => [{ id: 'term_1', title: '本地', type: 'local', status: 'running', locked: false }],
      readSnapshot: () => `$ cat x\nhost pass ${PW}`,
      execCapture,
    },
    resolveHostKey: () => 'local',
    decide: () => ({ kind: 'allow' }),
    grant: vi.fn(), audit: vi.fn(),
    readFile: async (_t: string, p: string) => (p === '/none' ? undefined : `[db]\npassword = ${PW}\nport=3306\n`),
    writeFile,
    aiSecrets: () => (on ? [PW, 'abc'] : undefined),
    ...over,
  } as unknown as TerminalToolDeps
  return { d, writeFile, execCapture }
}
const exec = (callId = 'c1') => ({ agent: { id: 'sess_1' }, callId })
const run = (d: TerminalToolDeps, name: string, args: object) =>
  terminalToolDefs(d).find((t) => t.name === name)!.execute(args as never, exec() as never) as Promise<string>

describe('脱敏咽喉点：终端工具', () => {
  it('exec：已知值 + env 行都换，短已知值不动', async () => {
    const out = JSON.parse(await run(deps(true).d, 'exec_in_terminal', { terminal_id: 'term_1', command: 'env' }))
    expect(out.output).toBe(`ran env\nDB_PASSWORD=${R}\nuser=root`)
    expect(out.exit_code).toBe(0)
  })

  it('read_file / read_terminal', async () => {
    const f = JSON.parse(await run(deps(true).d, 'read_file', { terminal_id: 'term_1', path: '/etc/my.cnf' }))
    expect(f.content).toBe(`[db]\npassword = ${R}\nport=3306`)
    expect(await run(deps(true).d, 'read_terminal', { terminal_id: 'term_1' })).toBe(`$ cat x\nhost pass ${R}`)
  })

  it('报错文本也脱敏', async () => {
    const { d } = deps(true, { readFile: async () => { throw new Error(`auth failed for ${PW}`) } })
    await expect(run(d, 'read_file', { terminal_id: 'term_1', path: '/x' })).rejects.toThrow(`auth failed for ${R}`)
  })

  it('关闭 → 原样透传', async () => {
    const out = JSON.parse(await run(deps(false).d, 'exec_in_terminal', { terminal_id: 'term_1', command: 'env' }))
    expect(out.output).toContain(`DB_PASSWORD=${PW}`)
  })

  it('幂等：结果再过一遍不变', async () => {
    const { d } = deps(true)
    const once = await run(d, 'read_terminal', { terminal_id: 'term_1' })
    const again = await withRedaction({ name: 'x', execute: async () => once }, () => [PW]).execute()
    expect(again).toBe(once)
  })
})

describe('占位符护栏', () => {
  it('write_file 带占位符：拒绝且不写', async () => {
    const { d, writeFile } = deps(true)
    await expect(run(d, 'write_file', { terminal_id: 'term_1', path: '/etc/my.cnf', old_text: `password = ${R}`, new_text: 'password = x' }))
      .rejects.toThrow(/脱敏占位符/)
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('exec 带占位符：拒绝且不执行；explain 里出现不算', async () => {
    const { d, execCapture } = deps(true)
    await expect(run(d, 'exec_in_terminal', { terminal_id: 'term_1', command: `mysql -p'${R}'` })).rejects.toThrow(/不要把它写进文件或命令/)
    expect(execCapture).not.toHaveBeenCalled()
    await run(d, 'exec_in_terminal', { terminal_id: 'term_1', command: 'ls', explain: `看看 ${R}` })
    expect(execCapture).toHaveBeenCalledTimes(1)
  })

  it('拒绝时取走网关记下的 override（不残留）', async () => {
    const take = vi.fn()
    const { d } = deps(true, { takeUserOverride: take })
    await expect(run(d, 'write_file', { terminal_id: 'term_1', path: '/a', content: R })).rejects.toThrow()
    expect(take).toHaveBeenCalledWith('c1')
  })

  it('关闭脱敏时不拦（用户可能真要写这串字）', async () => {
    const { d, writeFile } = deps(false)
    await run(d, 'write_file', { terminal_id: 'term_1', path: '/a', content: R })
    expect(writeFile).toHaveBeenCalled()
  })

  it('只读工具不拦', () => {
    expect(placeholderError('read_file', { path: R })).toBeUndefined()
    expect(placeholderError('propose_plan', { steps: [{ command: R }] })).toMatch(/已拒绝/)
  })
})

describe('MCP / 任意工具包装', () => {
  it('MCP 结果文本脱敏；关掉透传；secrets 每次现取', async () => {
    let list: string[] | undefined = ['tok-123456']
    const def = withRedaction({ name: 'mcp__db__q', execute: async (_a: unknown, _e: unknown) => 'row: tok-123456 api_key=zzz' }, () => list)
    expect(await def.execute({}, {})).toBe(`row: ${R} api_key=${R}`)
    list = undefined
    expect(await def.execute({}, {})).toBe('row: tok-123456 api_key=zzz')
  })

  it('提示词说明含占位符', () => expect(REDACT_GUIDANCE).toContain(R))

  it('密钥保险箱：先回写成 {{secret:名称}}，样式脱敏不误伤占位符；脱敏关着也回写', async () => {
    const mask = (s: string) => s.split('S3cr3t-xyz-123').join('{{secret:demo}}')
    const out = JSON.stringify({ output: 'S3cr3t-xyz-123\napi_key=zzz' })
    const on = withRedaction({ name: 'exec_in_terminal', execute: async (_a: unknown, _e: unknown) => out }, () => [PW], undefined, mask)
    expect(JSON.parse(await on.execute({}, {})).output).toBe(`{{secret:demo}}\napi_key=${R}`)
    const off = withRedaction({ name: 'exec_in_terminal', execute: async (_a: unknown, _e: unknown) => out }, () => undefined, undefined, mask)
    expect(JSON.parse(await off.execute({}, {})).output).toBe('{{secret:demo}}\napi_key=zzz')
  })
})
