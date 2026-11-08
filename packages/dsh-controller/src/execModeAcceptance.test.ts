// 四档执行模式的「验收矩阵」：真实 AuthRegistry（信任档派生 / 授权记忆 / 旧数据迁移）
// + 真实 decideFor（既有授权链）+ 真实 previewBlocks / relaxByMode（模式层），
// 判定顺序与 DshController.installAuthGate 一致，输出「模式 × 场景 → 结论」表。
//
// 只读：不碰文件系统、不起终端、不调模型，deps 全是假的。
// 这张表覆盖的是「AI 这一步会不会被弹卡」，界面长什么样仍然要人看。

import { describe, it, expect } from 'vitest'
import { AuthRegistry } from '@lingshell/auth-registry'
import { alwaysAskTool, decideFor, type TerminalToolDeps } from './terminalTools.js'
import { grantKeyOf, modeFacts, relaxByMode, ToolGrants, type ExistingGate } from './execGate.js'
import { previewBlocks } from './safety.js'
import type { ExecMode } from '@lingshell/shared'

const SID = 's1'
const TERM = 'term_1'
// 工作目录必须用当前平台自己的绝对路径：写死 'D:/work' 在 Linux 上不是绝对路径，
// isOutsideWorkDir 会按「判不出来一律当目录外」处理，整张验收矩阵就跟着偏（CI 上就是这么红的）
const WORK = process.platform === 'win32' ? 'D:/work' : '/tmp/work'
const OUTSIDE = process.platform === 'win32' ? 'C:/other/x.txt' : '/other/x.txt'
// 只读命令白名单：这里用极简判定代替真实白名单（白名单本身有单测）
const isReadOnly = (c: string) => /^(ls|cat|pwd|grep|df)\b/.test(c)

type Verdict = 'allow' | 'ask' | 'deny'

interface Ctx {
  auth: AuthRegistry
  deps: TerminalToolDeps
  grants: ToolGrants
  mode: ExecMode
  prod: boolean
}

function makeCtx(mode: ExecMode, opts: { prod?: boolean; auth?: AuthRegistry } = {}): Ctx {
  const auth = opts.auth ?? new AuthRegistry({ store: { load: () => ({ records: [], execMode: {} }), save: () => {} } })
  auth.setExecMode(SID, mode)
  const prod = !!opts.prod
  const deps: TerminalToolDeps = {
    terminals: {
      list: () => [{ id: TERM, title: '本地 1', type: 'local', status: 'connected', locked: false }],
      readSnapshot: () => '',
      execCapture: async () => ({ output: '', exitCode: 0 }),
    },
    resolveHostKey: () => 'local',
    decide: (sid, hk, needed, command) => auth.decide(sid, hk, needed, command, true, prod),
    grant: (sid, hk, level) => auth.grant(sid, hk, level),
    audit: () => {},
    isReadOnly,
    hostMeta: () => (prod ? { env: 'prod' } : {}),
  }
  return { auth, deps, grants: new ToolGrants(), mode, prod }
}

const factsOf = (ctx: Ctx, name: string, args: unknown) =>
  modeFacts({ name, args, isReadOnly, workDir: WORK, granted: (k) => ctx.grants.has(SID, k) })

/** 与 installAuthGate 同序：预演拦截 → 既有授权链 decideFor → 模式层只放宽 */
function gate(ctx: Ctx, name: string, args: unknown): Verdict {
  const facts = factsOf(ctx, name, args)
  if (ctx.mode === 'preview' && previewBlocks(name, args, isReadOnly)) return 'deny'
  const d = decideFor(ctx.deps, SID, name, args)
  const existing: ExistingGate = d.kind === 'ask'
    ? { kind: 'ask', ...(d.rule ? { rule: d.rule } : {}) }
    : { kind: d.kind }
  const veto = alwaysAskTool(name) || ctx.prod
  if (relaxByMode(ctx.mode, existing, facts, veto)) return 'allow'
  // 与 installAuthGate 的 needsAskOutside 一致：没批过这个目录的目录外写要问（批过同目录就记住）
  if (d.kind === 'allow' && (ctx.mode === 'auto' || ctx.mode === 'trust')
    && facts.kind === 'write' && facts.outsideWorkDir === true && facts.granted !== true) return 'ask'
  return d.kind
}

