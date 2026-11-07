// 四档执行模式接进授权网关的判定层（任务 B 的 4 条单测）。
// 关注点：默认档 confirm 行为不变；auto 的「工具 + 范围」记忆跨主机复用；trust 的目录内外判定；
// preview 的拒绝理由。判定表本身（decideByMode）的单测在 shared/src/ai/execMode.test.ts。
import { resolve } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { decideByMode, denyReasonOf } from '@lingshell/shared'
import { decideFor, commitGrant, type TerminalToolDeps } from './terminalTools.js'
import { ToolGrants, grantKeyOf, isOutsideWorkDir, modeFacts, relaxByMode } from './execGate.js'

// 会话工作目录（本地终端；Windows 上用当前盘符下的假目录即可）
const WD = resolve(process.cwd(), 'work')
// 简化版只读判定：真实实现是 shared 的白名单（shared/ai/readOnly.ts）
const ro = (c: string) => /^(ls|cat|df|pwd)\b/.test(c)

// 既有授权链的最小假 deps：decide 返回 prompt(first_access)，模拟「这台主机还没授权」
function deps(over: Partial<TerminalToolDeps> = {}): TerminalToolDeps & { audit: ReturnType<typeof vi.fn>; grant: ReturnType<typeof vi.fn> } {
  const audit = vi.fn(); const grant = vi.fn()
  return {
    terminals: {
      list: () => [
        { id: 'term_1', title: '本地', type: 'local', status: 'running', locked: false },
        { id: 'term_ssh', title: 'A', type: 'ssh', status: 'running', locked: false },
      ],
      readSnapshot: () => 'SNAP',
      execCapture: async () => ({ output: '', exitCode: 0 }),
    },
    resolveHostKey: (t: string) => (t === 'term_ssh' ? 'host_a' : 'local'),
    decide: () => ({ kind: 'prompt', reason: 'first_access', risk: 'safe' }),
    grant, audit,
    isReadOnly: ro,
    ...over,
  } as never
}

