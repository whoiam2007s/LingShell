import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { describe, it, expect, vi } from 'vitest'
import {
  terminalToolDefs, decideFor, commitGrant, terminalIdOf, type TerminalToolDeps,
  buildStartBackgroundCommand, buildCheckBackgroundCommand, parseStartBackgroundOutput, parseCheckBackgroundOutput,
  newJobId, isJobId, JOB_DIR, applyEdit, sliceLines, groupSameOutput, approvalView, explainOf, describeCall,
  rollbackOf, missingRollback, rollbackDeny,
} from './terminalTools.js'

function deps(over: Partial<TerminalToolDeps> = {}): TerminalToolDeps & { audit: ReturnType<typeof vi.fn>; grant: ReturnType<typeof vi.fn> } {
  const audit = vi.fn(); const grant = vi.fn()
  return {
    terminals: {
      list: () => [
        { id: 'term_1', title: '本地', type: 'local', status: 'running', locked: false },
        { id: 'term_ssh', title: 'A', type: 'ssh', status: 'running', locked: false },
      ],
      readSnapshot: () => 'SNAP',
      execCapture: async (_id: string, cmd: string) => ({ output: `ran ${cmd}`, exitCode: 0 }),
    },
    resolveHostKey: (t: string) => (t === 'term_ssh' ? 'host_a' : 'local'),
    decide: () => ({ kind: 'allow' }),
    grant, audit,
    ...over,
  } as never
}
// exec 的第二参：工具体靠 exec.agent.id 认会话
const exec = (extra: Record<string, unknown> = {}) => ({ agent: { id: 'sess_1' }, ...extra })
const defOf = (d: TerminalToolDeps, name: string) => terminalToolDefs(d).find((t: { name: string }) => t.name === name)!

