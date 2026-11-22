// 工具定义自检：加一个工具要同步 8 张表（见 docs/0.1.20-规划.md「关键约束」）。
//
// 漏一处都是**静默失效**：不报错、界面看着正常，只有授权 / 拦截不生效。
// 0.1.19 加 run_skill_script 时漏了 3 处（commitGrant 不落授权、execGate 判成读、只读子代理能跑脚本），
// 全是靠人点出来的；本文件把它变成 CI 能发现的问题。
import { describe, it, expect, vi } from 'vitest'
import { terminalToolDefs, TOOL_NEEDS, type TerminalToolDeps } from './terminalTools.js'
import { execKindOf } from './execGate.js'
import { isWriteTool, SUBAGENT_ALWAYS_DENY } from './subagent.js'
import { withRedaction } from './redaction.js'

/**
 * 明确「不需要授权」的工具：在这里表过态才算完整。
 * 加工具时要么进 NEEDS，要么进这张表 —— 两边都不在就是靠默认值兜底，等于没有授权。
 */
const NO_AUTH = new Set([
  'list_terminals', 'create_terminal', 'wait',
  'propose_host_memory', 'propose_quick_commands', 'propose_runbook',
])

function deps(over: Partial<TerminalToolDeps> = {}): TerminalToolDeps {
  return {
    terminals: {
      list: () => [{ id: 'term_1', title: '本地', type: 'local', status: 'running', locked: false }],
      readSnapshot: () => 'SNAP',
      execCapture: async (_id: string, cmd: string) => ({ output: `ran ${cmd}`, exitCode: 0 }),
    },
    resolveHostKey: () => 'local',
    decide: () => ({ kind: 'allow' }),
    grant: vi.fn(),
    audit: vi.fn(),
    ...over,
  } as never
}

const toolNames = () => terminalToolDefs(deps()).map((t) => t.name)
const writeTools = () => Object.entries(TOOL_NEEDS).filter(([, k]) => k === 'write').map(([n]) => n)

describe('工具定义自检（加工具时这几张表必须一起更新）', () => {
  it('每个工具要么在 NEEDS，要么在「不需要授权」白名单里', () => {
    const missing = toolNames().filter((n) => !(n in TOOL_NEEDS) && !NO_AUTH.has(n))
    expect(missing, `既没进 NEEDS 也不在 NO_AUTH：${missing.join('、')}（会在网关里落到默认放行）`).toEqual([])
  })

  it('NEEDS 里没有已经不存在的工具（改名后留下的死项）', () => {
    const all = new Set(toolNames())
    expect(Object.keys(TOOL_NEEDS).filter((n) => !all.has(n))).toEqual([])
  })

  it('NEEDS 判为写的工具，网关也必须认成写', () => {
    // 网关判成 'read' 的后果：decideByMode 的不变式「读操作永远放行」会让 auto / trust 档直接跳过授权
    const bad = writeTools().filter((n) => execKindOf(n) === 'read')
    expect(bad, `这些工具在 NEEDS 里是写、在 execGate 里被当成读：${bad.join('、')}`).toEqual([])
  })

  it('网关判为写的工具，NEEDS 也必须是写', () => {
    // NO_AUTH 里的工具本该"免授权"，被前缀规则（create_ / delete_ …）扫成写不算错：
    // 它们的决定由 decideFor 提前返回 allow，不经过模式放宽，不会造成越权或多余询问。
    const bad = toolNames().filter((n) => !NO_AUTH.has(n) && execKindOf(n) === 'write' && TOOL_NEEDS[n] !== 'write')
    expect(bad, `这些工具在 execGate 里是写、在 NEEDS 里不是：${bad.join('、')}`).toEqual([])
  })

  it('NEEDS 判为写的工具，只读子代理一律用不了', () => {
    // 两条路都行：进子代理的写名单，或进「永远不能用」名单（spawn_subagent 属于后者，防递归）
    const bad = writeTools().filter((n) => !isWriteTool(n) && !SUBAGENT_ALWAYS_DENY.has(n))
    expect(bad, `这些写工具没进子代理的写名单，只读子代理能用：${bad.join('、')}`).toEqual([])
  })

  it('工具名不重复，且都有说明与 execute', () => {
    const defs = terminalToolDefs(deps()) as { name: string; description?: string; execute?: unknown }[]
    expect(new Set(defs.map((d) => d.name)).size).toBe(defs.length)
    for (const d of defs) {
      expect(typeof d.name, d.name).toBe('string')
      expect(String(d.description ?? '').length, `${d.name} 缺描述`).toBeGreaterThan(10)
      expect(typeof d.execute, `${d.name} 缺 execute`).toBe('function')
    }
  })

  // 并发声明挂在 def 上（isConcurrencySafe）。包装层只要手写成 { name, execute } 就会把它吃掉，
  // 而且**不会有任何报错** —— 表现只是「声明了却不并行」。P2 的并行全靠这条守着。
  it('包装层不丢工具定义的附加字段（并发声明就靠这个存活）', () => {
    const probe = () => true
    const def = { name: 'probe_tool', description: '自检用探针工具', execute: async () => 'ok', isConcurrencySafe: probe } as never
    const wrapped = withRedaction(def, (() => undefined) as never) as { isConcurrencySafe?: unknown }
    expect(typeof wrapped.isConcurrencySafe).toBe('function')
    expect(wrapped.isConcurrencySafe).toBe(probe)
  })

  // 引擎默认把没声明并发安全的工具当独占 → 串行。要并发的必须在 CONCURRENT_OK 白名单里，
  // 而且写操作绝不能进去（同终端的写串行是硬要求）。
  it('并发声明：只读工具与只读子代理可并发，写操作保持独占', () => {
    const defs = terminalToolDefs(deps()) as { name: string; isConcurrencySafe?: (a: unknown) => boolean }[]
    const safe = (n: string, args: unknown = {}) => defs.find((d) => d.name === n)?.isConcurrencySafe?.(args) === true
    expect(safe('read_file'), 'read_file 应可并发（一次读多个文件少绕几轮）').toBe(true)
    expect(safe('spawn_subagent', { permission: 'read' }), '只读子代理应可并发').toBe(true)
    expect(safe('spawn_subagent', { permission: 'write' }), '写档子代理必须独占，否则同时弹多张授权卡').toBe(false)
    expect(safe('exec_in_terminal'), '同终端写操作必须独占').toBe(false)
    expect(safe('write_file'), '写文件必须独占').toBe(false)
    expect(safe('exec_on_terminals'), '内部已并行，外层再并发会放大成 N×M').toBe(false)
  })
})