/** 用户点了「允许」：落授权记录；auto 档额外记「工具 + 范围」 */
function approve(ctx: Ctx, name: string, args: unknown): void {
  const facts = factsOf(ctx, name, args)
  const key = grantKeyOf(name, facts)
  if (key) ctx.grants.remember(SID, key)
  ctx.deps.grant(SID, 'local', facts.kind === 'write' ? 'write' : 'read')
}

// 常用入参
const writeA = { terminal_id: TERM, path: `${WORK}/a.txt`, content: 'a' }
const writeB = { terminal_id: TERM, path: `${WORK}/b.txt`, content: 'b' }
const writeOut = { terminal_id: TERM, path: OUTSIDE, content: 'x' }
const ls = { terminal_id: TERM, command: 'ls -la' }
const rm = { terminal_id: TERM, command: 'rm -rf /tmp/x' }
const touch = { terminal_id: TERM, command: 'touch a.txt' }
const upload = { terminal_id: TERM, local_path: 'C:/x.txt', target_dir: '/tmp' }

const rows: string[] = []
function check(mode: string, what: string, got: Verdict, want: Verdict): void {
  const ok = got === want
  rows.push(`${ok ? '✅' : '❌'} ${mode.padEnd(10)} ${what.padEnd(34)} 期望 ${want.padEnd(5)} 实际 ${got}`)
  expect(got, `${mode} / ${what}`).toBe(want)
}