describe('工具定义', () => {
  it('十六个工具齐全，顺序稳定', () => {
    const names = terminalToolDefs(deps()).map((t) => t.name)
    expect(names).toEqual(['list_terminals', 'read_terminal', 'exec_in_terminal', 'exec_on_terminals', 'start_background', 'check_background', 'wait', 'create_terminal', 'propose_host_knowledge', 'propose_quick_commands', 'propose_runbook', 'run_on_hosts', 'upload_file', 'read_file', 'write_file', 'download_file'])
  })

  it('propose_quick_commands / propose_runbook：只校验不写、无需授权；不合法报错回给模型', async () => {
    const d = deps()
    const q = JSON.parse(await defOf(d, 'propose_quick_commands').execute({ set_name: 'nginx', commands: [{ name: '状态', command: 'systemctl status nginx' }] } as never, exec() as never))
    expect(q).toMatchObject({ ok: true, set_name: 'nginx', count: 1 })
    await expect(defOf(d, 'propose_quick_commands').execute({ set_name: '', commands: [] } as never, exec() as never)).rejects.toThrow(/set_name/)
    const r = JSON.parse(await defOf(d, 'propose_runbook').execute({ title: '排查', steps: [{ title: '看', command: 'tail {{log}}' }] } as never, exec() as never))
    expect(r).toMatchObject({ ok: true, title: '排查', steps: 1, params: ['log'] })
    await expect(defOf(d, 'propose_runbook').execute({ title: 'x', steps: [] } as never, exec() as never)).rejects.toThrow(/步骤/)
    expect(decideFor(d, 'sess_1', 'propose_runbook', {})).toEqual({ kind: 'allow' })
    expect(decideFor(d, 'sess_1', 'propose_quick_commands', {})).toEqual({ kind: 'allow' })
    expect(d.audit).not.toHaveBeenCalled()
  })

  it('wait：按秒等待（夹在 1–300），无需授权，turn 取消时立即结束', async () => {
    vi.useFakeTimers()
    try {
      const p = defOf(deps(), 'wait').execute({ seconds: 2 } as never, exec() as never)
      await vi.advanceTimersByTimeAsync(2000)
      expect(JSON.parse(await p)).toEqual({ waited_seconds: 2 })
      const ac = new AbortController()
      const q = defOf(deps(), 'wait').execute({ seconds: 9999 } as never, exec({ signal: ac.signal }) as never)
      ac.abort()
      await expect(q).rejects.toThrow('aborted')
    } finally { vi.useRealTimers() }
    expect(decideFor(deps(), 'sess_1', 'wait', { seconds: 5 })).toEqual({ kind: 'allow' })
  })

  it('终端不存在（重启后旧 id）：直接拒，不去问授权（否则会回落成「本地」的授权卡）', () => {
    const decide = vi.fn()
    const d = deps({ decide } as never)
    expect(decideFor(d, 'sess_1', 'exec_in_terminal', { terminal_id: 'term_old', command: 'ls' }))
      .toEqual({ kind: 'deny', reason: expect.stringContaining('terminal_not_found') })
    expect(decide).not.toHaveBeenCalled()
  })

  it('仅手动终端（PowerShell 等）：执行类工具直接拒并说明原因，不弹授权；读屏 / 文件工具照常', () => {
    const decide = vi.fn(() => ({ kind: 'allow' as const }))
    const base = deps().terminals
    const d = deps({ decide, terminals: { ...base, list: () => [...base.list(), { id: 'term_ps', title: 'PowerShell 1', type: 'local', status: 'running', locked: false, shell: 'powershell', manualOnly: true }] } } as never)
    for (const [tool, args] of [
      ['exec_in_terminal', { terminal_id: 'term_ps', command: 'ls' }],
      ['start_background', { terminal_id: 'term_ps', command: 'make' }],
      ['check_background', { terminal_id: 'term_ps', job_id: '0123456789abcdef' }],
      ['exec_on_terminals', { terminal_ids: ['term_1', 'term_ps'], command: 'ls' }],
    ] as const) {
      expect(decideFor(d, 'sess_1', tool, args)).toEqual({ kind: 'deny', reason: expect.stringMatching(/^shell_not_supported: 终端 term_ps（PowerShell 1）是仅手动终端/) })
    }
    expect(decide).not.toHaveBeenCalled()
    expect(decideFor(d, 'sess_1', 'read_terminal', { terminal_id: 'term_ps' })).toEqual({ kind: 'allow' })
    expect(decideFor(d, 'sess_1', 'exec_in_terminal', { terminal_id: 'term_1', command: 'ls' })).toEqual({ kind: 'allow' })
  })

  it('check_background 在远端等待，等待时长按命令超时收紧（留 10 秒）', async () => {
    const execCapture = vi.fn(async (_tid: string, _cmd: string) => ({ output: '__LINGSHELL_JOB_STATUS__ running\n', exitCode: 0 }))
    const d = deps({ terminals: { ...deps().terminals, execCapture } as never, execTimeoutMs: () => 50_000 })
    await defOf(d, 'check_background').execute({ terminal_id: 'term_1', job_id: '0123456789abcdef', wait_seconds: 999 } as never, exec() as never)
    expect(execCapture.mock.calls[0][1]).toContain('$i -lt 40 ]')       // 50s 超时 → 最多等 40s
    await defOf(d, 'check_background').execute({ terminal_id: 'term_1', job_id: '0123456789abcdef' } as never, exec() as never)
    expect(execCapture.mock.calls[1][1]).toContain('$i -lt 30 ]')       // 默认 30s
  })

  it('list_terminals / create_terminal 带上知识卡标题与分级', async () => {
    const hostMeta = (tid: string) => (tid === 'term_1' ? { knowledge: ['nginx 日志位置'], env: 'prod' as const } : {})
    const d = deps({ hostMeta, createLocalTerminal: async () => ({ terminalId: 'term_1', title: 'T' }) })
    expect(JSON.parse(await defOf(d, 'list_terminals').execute({} as never, exec() as never)))
      .toEqual([
        { id: 'term_1', title: '本地', type: 'local', status: 'running', locked: false, knowledge: ['nginx 日志位置'], env: 'prod' },
        { id: 'term_ssh', title: 'A', type: 'ssh', status: 'running', locked: false },
      ])
    expect(JSON.parse(await defOf(d, 'create_terminal').execute({ type: 'local' } as never, exec() as never)))
      .toMatchObject({ terminalId: 'term_1', knowledge: ['nginx 日志位置'], env: 'prod' })
  })

  it('list_terminals 带最近知道的 cwd（没有就不带），问目录不必为此跑 pwd', async () => {
    const d = deps({ terminalCwd: (id) => (id === 'term_1' ? 'C:\\Users\\x' : undefined) })
    const out = JSON.parse(await defOf(d, 'list_terminals').execute({} as never, exec() as never)) as { id: string; cwd?: string }[]
    expect(out.find((x) => x.id === 'term_1')?.cwd).toBe('C:\\Users\\x')
    expect(out.find((x) => x.id === 'term_ssh')?.cwd).toBeUndefined()
  })

  it('propose_host_knowledge：按终端解析主机 / 分组 / 全局 / 按 card_id 更新，只提议不写；参数不全报错；无需授权', async () => {
    const proposeKnowledge = vi.fn(() => ({ targetLabel: '主机「本机」' }))
    const d = deps({ proposeKnowledge })
    const run = (a: Record<string, unknown>) => defOf(d, 'propose_host_knowledge').execute(a as never, exec() as never)
    const out = JSON.parse(await run({ terminal_id: 'term_1', title: ' 日志 ', content: ' 在 /var/log/x ', category: 'logs' }))
    expect(proposeKnowledge).toHaveBeenCalledWith('sess_1', { scope: 'host', target: 'local', title: '日志', content: '在 /var/log/x', category: 'logs' })
    expect(out).toMatchObject({ ok: true, target: '主机「本机」' })
    await run({ terminal_id: 'term_ssh', title: 't', content: 'c' })
    expect(proposeKnowledge).toHaveBeenLastCalledWith('sess_1', expect.objectContaining({ scope: 'host', target: 'host_a' }))
    await run({ scope: 'group', group: 'web', title: 't', content: 'c' })
    expect(proposeKnowledge).toHaveBeenLastCalledWith('sess_1', expect.objectContaining({ scope: 'group', target: 'web' }))
    await run({ scope: 'global', title: 't', content: 'c' })
    expect(proposeKnowledge).toHaveBeenLastCalledWith('sess_1', expect.objectContaining({ scope: 'global', target: '' }))
    await run({ card_id: 'kb_1', title: 't', content: 'c' })   // 只给 card_id：归属由主进程沿用原卡
    expect(proposeKnowledge).toHaveBeenLastCalledWith('sess_1', { cardId: 'kb_1', title: 't', content: 'c', category: undefined })
    await expect(run({ terminal_id: 'nope', title: 't', content: 'c' })).rejects.toThrow(/终端不存在/)
    await expect(run({ terminal_id: 'term_1', title: ' ', content: 'c' })).rejects.toThrow(/不能为空/)
    await expect(run({ scope: 'group', title: 't', content: 'c' })).rejects.toThrow(/group/)
    await expect(run({ title: 't', content: 'c' })).rejects.toThrow(/归属/)
    expect(decideFor(d, 'sess_1', 'propose_host_knowledge', { terminal_id: 'term_1', title: 't', content: 'c' })).toEqual({ kind: 'allow' })
  })

  it('exec_in_terminal 透传 signal 与超时，并把退出码写进审计', async () => {
    const execCapture = vi.fn(async () => ({ output: 'ok', exitCode: 3, truncated: true }))
    const d = deps({ terminals: { ...deps().terminals, execCapture } as never, execTimeoutMs: () => 5000 })
    const sig = new AbortController().signal
    const out = await defOf(d, 'exec_in_terminal').execute({ terminal_id: 'term_1', command: 'ls' } as never, exec({ signal: sig }) as never)
    expect(execCapture).toHaveBeenCalledWith('term_1', 'ls', sig, 5000)
    expect(JSON.parse(out)).toEqual({ output: 'ok', exit_code: 3, truncated: true })
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess_1', decision: 'exec_allowed', exitCode: 3 }))
  })

  it('变更保险：改动类工具执行前先调 beforeChange（命令 / 多主机 / 写文件不带命令），它出错也照常执行', async () => {
    const order: string[] = []
    const beforeChange = vi.fn(async (_s: string, tids: string[], cmd?: string) => { order.push(`before ${tids.join(',')} ${cmd ?? '-'}`) })
    const execCapture = vi.fn(async (_id: string, cmd: string) => { order.push(`run ${cmd}`); return { output: '', exitCode: 0 } })
    const d = deps({ terminals: { ...deps().terminals, execCapture } as never, beforeChange,
      readFile: async () => 'a', writeFile: async (_t, p) => { order.push(`write ${p}`); return { path: p } } })
    await defOf(d, 'exec_in_terminal').execute({ terminal_id: 'term_ssh', command: 'touch x' } as never, exec() as never)
    await defOf(d, 'exec_on_terminals').execute({ terminal_ids: ['term_1', 'term_ssh'], command: 'sed -i s/a/b/ f' } as never, exec() as never)
    await defOf(d, 'write_file').execute({ terminal_id: 'term_ssh', path: '/etc/f', content: 'b' } as never, exec() as never)
    expect(order).toEqual(['before term_ssh touch x', 'run touch x', 'before term_1,term_ssh sed -i s/a/b/ f', 'run sed -i s/a/b/ f', 'run sed -i s/a/b/ f', 'before term_ssh -', 'write /etc/f'])
    expect(beforeChange.mock.calls[0][0]).toBe('sess_1')
    const bad = deps({ beforeChange: async () => { throw new Error('boom') } })
    expect(JSON.parse(await defOf(bad, 'exec_in_terminal').execute({ terminal_id: 'term_1', command: 'touch y' } as never, exec() as never))).toMatchObject({ exit_code: 0 })
  })

  it('create_terminal：ssh 缺 hostId 报错；local 走本地回调并带上会话 id', async () => {
    const createLocalTerminal = vi.fn(async () => ({ terminalId: 'term_9', title: 'T9' }))
    const d = deps({ createLocalTerminal })
    await expect(defOf(d, 'create_terminal').execute({ type: 'ssh' } as never, exec() as never)).rejects.toThrow(/hostId/)
    const out = await defOf(d, 'create_terminal').execute({ type: 'local' } as never, exec() as never)
    expect(createLocalTerminal).toHaveBeenCalledWith('sess_1')
    expect(JSON.parse(out)).toMatchObject({ ok: true, terminalId: 'term_9' })
  })

  it('授权卡改过命令：执行改后的命令，并在结果里告诉模型', async () => {
    const execCapture = vi.fn(async (_id: string, cmd: string) => ({ output: `ran ${cmd}`, exitCode: 0 }))
    const d = deps({ terminals: { ...deps().terminals, execCapture } as never, takeUserOverride: (id) => (id === 'c1' ? { command: 'ls -a' } : undefined) })
    const out = JSON.parse(await defOf(d, 'exec_in_terminal').execute({ terminal_id: 'term_1', command: 'rm -rf x' } as never, exec({ callId: 'c1' }) as never))
    expect(execCapture).toHaveBeenCalledWith('term_1', 'ls -a', undefined, undefined)
    expect(out).toMatchObject({ executed_command: 'ls -a', output: 'ran ls -a' })
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({ command: 'ls -a', decision: 'exec_allowed:edited' }))
  })

  it('带原因的拒绝：不执行，原因作为错误交给模型', async () => {
    const execCapture = vi.fn()
    const d = deps({ terminals: { ...deps().terminals, execCapture } as never, takeUserOverride: () => ({ deny: '先在测试机试' }) })
    await expect(defOf(d, 'exec_in_terminal').execute({ terminal_id: 'term_1', command: 'x' } as never, exec({ callId: 'c2' }) as never))
      .rejects.toThrow('用户拒绝执行。原因：先在测试机试')
    expect(execCapture).not.toHaveBeenCalled()
  })

  it('会话 id 按 sessionIdOf 映射（上下文重置后 dsh id ≠ 我方 id）', async () => {
    const createLocalTerminal = vi.fn(async () => ({ terminalId: 't', title: 'T' }))
    const d = deps({ createLocalTerminal, sessionIdOf: (a) => (a === 'sess_1_r1' ? 'sess_1' : a) })
    await defOf(d, 'create_terminal').execute({ type: 'local' } as never, { agent: { id: 'sess_1_r1' } } as never)
    expect(createLocalTerminal).toHaveBeenCalledWith('sess_1')
  })

  it('upload_file 未注入回调时明确报错，不静默成功', async () => {
    await expect(defOf(deps(), 'upload_file').execute(
      { local_path: 'a', terminal_id: 'term_ssh', target_dir: '/t' } as never, exec() as never,
    )).rejects.toThrow(/不可用/)
  })
})

