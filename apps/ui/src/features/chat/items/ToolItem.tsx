import { useEffect, useState } from 'react'
import { Terminal, FileEdit, FileText, Download, Upload, Wrench, Timer, Loader2, Check, X, ChevronRight, Plug, LocateFixed } from 'lucide-react'
import { LINGSHELL_TOOLS, gotoAiMark } from '../../terminals/index.js'
import type { ConvItem } from '../useConversation.js'
import { cn } from '../../../lib/cn.js'
import { DiffView } from '../../../components/DiffView.js'
import { ToolElapsed } from './TurnTime.js'
import { ToolRollback } from '../../auth/index.js'
import { Network, BookMarked, MessageCircleQuestion, BookPlus, Zap } from 'lucide-react'
import { fleetStatusText, fmtMs, tr, type FleetRow, type FleetSummary } from '@lingshell/shared'

function parseWriteResult(output?: string): { created?: boolean; backup_path?: string; diff?: string } | undefined {
  try { const j = JSON.parse(output ?? ''); return j && typeof j === 'object' && 'path' in j ? j : undefined } catch { return undefined }
}

interface MultiRun { terminal_id: string; title: string; host: string; exit_code: number; output: string; truncated?: boolean; error?: string }
interface MultiOut { results: MultiRun[]; summary: { same_output_groups: string[][]; failed: string[] } }
function parseMultiResult(output?: string): MultiOut | undefined {
  try { const j = JSON.parse(output ?? ''); return Array.isArray(j?.results) && j.summary ? j : undefined } catch { return undefined }
}

function mcpArgs(input?: Record<string, unknown>): string {
  const { explain: _e, ...rest } = input ?? {}
  return Object.keys(rest).length ? JSON.stringify(rest) : ''
}

const TERMINAL_TOOLS = new Set([
  'exec_in_terminal', 'exec_on_terminals', 'read_terminal', 'create_terminal', 'list_terminals', 'start_background', 'check_background',
])
const FILE_TOOL_ICON: Record<string, typeof Terminal> = { read_file: FileText, write_file: FileEdit, download_file: Download, upload_file: Upload, wait: Timer, run_on_hosts: Network, propose_host_knowledge: BookMarked, ask_user: MessageCircleQuestion, propose_runbook: BookPlus, propose_quick_commands: Zap }

interface FleetOut { command: string; results: FleetRow[]; summary: FleetSummary }
function parseFleetResult(output?: string): FleetOut | undefined {
  try { const j = JSON.parse(output ?? ''); return Array.isArray(j?.results) && j.summary && typeof j.summary.total === 'number' ? j : undefined } catch { return undefined }
}