describe('四档执行模式接进网关', () => {
  it('confirm（默认档）：模式层不放宽，write_file 照旧弹卡、允许后按主机记授权', () => {
    const d = deps()
    const args = { terminal_id: 'term_1', path: `${WD}/a.txt`, content: 'x' }
    const facts = modeFacts({ name: 'write_file', args, workDir: WD, isReadOnly: ro })
    expect(facts).toMatchObject({ kind: 'write', outsideWorkDir: false })
    // confirm 永远不经过判定表 → 行为与升级前完全一致
    expect(relaxByMode('confirm', { kind: 'ask' }, facts)).toBe(false)
    expect(relaxByMode('confirm', { kind: 'ask' }, modeFacts({ name: 'exec_in_terminal', args: { command: 'ls' }, isReadOnly: ro }))).toBe(false)
    // 既有链仍是 ask(first_access)，用户点允许后 commitGrant 仍按主机升到 write
    expect(decideFor(d, 'sess_1', 'write_file', args)).toEqual({ kind: 'ask', reason: 'first_access' })
    commitGrant(d, 'sess_1', 'write_file', args, 'first_access')
    expect(d.grant).toHaveBeenCalledWith('sess_1', 'local', 'write')
  })

  it('auto（确认一次）：批过 write_file@cwd 后换主机同类操作不再问；目录外的写不记忆', () => {
    const grants = new ToolGrants()
    const granted = (key: string) => grants.has('sess_1', key)
    // 第一台主机上写工作目录内的文件：记的 key 不含主机
    const first = modeFacts({ name: 'write_file', args: { path: `${WD}/a.txt` }, workDir: WD, granted })
    expect(grantKeyOf('write_file', first)).toBe('write_file@cwd')
    expect(first.granted).toBe(false)
    expect(relaxByMode('auto', { kind: 'ask' }, first)).toBe(false)          // 还没批过 → 照旧问
    grants.remember('sess_1', 'write_file@cwd')                             // 用户批准一次
    // 换一台主机（hostKey 不同、key 相同）→ 直接放行
    const second = modeFacts({ name: 'write_file', args: { path: `${WD}/b.txt` }, workDir: WD, granted })
    expect(second.granted).toBe(true)
    expect(relaxByMode('auto', { kind: 'ask' }, second)).toBe(true)
    // 目录外的写：不进记忆，哪个档都要问
    const outside = modeFacts({ name: 'write_file', args: { path: '/etc/nginx/nginx.conf' }, workDir: WD, granted })
    expect(outside.outsideWorkDir).toBe(true)
    expect(grantKeyOf('write_file', outside)).toBeUndefined()
    expect(relaxByMode('auto', { kind: 'ask' }, outside)).toBe(false)
    // 只读命令的记忆粒度是 @readonly；会改东西的命令不记忆
    const ls = modeFacts({ name: 'exec_in_terminal', args: { command: 'ls -l' }, isReadOnly: ro, granted })
    expect(grantKeyOf('exec_in_terminal', ls)).toBe('exec_in_terminal@readonly')
    expect(grantKeyOf('exec_in_terminal', modeFacts({ name: 'exec_in_terminal', args: { command: 'sed -i s/a/b/ x' }, isReadOnly: ro }))).toBeUndefined()
    // 上传 / 下载必问、生产主机逐条确认（veto）—— 任何档都不放宽
    expect(relaxByMode('auto', { kind: 'ask' }, second, true)).toBe(false)
    // 用户配了「询问」规则命中的命令也不放宽
    expect(relaxByMode('auto', { kind: 'ask', rule: '前缀 sed · 询问' }, modeFacts({ name: 'exec_in_terminal', args: { command: 'ls' }, isReadOnly: ro }))).toBe(false)
    // 既有链说拒的（规则禁止 / 只读信任档 / 终端不存在）一律照拒
    expect(relaxByMode('auto', { kind: 'deny' }, second)).toBe(false)
  })

  it('trust（信任）：目录内写与只读命令放行，目录外写 / 删除 / 会改东西的命令仍问', () => {
    const trust = (name: string, args: unknown) => relaxByMode('trust', { kind: 'ask' }, modeFacts({ name, args, workDir: WD, isReadOnly: ro }))
    expect(trust('write_file', { path: `${WD}/notes.md` })).toBe(true)                 // cwd 内写 → 不弹
    expect(trust('write_file', { path: '/etc/hosts' })).toBe(false)                     // 目录外写 → 弹
    expect(trust('write_file', { path: 'relative/a.txt' })).toBe(false)                 // 相对路径判不出落点 → 弹
    expect(trust('exec_in_terminal', { command: 'rm a.txt' })).toBe(false)              // 删除 → 任何档都弹
    expect(trust('exec_in_terminal', { command: 'sed -i s/a/b/ x' })).toBe(false)       // 会改东西 → 弹
    expect(trust('exec_in_terminal', { command: 'rm -rf /tmp/x' })).toBe(false)         // 危险命令 → 弹
    expect(trust('exec_in_terminal', { command: 'ls -l /tmp' })).toBe(true)             // 只读命令 → 不弹
    expect(trust('exec_on_terminals', { command: 'df -h', terminal_ids: ['term_1', 'term_ssh'] })).toBe(true)
    expect(trust('upload_file', { local_path: 'C:/a.txt', target_dir: '/tmp' })).toBe(false)   // 上传仍问（veto 由网关传）
    expect(relaxByMode('trust', { kind: 'ask' }, modeFacts({ name: 'upload_file', args: { local_path: 'C:/a.txt', target_dir: '/tmp' }, workDir: WD }), true)).toBe(false)
    // 没有工作目录时（不知道工作目录）：写操作按目录外处理，保守多问一次
    expect(isOutsideWorkDir(`${WD}/a.txt`, undefined)).toBe(true)
    expect(relaxByMode('trust', { kind: 'ask' }, modeFacts({ name: 'write_file', args: { path: `${WD}/a.txt` } }))).toBe(false)
  })

  it('preview（预演）：写文件被拒且理由正确，删除类理由不同', () => {
    const write = modeFacts({ name: 'write_file', args: { path: `${WD}/a.txt` }, workDir: WD, isReadOnly: ro })
    expect(decideByMode('preview', write)).toBe('deny')
    expect(denyReasonOf('preview', write)).toBe('preview_mode_readonly')
    // 预演由网关里的预演分支直接拒（PREVIEW_DENY），模式层也不放宽
    expect(relaxByMode('preview', { kind: 'ask' }, write)).toBe(false)
    // 删除 / 危险命令：同样拒，但理由不同（告诉模型换个做法）
    const rm = modeFacts({ name: 'exec_in_terminal', args: { command: 'rm a.txt' }, isReadOnly: ro })
    expect(decideByMode('preview', rm)).toBe('deny')
    expect(denyReasonOf('preview', rm)).toBe('preview_mode_no_delete')
    const rmrf = modeFacts({ name: 'exec_in_terminal', args: { command: 'rm -rf /tmp/x' }, isReadOnly: ro })
    expect(denyReasonOf('preview', rmrf)).toBe('preview_mode_no_delete')
    // 只读排查照常放行
    expect(decideByMode('preview', modeFacts({ name: 'exec_in_terminal', args: { command: 'ls -l' }, isReadOnly: ro }))).toBe('allow')
  })
})