describe('授权网关 decideFor', () => {
  it('无需授权的工具直接放行，不去问 AuthRegistry', () => {
    const decide = vi.fn()
    const d = deps({ decide })
    expect(decideFor(d, 'sess_1', 'list_terminals', {})).toEqual({ kind: 'allow' })
    expect(decideFor(d, 'sess_1', 'create_terminal', { type: 'local' })).toEqual({ kind: 'allow' })
    expect(decide).not.toHaveBeenCalled()
  })

  it('按 hostKey 而非 terminalId 决策（同主机多终端共享授权）', () => {
    const decide = vi.fn(() => ({ kind: 'allow' as const }))
    const d = deps({ decide, isReadOnly: (c) => /^ls\b/.test(c) })
    decideFor(d, 'sess_1', 'exec_in_terminal', { terminal_id: 'term_ssh', command: 'ls' })
    expect(decide).toHaveBeenCalledWith('sess_1', 'host_a', 'read', 'ls')   // 只读命令按读取，不把主机升成写入
  })

  it('只读命令按 read、写命令按 write（同一工具按命令区分）', () => {
    const decide: any = vi.fn(() => ({ kind: 'allow' as const }))
    const d = deps({ decide, isReadOnly: (c) => /^(pwd|tail)\b/.test(c) })
    decideFor(d, 'sess_1', 'exec_in_terminal', { terminal_id: 'term_ssh', command: 'pwd' })
    decideFor(d, 'sess_1', 'exec_in_terminal', { terminal_id: 'term_ssh', command: 'systemctl restart nginx' })
    decideFor(d, 'sess_1', 'start_background', { terminal_id: 'term_ssh', command: 'tail -f /var/log/x' })
    // start_background 会留下持续进程，即使命令只读也仍是写入档
    expect(decide.mock.calls.map((c: unknown[]) => c[2])).toEqual(['read', 'write', 'write'])
  })

  it('read_terminal 要 read、exec/upload 要 write', () => {
    const decide: any = vi.fn(() => ({ kind: 'allow' as const }))
    const d = deps({ decide })
    decideFor(d, 'sess_1', 'read_terminal', { terminal_id: 'term_1' })
    decideFor(d, 'sess_1', 'upload_file', { terminal_id: 'term_1' })
    expect(decide.mock.calls.map((c: unknown[]) => c[2])).toEqual(['read', 'write'])
  })

  it('deny 带上 permission_denied 前缀并落审计', () => {
    const d = deps({ decide: () => ({ kind: 'deny', reason: 'readonly' }) })
    expect(decideFor(d, 'sess_1', 'exec_in_terminal', { terminal_id: 'term_ssh', command: 'ls' }))
      .toEqual({ kind: 'deny', reason: 'permission_denied: readonly' })
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({ terminalId: 'term_ssh', decision: 'deny:readonly' }))
  })

  it('upload_file 即便已有写授权也逐次确认（一次性，不升级）', () => {
    const d = deps()
    expect(decideFor(d, 'sess_1', 'upload_file', { terminal_id: 'term_1', local_path: '/x', target_dir: '/y' }))
      .toEqual({ kind: 'ask', reason: 'dangerous_command' })
    commitGrant(d, 'sess_1', 'upload_file', { terminal_id: 'term_1' }, 'dangerous_command')
    expect(d.grant).not.toHaveBeenCalled()
  })

  it('prompt → ask，带上原因供授权卡显示', () => {
    const d = deps({ decide: () => ({ kind: 'prompt', reason: 'first_access', risk: 'safe' }) })
    expect(decideFor(d, 'sess_1', 'exec_in_terminal', { terminal_id: 'term_1', command: 'ls' }))
      .toEqual({ kind: 'ask', reason: 'first_access' })
  })

  it('缺 terminal_id 直接拒（模型瞎编参数时不放行）', () => {
    expect(decideFor(deps(), 'sess_1', 'exec_in_terminal', { command: 'ls' }))
      .toMatchObject({ kind: 'deny' })
  })
})

