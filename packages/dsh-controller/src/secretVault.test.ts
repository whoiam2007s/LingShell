import { describe, it, expect, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { checkSecretRefs, expandSecrets, maskToolText, type SecretSummary } from '@lingshell/shared'
import { terminalToolDefs, type TerminalToolDeps } from './terminalTools.js'
import { secretError, wireOf, type SecretVault } from './secretVault.js'

const V = 'S3cr3t-xyz-123'
const sums: SecretSummary[] = [{ id: 's1', name: 'demo', description: '演示', scope: 'local', targets: [], hasValue: true, createdAt: '', updatedAt: '' }]
const plains = [{ name: 'demo', value: V }]
const hostOf: Record<string, string> = { term_l: 'local', term_s: 'h1' }
// 与主进程同一套纯函数拼出的保险箱（主进程实现见 desktop/main/integrations/secretsIpc.ts）
const vault: SecretVault = {
  check: (tid, cmd) => (hostOf[tid] ? checkSecretRefs(cmd, sums, hostOf[tid], undefined, tid) : undefined),
  expand: (tid, cmd) => { const e = vault.check(tid, cmd); if (e) throw new Error(e); return expandSecrets(cmd, () => V) },
  mask: (s) => maskToolText(s, plains),
  prompt: () => '',
}

function deps(over: Partial<TerminalToolDeps> = {}) {
  // 假终端：按 wire（真正发进 shell 的）执行，echo 原样回显明文，并把命令回显留在快照里
  let screen = ''
  const execCapture = vi.fn(async (_id: string, cmd: string, _s?: AbortSignal, _t?: number, o?: { wire?: string }) => {
    const sent = o?.wire ?? cmd
    screen += `$ ${sent}\n`
    const m = /^echo '(.*)'$/.exec(sent)
    return { output: m ? m[1] : `ran ${sent}`, exitCode: 0 }
  })
  const d = {
    terminals: {
      list: () => [{ id: 'term_l', title: '本地', type: 'local', status: 'running', locked: false }, { id: 'term_s', title: 'web1', type: 'ssh', status: 'running', locked: false }],
      readSnapshot: () => screen,
      execCapture,
    },
    resolveHostKey: (t: string) => hostOf[t] ?? 'local',
    decide: () => ({ kind: 'allow' }),
    grant: vi.fn(), audit: vi.fn(),
    secretVault: vault,
    ...over,
  } as unknown as TerminalToolDeps
  return { d, execCapture }
}
const run = (d: TerminalToolDeps, name: string, args: object) =>
  terminalToolDefs(d).find((t) => t.name === name)!.execute(args as never, { agent: { id: 's' }, callId: 'c1' } as never) as Promise<string>

describe('密钥保险箱：网关校验', () => {
  it('范围不符 / 不存在 → 原因；范围内 / 没引用 → 放行；不支持的工具带占位符 → 拒', () => {
    expect(secretError(vault, 'exec_in_terminal', { terminal_id: 'term_l', command: 'echo {{secret:demo}}' })).toBeUndefined()
    expect(secretError(vault, 'exec_in_terminal', { terminal_id: 'term_s', command: 'echo {{secret:demo}}' })).toMatch(/^secret_scope/)
    expect(secretError(vault, 'exec_on_terminals', { terminal_ids: ['term_l', 'term_s'], command: 'echo {{secret:demo}}' })).toMatch(/^secret_scope/)
    expect(secretError(vault, 'start_background', { terminal_id: 'term_l', command: 'x {{secret:nope}}' })).toMatch(/^secret_not_found/)
    expect(secretError(vault, 'exec_in_terminal', { terminal_id: 'term_s', command: 'ls', explain: '{{secret:demo}}' })).toBeUndefined()
    expect(secretError(vault, 'write_file', { terminal_id: 'term_l', path: '/a', content: 'p={{secret:demo}}' })).toMatch(/^secret_unsupported.*printf/)
    expect(secretError(vault, 'run_on_hosts', { targets: ['h1'], command: 'echo {{secret:demo}}' })).toMatch(/^secret_unsupported/)
    expect(secretError(vault, 'propose_host_knowledge', { content: '用 {{secret:demo}} 登录' })).toBeUndefined()   // 知识卡里引用名称没问题
    expect(secretError(undefined, 'write_file', { content: '{{secret:demo}}' })).toBeUndefined()
    expect(wireOf(vault, 'term_l', 'ls')).toBeUndefined()
  })
})

describe('密钥保险箱：工具体', () => {
  it('exec_in_terminal：发进终端的是明文，回显 / 结果 / 读屏给模型的是占位符', async () => {
    const { d, execCapture } = deps()
    const out = JSON.parse(await run(d, 'exec_in_terminal', { terminal_id: 'term_l', command: 'echo {{secret:demo}}' }))
    expect(execCapture.mock.calls[0][1]).toBe('echo {{secret:demo}}')          // 回显 / 历史用占位符原文
    expect(execCapture.mock.calls[0][4]).toEqual({ wire: `echo '${V}'` })      // 真正发进 shell 的
    expect(out.output).toBe('{{secret:demo}}')
    expect(await run(d, 'read_terminal', { terminal_id: 'term_l' })).toBe("$ echo '{{secret:demo}}'\n")
    const audit = (d.audit as ReturnType<typeof vi.fn>).mock.calls.map((c) => JSON.stringify(c[0])).join('\n')
    expect(audit).toContain('echo {{secret:demo}}')
    expect(audit).not.toContain(V)
  })
  it('没有引用时不传 wire；用户在授权卡上改出越范围的引用 → 执行前抛错', async () => {
    const { d, execCapture } = deps({ takeUserOverride: () => ({ command: 'echo {{secret:nope}}' }) })
    await expect(run(d, 'exec_in_terminal', { terminal_id: 'term_l', command: 'ls' })).rejects.toThrow(/secret_not_found/)
    expect(execCapture).not.toHaveBeenCalled()
    const ok = deps()
    await run(ok.d, 'exec_in_terminal', { terminal_id: 'term_l', command: 'ls' })
    expect(ok.execCapture.mock.calls[0][4]).toBeUndefined()
  })
  it('start_background：先展开再包装（明文在包装的单引号里也正确转义）', async () => {
    const { d, execCapture } = deps()
    await run(d, 'start_background', { terminal_id: 'term_l', command: 'curl -u u:{{secret:demo}} x' }).catch(() => {})
    const [, shown, , , o] = execCapture.mock.calls[0]
    expect(shown).toContain('{{secret:demo}}')
    expect(o?.wire).toContain(`'\\''${V}'\\''`)
    expect(o?.wire).not.toContain('{{secret:')
  })
  it('exec_on_terminals：每台按自己的主机校验；输出先回写再截末尾', async () => {
    const long = 'x'.repeat(3990)   // 只留末尾 4000 字：不先回写的话开头会剩半截明文
    const { d } = deps({ terminals: {
      list: () => [{ id: 'term_l', title: '本地', type: 'local', status: 'running', locked: false }, { id: 'term_l2', title: '本地2', type: 'local', status: 'running', locked: false }],
      readSnapshot: () => '', execCapture: async () => ({ output: `${V}${long}`, exitCode: 0 }),
    } as never, resolveHostKey: () => 'local' })
    hostOf.term_l2 = 'local'
    const out = JSON.parse(await run(d, 'exec_on_terminals', { terminal_ids: ['term_l', 'term_l2'], command: 'echo {{secret:demo}}' }))
    expect(JSON.stringify(out)).not.toMatch(/cr3t|S3c/)
  })
  it('bash 实测：展开后的命令把值原样交给程序（任意特殊字符）', () => {
    const bash = process.platform === 'win32' ? ['C:\\Program Files\\Git\\bin\\bash.exe'].find((p) => existsSync(p)) : 'bash'
    if (!bash) return
    const tricky = `p'a"s$x\`y\\z !`
    for (const [cmd, want] of [[`printf '%s' {{secret:a}}`, tricky], [`printf '%s' "{{secret:a}}"`, tricky], [`printf '%s' 'x{{secret:a}}y'`, `x${tricky}y`]]) {
      expect(execFileSync(bash, ['-c', expandSecrets(cmd, () => tricky)], { encoding: 'utf8' })).toBe(want)
    }
  })
})