// 工具调用卡片：显示工具名 + 参数（命令）+ 耗时 + 状态徽章 + 可展开结果。live = 所在回合仍在进行
export function ToolItem({ item, live = false }: { item: ConvItem; live?: boolean }) {
  const [open, setOpen] = useState(false)
  const tool = item.tool
  const name = tool?.name ?? tr('工具')
  // 终端类工具用终端图标；文件工具各有图标；其余含 file/write 的用编辑图标；其余通用扳手
  // MCP 外部工具（mcp__<服务>__<工具>）：插头图标，预览显示参数 JSON
  const mcp = name.startsWith('mcp__')
  const Icon = mcp ? Plug : TERMINAL_TOOLS.has(name) ? Terminal : FILE_TOOL_ICON[name] ?? (name.includes('file') || name.includes('write') ? FileEdit : Wrench)

  // 提取命令/主要参数用于一行预览
  const input = tool?.input as Record<string, unknown> | undefined
  // check_background 没有命令，预览显示它查的是哪个后台任务；知识卡提议显示标题
  const command = mcp ? mcpArgs(input) : (input?.command as string) ?? (input?.path as string)
    ?? (input?.job_id ? `job ${input.job_id as string}` : '')
  const preview0 = (name === 'propose_host_knowledge' || name === 'propose_runbook') && typeof input?.title === 'string' ? input.title
    : name === 'propose_quick_commands' && typeof input?.set_name === 'string' ? input.set_name
    : name === 'ask_user' && typeof input?.question === 'string' ? input.question
    : name === 'run_on_hosts' && Array.isArray(input?.targets) && command ? `[${(input.targets as string[]).join(', ')}] ${command}` : command
  // wait：显示「等待 N 秒 · 原因」
  const preview = name === 'wait' && input?.seconds ? tr('等待 {n} 秒', { n: String(input.seconds) }) + (input.reason ? ` · ${String(input.reason)}` : '') : preview0
  const output = tool?.output
  // write_file 结果带 diff：展开时按对比视图展示，而不是一坨 JSON
  const fileWrite = name === 'write_file' ? parseWriteResult(output) : undefined
  const multi = name === 'exec_on_terminals' ? parseMultiResult(output) : undefined
  const fleet = name === 'run_on_hosts' ? parseFleetResult(output) : undefined
  const explain = typeof input?.explain === 'string' ? input.explain.trim() : ''
  // 模型还在流式生成这个工具的参数：卡片先出来（虚线框），参数到齐才切到执行中
  const preparing = item.phase === 'preparing' && item.status === 'in_progress'

  return (
    <div className="animate-fade-in rounded-md px-3 py-1" data-tool-phase={preparing ? 'preparing' : item.status} data-call-id={item.itemId}>
      <div className={cn('overflow-hidden rounded-md border bg-[var(--color-bg-raised)]', preparing ? 'border-dashed border-[var(--color-border-strong)]' : 'border-[var(--color-border-default)]')}>
        {/* 头部 */}
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--color-bg-hover)]"
        >
          <ChevronRight className={cn('h-3 w-3 shrink-0 text-[var(--color-text-muted)] transition-transform', open && 'rotate-90')} />
          <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
          <span className="font-mono text-[12px] text-[var(--color-text-secondary)]">{name}</span>
          {preparing ? (
            <span className="min-w-0 flex-1 truncate text-[11px] italic text-[var(--color-text-muted)] animate-pulse-dim">{tr('生成参数中…')}</span>
          ) : preview && (
            <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--color-text-muted)]">{preview}</code>
          )}
          <ToolElapsed item={item} live={live} />
          <StatusBadge status={item.status} preparing={preparing} />
        </button>
        {/* AI 对命令的说明作副标题，不展开也能看懂这步在干什么 */}
        {explain && <div className="truncate px-2.5 pb-1.5 pl-[42px] text-[11px] text-[var(--color-text-muted)]">{explain}</div>}
        {/* 在终端里执行的命令：切到该终端、滚到这条命令（终端里行首紫色标记） */}
        {LINGSHELL_TOOLS.has(name) && !preparing && <LocateInTerminal callId={item.itemId} />}
        {/* AI 给了回滚方案的执行：卡片上直接「回滚」（与执行记录的一键回滚同一逻辑） */}
        {name === 'exec_in_terminal' && item.status === 'completed' && tool?.toolId && typeof input?.rollback === 'string' && input.rollback.trim() && (
          <ToolRollback callId={tool.toolId} rollback={input.rollback.trim()} />
        )}
        {/* 跨主机提问：结果表格直接展示（不用先展开），每行可点开看全文 */}
        {fleet && <div className="border-t border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-3 py-2"><FleetResultTable data={fleet} /></div>}
        {/* 展开：命令 + 输出 */}
        {open && (
          <div className="border-t border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-3 py-2">
            {command && (
              <div className="mb-1.5 font-mono text-[11px] text-[var(--color-accent)]">{input?.command ? '$ ' : ''}{command}</div>
            )}
            {fileWrite ? (
              <>
                <div className="text-[11px] text-[var(--color-text-muted)]">
                  {fileWrite.created ? tr('新建文件') : tr('file|已修改')}{fileWrite.backup_path ? tr('，原文件已备份到 {path}（可在执行记录里还原）', { path: fileWrite.backup_path }) : ''}
                </div>
                {fileWrite.diff && <DiffView diff={fileWrite.diff} maxHeight="max-h-64" />}
              </>
            ) : multi ? (
              <MultiResultTable data={multi} />
            ) : fleet ? null : output ? (
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-[var(--color-text-secondary)]">{output}</pre>
            ) : (
              <span className="font-mono text-[11px] text-[var(--color-text-muted)]">
                {item.status === 'in_progress' ? tr('执行中…') : tr('（无输出）')}
              </span>
            )}
            {item.error && <div className="mt-1.5 text-[11px] text-[var(--color-danger)]">{item.error}</div>}
          </div>
        )}
      </div>
    </div>
  )
}