describe('文件工具', () => {
  it('applyEdit：整文件 / 唯一替换 / 多次命中与未命中报错 / CRLF 文件', () => {
    expect(applyEdit(undefined, { content: 'new' })).toBe('new')
    expect(applyEdit('a=1\nb=2\n', { old_text: 'b=2', new_text: 'b=3' })).toBe('a=1\nb=3\n')
    expect(() => applyEdit('x\nx\n', { old_text: 'x', new_text: 'y' })).toThrow(/多次/)
    expect(() => applyEdit('abc', { old_text: 'zzz', new_text: 'y' })).toThrow(/未找到/)
    expect(() => applyEdit(undefined, { old_text: 'a', new_text: 'b' })).toThrow(/不存在/)
    expect(applyEdit('a=1\r\nb=2\r\n', { old_text: 'a=1\nb=2', new_text: 'a=1\nb=3' })).toBe('a=1\r\nb=3\r\n')
  })

  it('sliceLines：行号区间 1 起含两端，超行数截断', () => {
    expect(sliceLines('a\nb\nc\n', 2, 3)).toEqual({ total_lines: 3, start_line: 2, end_line: 3, content: 'b\nc' })
    const big = Array.from({ length: 2500 }, (_, i) => `l${i + 1}`).join('\n')
    expect(sliceLines(big)).toMatchObject({ total_lines: 2500, start_line: 1, end_line: 2000, truncated: true })
  })

  it('download_file 已有授权也逐次确认；write_file 按信任档（有写授权直接放行，可备份还原）；read_file 要 read', () => {
    const decide: any = vi.fn(() => ({ kind: 'allow' as const }))
    const d = deps({ decide })
    expect(decideFor(d, 'sess_1', 'write_file', { terminal_id: 'term_1', path: '/a' })).toEqual({ kind: 'allow' })
    expect(decideFor(d, 'sess_1', 'download_file', { terminal_id: 'term_ssh', path: '/a' })).toEqual({ kind: 'ask', reason: 'dangerous_command' })
    expect(decideFor(d, 'sess_1', 'read_file', { terminal_id: 'term_1', path: '/a' })).toEqual({ kind: 'allow' })
    expect(decide.mock.calls.map((c: unknown[]) => c[2])).toEqual(['write', 'read', 'read'])
  })

  it('write_file：按授权时的原文写入并把备份路径记进审计；授权后文件被改则不写', async () => {
    let disk = 'a=1\n'
    const writeFile = vi.fn(async (_t: string, p: string, c: string) => { disk = c; return { path: p, backupPath: '/home/u/.lingshell/backups/x' } })
    const d = deps({ readFile: async () => disk, writeFile, takeUserOverride: () => ({ base: 'a=1\n' }) })
    const out = JSON.parse(await defOf(d, 'write_file').execute({ terminal_id: 'term_1', path: '/etc/a', old_text: 'a=1', new_text: 'a=2' } as never, exec({ callId: 'w1' }) as never))
    expect(disk).toBe('a=2\n')
    expect(out).toMatchObject({ ok: true, created: false, backup_path: '/home/u/.lingshell/backups/x' })
    expect(out.diff).toContain('-a=1')   // 结果带 diff：免弹卡时工具卡里也能看到改了什么
    expect(out.diff).toContain('+a=2')
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({ decision: 'write_allowed', filePath: '/etc/a', backupPath: '/home/u/.lingshell/backups/x' }))
    // 现在磁盘是 a=2，但用户批的 diff 基于 a=1 → 拒写
    await expect(defOf(d, 'write_file').execute({ terminal_id: 'term_1', path: '/etc/a', content: 'z' } as never, exec({ callId: 'w2' }) as never)).rejects.toThrow(/授权后被改动/)
    expect(writeFile).toHaveBeenCalledTimes(1)
  })

  it('授权前预览失败（fail）原样抛给模型，不写', async () => {
    const writeFile = vi.fn()
    const d = deps({ readFile: async () => 'x', writeFile, takeUserOverride: () => ({ fail: 'old_text 在文件中未找到' }) })
    await expect(defOf(d, 'write_file').execute({ terminal_id: 'term_1', path: '/a', old_text: 'q', new_text: 'r' } as never, exec() as never)).rejects.toThrow('old_text 在文件中未找到')
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('read_file：不存在 / 二进制报错', async () => {
    const files: Record<string, string> = { '/bin': 'a\0b', '/t': 'l1\nl2\n' }
    const d = deps({ readFile: async (_t, p) => files[p], writeFile: vi.fn() })
    await expect(defOf(d, 'read_file').execute({ terminal_id: 'term_1', path: '/none' } as never, exec() as never)).rejects.toThrow(/不存在/)
    await expect(defOf(d, 'read_file').execute({ terminal_id: 'term_1', path: '/bin' } as never, exec() as never)).rejects.toThrow(/二进制/)
    expect(JSON.parse(await defOf(d, 'read_file').execute({ terminal_id: 'term_1', path: '/t' } as never, exec() as never))).toMatchObject({ content: 'l1\nl2', total_lines: 2 })
  })
})

describe('commitGrant', () => {
  it('首次访问 allow 后按命令的只读性落授权记录（只读命令只给 read）', () => {
    const d = deps({ isReadOnly: (c) => /^ls\b/.test(c) })
    commitGrant(d, 'sess_1', 'exec_in_terminal', { terminal_id: 'term_ssh', command: 'ls' }, 'first_access')
    expect(d.grant).toHaveBeenCalledWith('sess_1', 'host_a', 'read')
    // 审计记原始终端 id，主机标识由主进程按需解析
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({ terminalId: 'term_ssh', decision: 'allow:first_access' }))
  })
  it('危险命令是一次性放行，不升级权限', () => {
    const d = deps()
    commitGrant(d, 'sess_1', 'exec_in_terminal', { terminal_id: 'term_1', command: 'rm -rf /' }, 'dangerous_command')
    expect(d.grant).not.toHaveBeenCalled()
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({ decision: 'allow:dangerous_command' }))
  })
  it('无需授权的工具不写记录', () => {
    const d = deps()
    commitGrant(d, 'sess_1', 'list_terminals', {}, 'first_access')
    expect(d.grant).not.toHaveBeenCalled()
  })
})