describe('四档执行模式验收矩阵', () => {
  it('逐条确认（默认档）：每条写都问，只读批一次就记', () => {
    const c = makeCtx('confirm')
    check('逐条确认', '写文件（首次）', gate(c, 'write_file', writeA), 'ask')
    approve(c, 'write_file', writeA)
    check('逐条确认', '写文件（已批过，再来一条）', gate(c, 'write_file', writeA), 'ask')
    check('逐条确认', '写另一个文件（已批过写入）', gate(c, 'write_file', writeB), 'ask')
    check('逐条确认', '写目录外（已批过写入）', gate(c, 'write_file', writeOut), 'ask')
    check('逐条确认', '只读命令（已批过写入：写隐含读）', gate(c, 'exec_in_terminal', ls), 'allow')
    check('逐条确认', '危险命令 rm -rf', gate(c, 'exec_in_terminal', rm), 'ask')

    // 全新会话里第一次只读命令：没有读取授权 → 先问一次，批过就不再问
    const fresh = makeCtx('confirm')
    check('逐条确认', '只读命令（新会话首次）', gate(fresh, 'exec_in_terminal', ls), 'ask')
    approve(fresh, 'exec_in_terminal', ls)
    check('逐条确认', '只读命令（批过后）', gate(fresh, 'exec_in_terminal', ls), 'allow')
  })

  it('确认一次：同类批一次就不再问，危险 / 删除 / 上传仍问', () => {
    const c = makeCtx('auto')
    check('确认一次', '写文件（首次）', gate(c, 'write_file', writeA), 'ask')
    approve(c, 'write_file', writeA)
    check('确认一次', '写另一个文件（批过同类）', gate(c, 'write_file', writeB), 'allow')
    // 批过写入后，目录外的写仍然要问（授权记录只到「主机 + 级别」，不带路径）
    check('确认一次', '写目录外（已批过写入）', gate(c, 'write_file', writeOut), 'ask')
    check('确认一次', '危险命令 rm -rf', gate(c, 'exec_in_terminal', rm), 'ask')
    check('确认一次', '上传文件（每次都问）', gate(c, 'upload_file', upload), 'ask')
  })

  it('信任：工作目录内写与只读直接放行，删除 / 危险命令仍问', () => {
    const c = makeCtx('trust')
    check('信任', '写工作目录内', gate(c, 'write_file', writeA), 'allow')
    check('信任', '只读命令 ls', gate(c, 'exec_in_terminal', ls), 'allow')
    check('信任', '会改东西的命令 touch', gate(c, 'exec_in_terminal', touch), 'ask')
    check('信任', '危险命令 rm -rf', gate(c, 'exec_in_terminal', rm), 'ask')
    check('信任', '上传文件（每次都问）', gate(c, 'upload_file', upload), 'ask')
    // 即使这台主机已经有写入授权（比如在授权抽屉里授过写），目录外的写仍要问
    approve(c, 'write_file', writeA)
    check('信任', '写目录外（已有写入授权）', gate(c, 'write_file', writeOut), 'ask')
  })

  it('预演：写操作与危险命令直接拒，只读放行（首次仍要先批读取授权）', () => {
    const c = makeCtx('preview')
    check('预演', '写文件', gate(c, 'write_file', writeA), 'deny')
    check('预演', '危险命令 rm -rf', gate(c, 'exec_in_terminal', rm), 'deny')
    // 预演不跳过「首次读取授权」的询问；批过之后只读才直接放行
    check('预演', '只读命令 ls（首次）', gate(c, 'exec_in_terminal', ls), 'ask')
    approve(c, 'exec_in_terminal', ls)
    check('预演', '只读命令 ls（批过后）', gate(c, 'exec_in_terminal', ls), 'allow')
  })

  it('生产主机：任何档位都不因模式放宽', () => {
    const c = makeCtx('trust', { prod: true })
    check('信任(生产)', '写工作目录内', gate(c, 'write_file', writeA), 'ask')
    const a = makeCtx('auto', { prod: true })
    approve(a, 'write_file', writeA)
    check('确认一次(生产)', '写文件（已批过）', gate(a, 'write_file', writeA), 'ask')
  })

  it('换档即忘：确认一次批过的记忆不会带到逐条确认', () => {
    const c = makeCtx('auto')
    approve(c, 'write_file', writeA)
    check('确认一次', '写文件（批过）', gate(c, 'write_file', writeA), 'allow')
    c.auth.setExecMode(SID, 'confirm')
    c.mode = 'confirm'
    c.grants.clear(SID)   // DshController.setExecMode 换档时做的事
    check('切到逐条确认', '写同一个文件', gate(c, 'write_file', writeA), 'ask')
  })

  it('模式持久化 + 旧数据迁移：重启后档位还在，0.1.5 的三档自动换算', () => {
    let state: { records: never[]; execMode: Record<string, ExecMode>; trust?: Record<string, 'autonomous' | 'confirm' | 'readonly'> } =
      { records: [], execMode: {} }
    const store = { load: () => state, save: (s: typeof state) => { state = s } }
    const a = new AuthRegistry({ store })
    a.setExecMode(SID, 'auto')
    const b = new AuthRegistry({ store })
    expect(b.getExecMode(SID)).toBe('auto')

    const legacy = new AuthRegistry({ store: { load: () => ({ records: [], trust: { s1: 'autonomous', s2: 'confirm', s3: 'readonly' } }), save: () => {} } })
    expect(legacy.getExecMode('s1')).toBe('auto')
    expect(legacy.getExecMode('s2')).toBe('confirm')
    expect(legacy.getExecMode('s3')).toBe('preview')
  })

  it('打印验收矩阵', () => {
    // eslint-disable-next-line no-console
    console.log('\n' + rows.join('\n'))
    expect(rows.length).toBeGreaterThan(20)
    expect(rows.every((r) => r.startsWith('✅'))).toBe(true)
  })
})