// 多主机结果：一行一台（主机 · 退出码 · 首行），点开看该台完整输出。
// 输出不止一组时每行标组号 A/B/C…，人数最多那组之外的标黄，差异一眼可见
function MultiResultTable({ data }: { data: MultiOut }) {
  const [openId, setOpenId] = useState<string>()
  const groups = data.summary.same_output_groups
  const groupOf = new Map(groups.flatMap((g, i) => g.map((id) => [id, i] as const)))
  const major = groups.reduce((m, g, i) => (g.length > groups[m].length ? i : m), 0)
  const differs = groups.length > 1
  return (
    <div className="text-[11px]">
      <div className="mb-1 text-[var(--color-text-muted)]">
        {differs ? tr('输出分成 {n} 组（相同输出同组）', { n: groups.length }) : tr('各终端输出一致')}
        {data.summary.failed.length > 0 && tr('，{n} 台失败', { n: data.summary.failed.length })}
      </div>
      <div className="overflow-hidden rounded border border-[var(--color-border-subtle)]">
        {data.results.map((r) => {
          const g = groupOf.get(r.terminal_id) ?? 0
          const odd = differs && g !== major
          const first = (r.error ?? r.output).replace(/\r/g, '').trim().split('\n')[0] || tr('（无输出）')
          const isOpen = openId === r.terminal_id
          return (
            <div key={r.terminal_id} className="border-b border-[var(--color-border-subtle)] last:border-b-0">
              <button
                onClick={() => setOpenId(isOpen ? undefined : r.terminal_id)}
                className={cn('flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-[var(--color-bg-hover)]', odd && 'bg-[color:color-mix(in_srgb,var(--color-warn)_10%,transparent)]')}
              >
                <ChevronRight className={cn('h-3 w-3 shrink-0 text-[var(--color-text-muted)] transition-transform', isOpen && 'rotate-90')} />
                {differs && <span className={cn('w-3 shrink-0 font-mono', odd ? 'text-[var(--color-warn)]' : 'text-[var(--color-text-muted)]')}>{String.fromCharCode(65 + g)}</span>}
                <span className="w-32 shrink-0 truncate text-[var(--color-text-secondary)]" title={r.host}>{r.title}</span>
                <span className={cn('w-10 shrink-0 font-mono', r.exit_code === 0 ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]')}>{r.exit_code}</span>
                <code className="min-w-0 flex-1 truncate font-mono text-[var(--color-text-muted)]">{first}</code>
              </button>
              {isOpen && (
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap bg-[var(--color-bg-raised)] px-2 py-1.5 font-mono leading-relaxed text-[var(--color-text-secondary)]">
                  {r.error ? tr('错误：{error}', { error: r.error }) : r.output || tr('（无输出）')}{r.truncated ? `\n${tr('…（仅显示末尾）')}` : ''}
                </pre>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// 跨主机提问结果：主机 / 状态 / 退出码 / 耗时 / 输出摘要（首行），点一行展开该台全文。
// 输出不止一组时标组号 A/B/C…，人数最多那组之外的标黄；失败 / 超时 / 连不上的状态标红
function FleetResultTable({ data }: { data: FleetOut }) {
  const [openId, setOpenId] = useState<string>()
  const groups = data.summary.same_output_groups
  const groupOf = new Map(groups.flatMap((g, i) => g.map((id) => [id, i] as const)))
  const major = groups.reduce((m, g, i) => (g.length > (groups[m]?.length ?? 0) ? i : m), 0)
  const differs = groups.length > 1
  const failed = data.summary.failed.length
  return (
    <div className="text-[11px]" data-fleet-table>
      <div className="mb-1 text-[var(--color-text-muted)]">
        {tr('{total} 台主机：{ok} 台成功', { total: data.summary.total, ok: data.summary.ok })}{failed > 0 && <span className="text-[var(--color-danger)]">{tr('，{n} 台失败', { n: failed })}</span>}
        {differs ? tr('；输出分成 {n} 组（相同输出同组）', { n: groups.length }) : groups.length === 1 && groups[0].length > 1 ? tr('；跑完的主机输出一致') : ''}
      </div>
      <div className="overflow-hidden rounded border border-[var(--color-border-subtle)]">
        <div className="flex items-center gap-2 border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-raised)] px-2 py-1 text-[var(--color-text-muted)]">
          <span className="w-3 shrink-0" />{differs && <span className="w-3 shrink-0" />}
          <span className="w-28 shrink-0">{tr('主机')}</span><span className="w-20 shrink-0">{tr('状态')}</span><span className="w-10 shrink-0">{tr('退出码')}</span><span className="w-12 shrink-0">{tr('耗时')}</span><span className="min-w-0 flex-1">{tr('输出摘要')}</span>
        </div>
        {data.results.map((r) => {
          const g = groupOf.get(r.host_id)
          const odd = differs && g !== undefined && g !== major
          const bad = r.status !== 'ok'
          const first = (r.error ?? r.output).trim().split('\n')[0] || tr('（无输出）')
          const isOpen = openId === r.host_id
          return (
            <div key={r.host_id} data-fleet-row={r.host_id} className="border-b border-[var(--color-border-subtle)] last:border-b-0">
              <button onClick={() => setOpenId(isOpen ? undefined : r.host_id)}
                className={cn('flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-[var(--color-bg-hover)]', odd && 'bg-[color:color-mix(in_srgb,var(--color-warn)_10%,transparent)]')}>
                <ChevronRight className={cn('h-3 w-3 shrink-0 text-[var(--color-text-muted)] transition-transform', isOpen && 'rotate-90')} />
                {differs && <span className={cn('w-3 shrink-0 font-mono', odd ? 'text-[var(--color-warn)]' : 'text-[var(--color-text-muted)]')}>{g === undefined ? '' : String.fromCharCode(65 + g)}</span>}
                <span className="w-28 shrink-0 truncate text-[var(--color-text-secondary)]" title={`${r.label}${r.group ? tr('（{s}）', { s: r.group }) : ''} · ${r.host_id}`}>{r.label}</span>
                <span className={cn('w-20 shrink-0 truncate', bad ? 'text-[var(--color-danger)]' : 'text-[var(--color-success)]')}>{fleetStatusText(r)}</span>
                <span className={cn('w-10 shrink-0 font-mono', r.exit_code === 0 ? 'text-[var(--color-text-secondary)]' : 'text-[var(--color-danger)]')}>{r.exit_code ?? '—'}</span>
                <span className="w-12 shrink-0 font-mono text-[var(--color-text-muted)]">{fmtMs(r.ms)}</span>
                <code className="min-w-0 flex-1 truncate font-mono text-[var(--color-text-muted)]">{first}</code>
              </button>
              {isOpen && (
                <pre className="max-h-60 overflow-auto whitespace-pre-wrap bg-[var(--color-bg-raised)] px-2 py-1.5 font-mono leading-relaxed text-[var(--color-text-secondary)]">
                  {r.error ? `${tr('错误：{error}', { error: r.error })}\n` : ''}{r.output || (r.error ? '' : tr('（无输出）'))}{r.truncated ? `\n${tr('…（仅显示末尾）')}` : ''}
                </pre>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function LocateInTerminal({ callId }: { callId: string }) {
  const [miss, setMiss] = useState(false)
  useEffect(() => { if (!miss) return; const t = setTimeout(() => setMiss(false), 4000); return () => clearTimeout(t) }, [miss])
  return (
    <div className="flex items-start gap-2 px-2.5 pb-1.5 pl-[42px] text-[11px]">
      <button data-locate-term onClick={() => setMiss(!gotoAiMark(callId))}
        title={tr('切到执行这条命令的终端，并滚动到它的输出开头')}
        className="flex shrink-0 items-center gap-1 whitespace-nowrap text-[var(--color-reasoning)] hover:underline"><LocateFixed className="h-3 w-3" />{tr('在终端中定位')}</button>
      {miss && <span data-locate-miss className="min-w-0 text-[var(--color-text-muted)]">{tr('输出已不在终端缓冲里（终端已关闭、被清屏 / 滚出回滚行数，或应用重启过）')}</span>}
    </div>
  )
}

function StatusBadge({ status, preparing }: { status: ConvItem['status']; preparing?: boolean }) {
  if (preparing)
    return <span className="flex items-center gap-1 text-[11px] text-[var(--color-text-muted)]"><Loader2 className="h-3 w-3 animate-spin-slow" />{tr('准备中')}</span>
  if (status === 'in_progress')
    return <span className="flex items-center gap-1 text-[11px] text-[var(--color-warn)]"><Loader2 className="h-3 w-3 animate-spin-slow" />{tr('运行中')}</span>
  if (status === 'failed')
    return <span className="flex items-center gap-1 text-[11px] text-[var(--color-danger)]"><X className="h-3 w-3" />{tr('失败')}</span>
  return <span className="flex items-center gap-1 text-[11px] text-[var(--color-success)]"><Check className="h-3 w-3" />{tr('完成')}</span>
}