describe('后台任务 start_background / check_background', () => {
  it('授权档：start 要 write 且带上 command 过危险检查，check 要 read', () => {
    const decide: any = vi.fn(() => ({ kind: 'allow' as const }))
    const d = deps({ decide })
    decideFor(d, 'sess_1', 'start_background', { terminal_id: 'term_ssh', command: 'make' })
    decideFor(d, 'sess_1', 'check_background', { terminal_id: 'term_ssh', job_id: '0123456789abcdef' })
    expect(decide.mock.calls).toEqual([['sess_1', 'host_a', 'write', 'make'], ['sess_1', 'host_a', 'read', undefined]])
  })

  it('start_background 跑包装命令，解析 pid，返回 job_id/log_file', async () => {
    const execCapture = vi.fn(async () => ({ output: '__LINGSHELL_JOB_PID__=4242\r\n', exitCode: 0 }))
    const d = deps({ terminals: { ...deps().terminals, execCapture } as never })
    const out = JSON.parse(await defOf(d, 'start_background').execute({ terminal_id: 'term_1', command: 'make all' } as never, exec() as never))
    expect(isJobId(out.job_id)).toBe(true)
    expect(out).toEqual({ job_id: out.job_id, pid: 4242, log_file: `${JOB_DIR}/${out.job_id}.log` })
    const sent = (execCapture.mock.calls[0] as unknown[])[1] as string
    expect(sent).toBe(buildStartBackgroundCommand(out.job_id, 'make all'))
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({ command: 'make all', decision: 'background_started' }))
  })

  it('start_background 拿不到 pid 时报错而非假装成功', async () => {
    const d = deps({ terminals: { ...deps().terminals, execCapture: async () => ({ output: 'mkdir: Permission denied', exitCode: 1 }) } as never })
    await expect(defOf(d, 'start_background').execute({ terminal_id: 'term_1', command: 'x' } as never, exec() as never))
      .rejects.toThrow(/启动失败.*Permission denied/)
  })

  it('授权卡改命令：后台跑的是改后的命令，并告知模型', async () => {
    const execCapture = vi.fn(async () => ({ output: '__LINGSHELL_JOB_PID__=1', exitCode: 0 }))
    const d = deps({ terminals: { ...deps().terminals, execCapture } as never, takeUserOverride: (id) => (id === 'c1' ? { command: 'make -j2' } : undefined) })
    const out = JSON.parse(await defOf(d, 'start_background').execute({ terminal_id: 'term_1', command: 'make -j64' } as never, exec({ callId: 'c1' }) as never))
    expect((execCapture.mock.calls[0] as unknown[])[1]).toBe(buildStartBackgroundCommand(out.job_id, 'make -j2'))
    expect(out).toMatchObject({ executed_command: 'make -j2' })
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({ command: 'make -j2', decision: 'background_started:edited' }))
  })

  it('授权卡带原因拒绝：start_background 不执行', async () => {
    const execCapture = vi.fn()
    const d = deps({ terminals: { ...deps().terminals, execCapture } as never, takeUserOverride: () => ({ deny: '别在生产跑' }) })
    await expect(defOf(d, 'start_background').execute({ terminal_id: 'term_1', command: 'x' } as never, exec({ callId: 'c2' }) as never))
      .rejects.toThrow('用户拒绝执行。原因：别在生产跑')
    expect(execCapture).not.toHaveBeenCalled()
  })

  it('check_background 拒绝非 hex 的 job_id（防注入），不碰终端', async () => {
    const execCapture = vi.fn()
    const d = deps({ terminals: { ...deps().terminals, execCapture } as never })
    for (const bad of ['x; rm -rf ~', '../etc/passwd', '0123456789ABCDEF', '0123', 42]) {
      await expect(defOf(d, 'check_background').execute({ terminal_id: 'term_1', job_id: bad } as never, exec() as never)).rejects.toThrow(/非法 job_id/)
    }
    expect(execCapture).not.toHaveBeenCalled()
    expect(() => buildStartBackgroundCommand('$(id)', 'ls')).toThrow(/非法 job_id/)
  })

  it('有旁路通道：启动 / 查询都走 sideExec（启动带 cwd），不碰交互终端', async () => {
    const execCapture = vi.fn()
    const sideExec = vi.fn(async (_id: string, cmd: string, _o: { cwd?: boolean }) => ({ output: cmd.startsWith('mkdir') ? '__LINGSHELL_JOB_PID__=77\n' : '__LINGSHELL_JOB_STATUS__ finished 0\ndone\n', exitCode: 0 }))
    const d = deps({ terminals: { ...deps().terminals, execCapture } as never, sideExec, execTimeoutMs: () => 50_000 })
    const out = JSON.parse(await defOf(d, 'start_background').execute({ terminal_id: 'term_ssh', command: 'python3 -m http.server 18080' } as never, exec() as never))
    expect(out).toMatchObject({ pid: 77 })
    expect(sideExec.mock.calls[0]).toEqual(['term_ssh', buildStartBackgroundCommand(out.job_id, 'python3 -m http.server 18080'), { timeoutMs: 50_000, signal: undefined, cwd: true }])
    const st = JSON.parse(await defOf(d, 'check_background').execute({ terminal_id: 'term_ssh', job_id: out.job_id } as never, exec() as never))
    expect(st).toEqual({ job_id: out.job_id, status: 'finished', exit_code: 0, tail: 'done' })
    expect(sideExec.mock.calls[1][2]).toMatchObject({ cwd: false })
    expect(execCapture).not.toHaveBeenCalled()
  })

  it('旁路没有（undefined）/ 开不出来（抛错）：退回终端里静默执行（不回显、不进历史），密钥明文只在 wire 里', async () => {
    for (const sideExec of [vi.fn(async () => undefined), vi.fn(async () => { throw new Error('channel open failure') })]) {
      const execCapture = vi.fn(async () => ({ output: '__LINGSHELL_JOB_PID__=5', exitCode: 0 }))
      const d = deps({ terminals: { ...deps().terminals, execCapture } as never, sideExec })
      const out = JSON.parse(await defOf(d, 'start_background').execute({ terminal_id: 'term_1', command: 'make' } as never, exec() as never))
      expect(out.pid).toBe(5)
      expect((execCapture.mock.calls[0] as unknown[])[4]).toEqual({ silent: true })
    }
  })

  it('用户停止：旁路执行中被中止 → 直接报 aborted，不退回终端重跑', async () => {
    const ac = new AbortController()
    const execCapture = vi.fn()
    const sideExec = vi.fn(async () => { ac.abort(); throw new Error('aborted') })
    const d = deps({ terminals: { ...deps().terminals, execCapture } as never, sideExec })
    await expect(defOf(d, 'check_background').execute({ terminal_id: 'term_1', job_id: '0123456789abcdef' } as never, exec({ signal: ac.signal }) as never)).rejects.toThrow('aborted')
    expect(execCapture).not.toHaveBeenCalled()
  })

  it('check_background 解析状态与日志末尾', async () => {
    const d = deps({ terminals: { ...deps().terminals, execCapture: async () => ({ output: '__LINGSHELL_JOB_STATUS__ finished 3\r\nhi\r\nbye\r\n', exitCode: 0 }) } as never })
    const out = JSON.parse(await defOf(d, 'check_background').execute({ terminal_id: 'term_1', job_id: '0123456789abcdef' } as never, exec() as never))
    expect(out).toEqual({ job_id: '0123456789abcdef', status: 'finished', exit_code: 3, tail: 'hi\nbye' })
    expect(parseCheckBackgroundOutput('a', '__LINGSHELL_JOB_STATUS__ running\n')).toEqual({ job_id: 'a', status: 'running', tail: '' })
    expect(parseStartBackgroundOutput('[1] 99\n')).toBeUndefined()
  })
})

// 真跑 bash：包装命令拼错只有真 shell 才暴露（引号、exit 跳过退出码落盘、后台进程被一起等待等）
const bash = process.platform === 'win32'
  ? ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'].find((p) => existsSync(p))
  : 'bash'
describe.skipIf(!bash)('后台任务在真 bash 里的往返', () => {
  const sh = (cmd: string) => spawnSync(bash!, ['-c', cmd], { encoding: 'utf8' })
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  it('running → finished，带退出码与日志（命令含 exit 与单引号）', async () => {
    const id = newJobId()
    // 任务卡在信号文件上，测试 touch 之后才结束（30s 兜底防孤儿）。不用计时断言：
    // 原来"任务 sleep 1、启动须 <900ms 返回"在机器负载高时会误报；若启动等任务跑完，这里会一直卡到兜底超时而失败
    const go = `${JOB_DIR}/${id}.go`
    try {
      const start = sh(buildStartBackgroundCommand(id, `echo hi; echo "it's"; i=0; while [ ! -f ${go} ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done; exit 3`))
      expect(start.status).toBe(0)
      expect(parseStartBackgroundOutput(start.stdout)).toBeGreaterThan(0)

      const first = parseCheckBackgroundOutput(id, sh(buildCheckBackgroundCommand(id)).stdout)
      expect(first.status).toBe('running')                 // 启动已返回而任务还在等信号 → 确实没等它跑完
      sh(`touch ${go}`)

      let st = first
      for (let i = 0; i < 50 && st.status !== 'finished'; i++) {
        await sleep(200)
        st = parseCheckBackgroundOutput(id, sh(buildCheckBackgroundCommand(id)).stdout)
      }
      expect(st).toEqual({ job_id: id, status: 'finished', exit_code: 3, tail: "hi\nit's" })
    } finally {
      sh(`rm -f ${JOB_DIR}/${id}.*`)
    }
  }, 20000)

  it('不存在的 job → unknown', () => {
    const id = newJobId()
    expect(parseCheckBackgroundOutput(id, sh(buildCheckBackgroundCommand(id)).stdout)).toEqual({ job_id: id, status: 'unknown', tail: '' })
  })
})

describe('命令说明 explain', () => {
  it('透传进授权卡字段；缺失时不带、不拦执行', async () => {
    const d = deps()
    expect(approvalView(d, 'exec_in_terminal', { terminal_id: 'term_ssh', command: 'df -h', explain: ' 查看磁盘占用，只读 ' }))
      .toEqual({ terminalId: 'host_a', command: 'df -h', explain: '查看磁盘占用，只读' })
    expect(approvalView(d, 'start_background', { terminal_id: 'term_1', command: 'make' })).toEqual({ terminalId: 'local', command: 'make' })
    expect(explainOf({ explain: '  ' })).toBeUndefined()
    expect(describeCall('exec_in_terminal', { command: 'ls', explain: 'x' })).toBe('ls')   // 命令行仍是命令本身
    // 网关不看 explain；漏填照常执行
    expect(decideFor(d, 'sess_1', 'exec_in_terminal', { terminal_id: 'term_1', command: 'ls' })).toEqual({ kind: 'allow' })
    expect(JSON.parse(await defOf(d, 'exec_in_terminal').execute({ terminal_id: 'term_1', command: 'ls' } as never, exec() as never))).toMatchObject({ exit_code: 0 })
  })

  it('exec 类工具都声明了 explain 参数（非 required）', () => {
    for (const n of ['exec_in_terminal', 'start_background', 'exec_on_terminals']) {
      const p = (defOf(deps(), n).parameters as Record<string, { required?: boolean }>).explain
      expect(p).toBeDefined()
      expect(p.required).toBeFalsy()
    }
  })
})

describe('多主机批量执行 exec_on_terminals', () => {
  const three = () => ({
    ...deps().terminals,
    list: () => [
      { id: 'term_1', title: '本地', type: 'local', status: 'running', locked: false },
      { id: 'term_ssh', title: 'A', type: 'ssh', status: 'running', locked: false },
      { id: 'term_b', title: 'B', type: 'ssh', status: 'running', locked: false },
    ],
  })
  const hk = (t: string) => ({ term_ssh: 'host_a', term_b: 'host_b' } as Record<string, string>)[t] ?? 'local'
  const md = (over: Partial<TerminalToolDeps> = {}) => deps({ terminals: three() as never, resolveHostKey: hk, isReadOnly: (c) => c === 'nginx -v', ...over })
  const args = { terminal_ids: ['term_ssh', 'term_b'], command: 'nginx -v', explain: '查 nginx 版本' }

  it('全部放行 → allow，只读命令每台主机按 read 各问一次', () => {
    const decide: any = vi.fn(() => ({ kind: 'allow' as const }))
    expect(decideFor(md({ decide }), 'sess_1', 'exec_on_terminals', args)).toEqual({ kind: 'allow' })
    expect(decide.mock.calls).toEqual([['sess_1', 'host_a', 'read', 'nginx -v'], ['sess_1', 'host_b', 'read', 'nginx -v']])
  })

  it('写命令按 write 决策；只读和写命令混用时各自按自己的档', () => {
    const decide: any = vi.fn(() => ({ kind: 'allow' as const }))
    const d = md({ decide })
    decideFor(d, 'sess_1', 'exec_on_terminals', { ...args, command: 'systemctl restart nginx' })
    expect(decide.mock.calls).toEqual([['sess_1', 'host_a', 'write', 'systemctl restart nginx'], ['sess_1', 'host_b', 'write', 'systemctl restart nginx']])
    decide.mockClear()
    decideFor(d, 'sess_1', 'exec_on_terminals', args)
    expect(decide.mock.calls.every((c: unknown[]) => c[2] === 'read')).toBe(true)
  })

  it('任一台拒 → 整批拒，并对拒的那台落审计', () => {
    const d = md({ decide: (_s, h) => (h === 'host_b' ? { kind: 'deny', reason: 'readonly' } : { kind: 'allow' }) })
    expect(decideFor(d, 'sess_1', 'exec_on_terminals', args)).toEqual({ kind: 'deny', reason: expect.stringMatching(/^permission_denied: .*term_b/) })
    expect(d.audit).toHaveBeenCalledTimes(1)
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({ terminalId: 'term_b', decision: 'deny:readonly' }))
  })

  it('有的要问 → 合成一张卡，原因取最严重的；同意后只给要问的主机落授权、逐台审计', () => {
    const d = md({ decide: (_s, h) => (h === 'host_a' ? { kind: 'prompt', reason: 'first_access', risk: 'safe' } : h === 'host_b' ? { kind: 'prompt', reason: 'elevation', risk: 'safe' } : { kind: 'allow' }) })
    const a3 = { ...args, terminal_ids: ['term_1', 'term_ssh', 'term_b'] }
    expect(decideFor(d, 'sess_1', 'exec_on_terminals', a3)).toEqual({ kind: 'ask', reason: 'elevation' })
    commitGrant(d, 'sess_1', 'exec_on_terminals', a3, 'elevation')
    expect(d.grant.mock.calls).toEqual([['sess_1', 'host_a', 'read'], ['sess_1', 'host_b', 'read']])   // 只读命令只落 read；local 已放行，不动
    expect(d.audit.mock.calls.map((c: any[]) => c[0].terminalId)).toEqual(['term_1', 'term_ssh', 'term_b'])
  })

  it('危险命令：一次性放行，不给任何主机落授权', () => {
    const d = md({ decide: () => ({ kind: 'prompt', reason: 'dangerous_command', risk: 'dangerous' }) })
    expect(decideFor(d, 'sess_1', 'exec_on_terminals', args)).toEqual({ kind: 'ask', reason: 'dangerous_command' })
    commitGrant(d, 'sess_1', 'exec_on_terminals', args, 'dangerous_command')
    expect(d.grant).not.toHaveBeenCalled()
  })

  it('未知终端 / 数量不对 → 直接拒，不问 AuthRegistry', () => {
    const decide = vi.fn()
    const d = md({ decide } as never)
    expect(decideFor(d, 'sess_1', 'exec_on_terminals', { ...args, terminal_ids: ['term_ssh', 'term_old'] }))
      .toEqual({ kind: 'deny', reason: expect.stringContaining('terminal_not_found') })
    expect(decideFor(d, 'sess_1', 'exec_on_terminals', { ...args, terminal_ids: ['term_ssh', 'term_ssh'] })).toMatchObject({ kind: 'deny' })   // 去重后只剩 1 个
    expect(decideFor(d, 'sess_1', 'exec_on_terminals', { command: 'ls' })).toMatchObject({ kind: 'deny' })
    expect(decide).not.toHaveBeenCalled()
  })

  it('授权卡列出全部目标主机并带说明', () => {
    expect(approvalView(md(), 'exec_on_terminals', args)).toEqual({
      terminalId: 'host_a', command: 'nginx -v', explain: '查 nginx 版本',
      targets: [{ terminalId: 'term_ssh', hostKey: 'host_a', label: 'A' }, { terminalId: 'term_b', hostKey: 'host_b', label: 'B' }],
    })
  })

  it('groupSameOutput：按（退出码, 输出）分组，忽略 \\r 与首尾空白', () => {
    expect(groupSameOutput([
      { terminal_id: 'a', exit_code: 0, full: 'v1\r\n' },
      { terminal_id: 'b', exit_code: 0, full: 'v2' },
      { terminal_id: 'c', exit_code: 0, full: 'v1' },
      { terminal_id: 'd', exit_code: 1, full: 'v1' },
    ])).toEqual([['a', 'c'], ['b'], ['d']])
  })

  it('并行执行、透传 signal/超时、截断输出末尾、单台失败不影响其他台、逐台审计', async () => {
    const sig = new AbortController().signal
    const execCapture = vi.fn(async (id: string) => {
      if (id === 'term_1') throw new Error('terminal_disconnected')
      return id === 'term_ssh' ? { output: 'x'.repeat(5000) + 'END', exitCode: 0 } : { output: 'nginx/1.2', exitCode: 0 }
    })
    const d = md({ terminals: { ...three(), execCapture } as never, execTimeoutMs: () => 7000 })
    const out = JSON.parse(await defOf(d, 'exec_on_terminals').execute({ ...args, terminal_ids: ['term_1', 'term_ssh', 'term_b'] } as never, exec({ signal: sig }) as never))
    expect(execCapture).toHaveBeenCalledWith('term_ssh', 'nginx -v', sig, 7000)
    expect(out.results.map((r: any) => [r.terminal_id, r.title, r.host, r.exit_code])).toEqual([['term_1', '本地', 'local', -1], ['term_ssh', 'A', 'host_a', 0], ['term_b', 'B', 'host_b', 0]])
    expect(out.results[0].error).toBe('terminal_disconnected')
    expect(out.results[1].output).toHaveLength(4000)
    expect(out.results[1].output.endsWith('END')).toBe(true)
    expect(out.results[1].truncated).toBe(true)
    expect(out.summary).toEqual({ same_output_groups: [['term_1'], ['term_ssh'], ['term_b']], failed: ['term_1'] })
    expect(d.audit.mock.calls.map((c: any[]) => c[0].terminalId).sort()).toEqual(['term_1', 'term_b', 'term_ssh'])
  })

  it('带原因的拒绝：一台都不执行', async () => {
    const execCapture = vi.fn()
    const d = md({ terminals: { ...three(), execCapture } as never, takeUserOverride: () => ({ deny: '先只查一台' }) })
    await expect(defOf(d, 'exec_on_terminals').execute(args as never, exec({ callId: 'm1' }) as never)).rejects.toThrow('先只查一台')
    expect(execCapture).not.toHaveBeenCalled()
  })
})

describe('terminalIdOf', () => {
  it('只认字符串型 terminal_id', () => {
    expect(terminalIdOf({ terminal_id: 'term_1' })).toBe('term_1')
    expect(terminalIdOf({ terminal_id: 42 })).toBeUndefined()
    expect(terminalIdOf(null)).toBeUndefined()
  })
})

describe('命令规则 / 按回合撤销的记录字段', () => {
  it('decide 带的规则透传：放行/询问带 rule，禁止落审计（含 rule）', () => {
    const allow = deps({ decide: () => ({ kind: 'allow', rule: '前缀 echo · 总是放行' }) } as never)
    expect(decideFor(allow, 'sess_1', 'exec_in_terminal', { terminal_id: 'term_1', command: 'echo hi' })).toEqual({ kind: 'allow', rule: '前缀 echo · 总是放行' })
    const ask = deps({ decide: () => ({ kind: 'prompt', reason: 'elevation', risk: 'safe', rule: 'r' }) } as never)
    expect(decideFor(ask, 'sess_1', 'exec_in_terminal', { terminal_id: 'term_1', command: 'rm a' })).toEqual({ kind: 'ask', reason: 'elevation', rule: 'r' })
    const deny = deps({ decide: () => ({ kind: 'deny', reason: '按规则：正则 rm\\s · 总是禁止', rule: '正则 rm\\s · 总是禁止' }) } as never)
    expect(decideFor(deny, 'sess_1', 'exec_in_terminal', { terminal_id: 'term_1', command: 'ls; rm -rf /tmp/xx' }).kind).toBe('deny')
    expect(deny.audit).toHaveBeenCalledWith(expect.objectContaining({ decision: 'deny:按规则：正则 rm\\s · 总是禁止', rule: '正则 rm\\s · 总是禁止' }))
    // 多主机：任一台按规则放行即带上
    const multi = deps({ decide: () => ({ kind: 'allow', rule: 'r2' }) } as never)
    expect(decideFor(multi, 'sess_1', 'exec_on_terminals', { terminal_ids: ['term_1', 'term_ssh'], command: 'uptime' })).toEqual({ kind: 'allow', rule: 'r2' })
  })

  it('按规则放行的执行：执行记录注明规则；批准后 commitGrant 也记规则', async () => {
    const d = deps({ takeUserOverride: () => ({ rule: '前缀 echo · 总是放行' }) })
    await defOf(d, 'exec_in_terminal').execute({ terminal_id: 'term_1', command: 'echo hi' } as never, exec({ callId: 'c1' }) as never)
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({ decision: 'exec_allowed', rule: '前缀 echo · 总是放行' }))
    const g = deps()
    commitGrant(g, 'sess_1', 'exec_in_terminal', { terminal_id: 'term_1', command: 'rm a' }, 'elevation', '前缀 rm  · 总是询问')
    expect(g.audit).toHaveBeenCalledWith(expect.objectContaining({ decision: 'allow:elevation', rule: '前缀 rm  · 总是询问' }))
  })

  it('write_file 审计带 created 与写入内容摘要（按回合撤销用）', async () => {
    const d = deps({ readFile: async () => undefined, writeFile: async (_t, p) => ({ path: p, hash: 'h1' }) })
    await defOf(d, 'write_file').execute({ terminal_id: 'term_1', path: '/n', content: 'x' } as never, exec() as never)
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({ decision: 'write_allowed', filePath: '/n', created: true, afterHash: 'h1' }))
  })
})

describe('回滚方案 rollback / rollback_note', () => {
  // 简化的只读判断：ls/cat 只读，其余算变更
  const isReadOnly = (c: string) => /^(ls|cat)\b/.test(c)
  const prodDeps = (over: Partial<TerminalToolDeps> = {}) => deps({ isReadOnly, hostMeta: (t: string) => (t === 'term_ssh' ? { env: 'prod' as const } : {}), ...over })

  it('rollbackOf：去首尾空白、空串不带', () => {
    expect(rollbackOf({ rollback: '  mv a.bak a \n', rollback_note: ' 用备份还原 ' })).toEqual({ rollback: 'mv a.bak a', rollbackNote: '用备份还原' })
    expect(rollbackOf({ rollback: '  ', rollback_note: 3 })).toEqual({})
  })

  it('missingRollback：只管 exec_in_terminal 的非只读命令；给了 rollback 或 rollback_note 任一即可；无 isReadOnly 不检查', () => {
    const d = prodDeps()
    expect(missingRollback(d, 'exec_in_terminal', { command: 'systemctl restart nginx' })).toBe(true)
    expect(missingRollback(d, 'exec_in_terminal', { command: 'ls /etc' })).toBe(false)
    expect(missingRollback(d, 'exec_in_terminal', { command: 'rm x', rollback: 'touch x' })).toBe(false)
    expect(missingRollback(d, 'exec_in_terminal', { command: 'rm x', rollback_note: '不可回滚：临时文件' })).toBe(false)
    expect(missingRollback(d, 'start_background', { command: 'make' })).toBe(false)
    expect(missingRollback(deps(), 'exec_in_terminal', { command: 'rm x' })).toBe(false)
  })

  it('生产主机缺回滚方案：直接拒（不问授权），原因要求补 rollback；补上后照常走授权', () => {
    const decide = vi.fn(() => ({ kind: 'prompt' as const, reason: 'elevation', risk: 'safe' }))
    const d = prodDeps({ decide } as never)
    expect(decideFor(d, 'sess_1', 'exec_in_terminal', { terminal_id: 'term_ssh', command: 'systemctl restart nginx' }))
      .toEqual({ kind: 'deny', reason: expect.stringContaining('rollback_required') })
    expect(rollbackDeny(d, 'exec_in_terminal', { terminal_id: 'term_ssh', command: 'systemctl restart nginx' })?.kind).toBe('deny')
    expect(decide).not.toHaveBeenCalled()
    expect(decideFor(d, 'sess_1', 'exec_in_terminal', { terminal_id: 'term_ssh', command: 'systemctl restart nginx', rollback: 'systemctl restart nginx' }).kind).toBe('ask')
    // 生产主机上的只读命令不要求
    expect(decideFor(d, 'sess_1', 'exec_in_terminal', { terminal_id: 'term_ssh', command: 'cat /etc/hosts' }).kind).toBe('ask')
  })

  it('非生产缺回滚方案：照常执行，授权卡标 rollbackMissing；有方案时卡片带上回滚命令与说明', () => {
    const d = prodDeps()
    expect(decideFor(d, 'sess_1', 'exec_in_terminal', { terminal_id: 'term_1', command: 'rm x' })).toEqual({ kind: 'allow' })
    expect(approvalView(d, 'exec_in_terminal', { terminal_id: 'term_1', command: 'rm x' })).toMatchObject({ rollbackMissing: true })
    const v = approvalView(d, 'exec_in_terminal', { terminal_id: 'term_1', command: 'cp a b', rollback: 'rm b', rollback_note: '删掉副本' })
    expect(v).toMatchObject({ command: 'cp a b', rollback: 'rm b', rollbackNote: '删掉副本' })
    expect(v).not.toHaveProperty('rollbackMissing')
    expect(approvalView(d, 'exec_in_terminal', { terminal_id: 'term_1', command: 'ls' })).not.toHaveProperty('rollbackMissing')
  })

  it('执行记录带回滚方案与 callId（一键回滚 / 工具卡片据此定位）', async () => {
    const d = prodDeps()
    await defOf(d, 'exec_in_terminal').execute({ terminal_id: 'term_1', command: 'cp a b', rollback: 'rm b', rollback_note: '删副本' } as never, exec({ callId: 'call_9' }) as never)
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({ decision: 'exec_allowed', rollback: 'rm b', rollbackNote: '删副本', callId: 'call_9' }))
  })

  it('exec_in_terminal 声明了可选的 rollback / rollback_note 参数', () => {
    const p = defOf(deps(), 'exec_in_terminal').parameters as Record<string, { required?: boolean }>
    expect(p.rollback).toBeDefined(); expect(p.rollback.required).toBeUndefined()
    expect(p.rollback_note).toBeDefined(); expect(p.rollback_note.required).toBeUndefined()
  })
})

describe('run_on_hosts（跨主机提问）', () => {
  const fleet = [{ id: 'h1', label: 'web-1', group: 'web' }, { id: 'h2', label: 'web-2', group: 'web' }, { id: 'h3', label: 'db-1', group: 'db' }]
  const readonly = (c: string) => !/rm|>/.test(c)
  const rows = [
    { host_id: 'h1', label: 'web-1', status: 'ok' as const, exit_code: 0, ms: 5, output: 'Linux\n' },
    { host_id: 'h2', label: 'web-2', status: 'conn_error' as const, ms: 3, output: '', error: 'ECONNREFUSED' },
  ]
  const fd = (over: Partial<TerminalToolDeps> = {}) => deps({ fleetHosts: () => fleet, isReadOnly: readonly, runOnHosts: vi.fn(async () => rows), ...over })

  it('非只读命令直接拒（不问授权）；认不出的目标 / 缺 targets 拒', () => {
    const decide = vi.fn()
    const d = fd({ decide } as never)
    expect(decideFor(d, 's', 'run_on_hosts', { targets: ['web'], command: 'rm -f /tmp/x' })).toEqual({ kind: 'deny', reason: expect.stringMatching(/^not_readonly: .*rm -f \/tmp\/x/) })
    expect(decideFor(d, 's', 'run_on_hosts', { targets: ['nope'], command: 'uname -a' })).toEqual({ kind: 'deny', reason: expect.stringMatching(/host_not_found: 找不到 nope.*可用分组：web、db/) })
    expect(decideFor(d, 's', 'run_on_hosts', { command: 'uname -a' })).toEqual({ kind: 'deny', reason: expect.stringContaining('缺少 targets') })
    expect(decide).not.toHaveBeenCalled()
    expect(decideFor(deps(), 's', 'run_on_hosts', { targets: ['web'], command: 'uname' })).toEqual({ kind: 'deny', reason: '跨主机执行不可用' })
  })

  it('每台按「读」决策：任一台要问 → 合成一张卡；任一台拒 → 整批拒并逐台记录；允许后只给要问的主机落读授权', () => {
    const decide = vi.fn((_s: string, hk: string) => (hk === 'h1' ? { kind: 'allow' as const } : { kind: 'prompt' as const, reason: 'first_access', risk: 'safe' }))
    const d = fd({ decide })
    expect(decideFor(d, 's', 'run_on_hosts', { targets: ['web'], command: 'uname -a' })).toEqual({ kind: 'ask', reason: 'first_access' })
    expect(decide).toHaveBeenCalledWith('s', 'h2', 'read', 'uname -a')
    expect(approvalView(d, 'run_on_hosts', { targets: ['web'], command: 'uname -a', explain: '看内核' })).toEqual({
      terminalId: 'h1', command: 'uname -a', explain: '看内核',
      targets: [{ terminalId: 'h1', hostKey: 'h1', label: 'web-1' }, { terminalId: 'h2', hostKey: 'h2', label: 'web-2' }],
    })
    commitGrant(d, 's', 'run_on_hosts', { targets: ['web'], command: 'uname -a' }, 'first_access')
    expect(d.grant.mock.calls).toEqual([['s', 'h2', 'read']])
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({ hostKey: 'h1', terminalTitle: 'web-1', decision: 'allow:first_access' }))
    const deny = fd({ decide: (_s, hk) => (hk === 'h3' ? { kind: 'deny', reason: 'readonly' } : { kind: 'allow' }) })
    expect(decideFor(deny, 's', 'run_on_hosts', { targets: ['h1', 'db'], command: 'df -h' })).toEqual({ kind: 'deny', reason: expect.stringContaining('主机 db-1 无权执行') })
    expect(deny.audit).toHaveBeenCalledWith(expect.objectContaining({ hostKey: 'h3', decision: 'deny:readonly' }))
    expect(decideFor(fd(), 's', 'run_on_hosts', { targets: ['web'], command: 'uptime' })).toEqual({ kind: 'allow' })
  })

  it('执行：解析目标、超时夹紧、跑完逐台记执行记录（连接失败的不记），返回结果与汇总；工具体再查只读', async () => {
    const runOnHosts = vi.fn(async () => rows)
    const d = fd({ runOnHosts })
    const out = JSON.parse(await defOf(d, 'run_on_hosts').execute({ targets: ['web'], command: ' uname -a ', timeout: 9999 } as never, exec() as never))
    // 第 5 个参数 = 会话 id：主进程据此判断无人值守（巡检），临时连接遇到未知指纹不弹框
    expect(runOnHosts).toHaveBeenCalledWith([fleet[0], fleet[1]], 'uname -a', 300_000, undefined, 'sess_1')
    expect(out.summary).toEqual({ total: 2, ok: 1, failed: ['h2'], same_output_groups: [['h1']] })
    expect(out.results).toHaveLength(2)
    expect(d.audit.mock.calls.map((c) => c[0])).toEqual([expect.objectContaining({ hostKey: 'h1', decision: 'fleet_exec', exitCode: 0, command: 'uname -a' })])
    await expect(defOf(d, 'run_on_hosts').execute({ targets: ['web'], command: 'rm -rf /' } as never, exec() as never)).rejects.toThrow(/not_readonly/)
  })

  it('hostsTouchedBy：终端类工具取所在主机（未知终端不算）、create_terminal、run_on_hosts', async () => {
    const { hostsTouchedBy } = await import('./terminalTools.js')
    const d = fd()
    expect(hostsTouchedBy(d, 'exec_in_terminal', { terminal_id: 'term_ssh' })).toEqual(['host_a'])
    expect(hostsTouchedBy(d, 'exec_on_terminals', { terminal_ids: ['term_ssh', 'term_1', 'gone'] })).toEqual(['host_a', 'local'])
    expect(hostsTouchedBy(d, 'create_terminal', { type: 'ssh', hostId: 'h9' })).toEqual(['h9'])
    expect(hostsTouchedBy(d, 'create_terminal', { type: 'local' })).toEqual(['local'])
    expect(hostsTouchedBy(d, 'run_on_hosts', { targets: ['db'] })).toEqual(['h3'])
    expect(hostsTouchedBy(d, 'list_terminals', {})).toEqual([])
  })
})
