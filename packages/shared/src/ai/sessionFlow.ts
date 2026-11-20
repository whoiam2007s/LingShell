import { tk, tr } from '../i18n/i18n.js'
import type { ItemKind, ItemStatus } from '../protocol/events.js'

/**
 * 会话流程图的数据构建（纯函数）。
 *
 * 结构：每轮对话 = 三个阶段，横向按轮推进，阶段内竖向多个节点
 *   阶段 0：提问 + 它携带的 chip（引用的终端 / 文件 / 图片 / 会话）
 *   阶段 1：工具调用与 AI 文字（执行层）
 *   阶段 2：产物（write_file 等写出来的文件）
 *
 * 节点上只放「图标 + 短名」，完整信息进 title（悬停）与 detail（点击）——
 * 流程图里要看到的是流向和排布，不是日志正文。
 */

/** 列内最多显示的节点数，超出折叠成「其余 +N」 */
export const FLOW_COL_MAX = 8

export interface FlowChip {
  kind: 'terminal' | 'file' | 'image' | 'text' | 'card' | 'other'
  label: string
  /** chip 指向的资源（终端 id / 文件路径），用于把它连到用到它的工具上 */
  ref?: string
}

/** buildSessionFlow 的输入：UI 的 ConvItem 结构上兼容它 */
export interface FlowInput {
  id: string
  turnId?: string
  kind: ItemKind
  status: ItemStatus
  text?: string
  tool?: { name: string; input?: unknown; output?: string }
  /** 条目时间（epoch ms） */
  at?: number
  /** 工具开始执行的时间（epoch ms） */
  callAt?: number
  chips?: FlowChip[]
}

export type FlowStage = 0 | 1 | 2
export type FlowNodeKind = 'ask' | 'chip' | 'tool' | 'text' | 'file' | 'auth' | 'more'

export interface FlowNode {
  id: string
  turn: number
  stage: FlowStage
  kind: FlowNodeKind
  /** 节点上显示的短名：exec / write / flow.html / 你的提问 */
  label: string
  /** 悬停摘要（一两行） */
  title: string
  /** 点击后的详情（命令、路径等） */
  detail?: string
  ok?: boolean
  /** 合并了几个同类节点（>1 时显示 ×N） */
  count?: number
  /** 折叠代表的数量 */
  folded?: number
  /** 内部用：原始参数文本（chip 的 ref 命中判断），不渲染 */
  match?: string
}

export type FlowEdgeKind = 'ask' | 'write' | 'weak' | 'chip' | 'carry'

export interface FlowEdge {
  from: string
  to: string
  kind: FlowEdgeKind
}

export interface SessionFlow {
  nodes: FlowNode[]
  edges: FlowEdge[]
  /** 窗口内的轮数 */
  turns: number
  /** 整个会话的轮数（用于导航） */
  totalTurns: number
  /** 窗口起始轮（0 起） */
  from: number
  /** 窗口大小 */
  size: number
  /** 被折叠掉的节点总数 */
  folded: number
}

// 工具短名：图上只放得下这么几个字符
const SHORT: Record<string, string> = {
  exec_in_terminal: 'exec',
  exec_on_terminals: 'exec',
  run_on_hosts: 'exec',
  write_file: 'write',
  read_file: 'read',
  read_image: 'scan',
  read_terminal: 'read',
  start_background: 'bg',
  check_background: 'read',
  spawn_subagent: 'agent',
  upload_file: 'upload',
  download_file: 'download',
  create_terminal: 'term',
  list_terminals: 'list',
  propose_plan: 'plan',
  ask_user: 'ask',
  propose_host_knowledge: 'note',
}

const WRITE_TOOLS = new Set(['write_file'])
const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** 从工具参数里掏出文件路径（只有读写类工具才有意义） */
function pathOf(name: string, input: unknown): string | undefined {
  if (name !== 'write_file' && name !== 'read_file') return undefined
  if (!input || typeof input !== 'object') return undefined
  const o = input as Record<string, unknown>
  return str(o.path) ?? str(o.file_path) ?? str(o.filePath)
}

/** 工具的一行摘要：命令取首行，其余取路径 / 关键参数 */
function summarize(name: string, input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const o = input as Record<string, unknown>
  const cmd = str(o.command)
  if (cmd) return cmd.split('\n')[0].slice(0, 120)
  const p = pathOf(name, input)
  if (p) return p
  if (name === 'spawn_subagent') return str(o.title) ?? str(o.task)?.slice(0, 80)
  if (name === 'ask_user') return str(o.question)?.slice(0, 80)
  if (name === 'propose_plan') return str(o.title)?.slice(0, 80)
  const first = Object.entries(o).find(([, v]) => typeof v === 'string')
  return first ? `${first[0]}=${String(first[1]).slice(0, 60)}` : undefined
}

const shortOf = (name: string) => SHORT[name] ?? name.replace(/^mcp__[^_]+__/, '').slice(0, 12)

const fmtAt = (ms?: number) => {
  if (!ms) return ''
  const d = new Date(ms)
  if (isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 按 user_message 切轮；第一条不是提问的内容归到第 0 轮 */
export function splitTurns(items: FlowInput[]): FlowInput[][] {
  const turns: FlowInput[][] = []
  let cur: FlowInput[] | undefined
  for (const it of items) {
    if (it.kind === 'user_message') {
      cur = [it]
      turns.push(cur)
    } else if (cur) cur.push(it)
    else {
      cur = [it]
      turns.push(cur)
    }
  }
  return turns
}

export function buildSessionFlow(items: FlowInput[], opts: { colMax?: number; from?: number; size?: number } = {}): SessionFlow {
  const colMax = Math.max(3, opts.colMax ?? FLOW_COL_MAX)
  const nodes: FlowNode[] = []
  const edges: FlowEdge[] = []
  const all = splitTurns(items)
  // 窗口化：一次只画 size 轮，避免几十轮横向拉成一条线、节点太多卡住
  const size = Math.max(1, opts.size ?? Math.max(1, all.length))
  const maxFrom = Math.max(0, all.length - size)
  const from = Math.max(0, Math.min(opts.from ?? maxFrom, maxFrom))
  const turns = all.slice(from, from + size)
  let folded = 0
  // 文件路径 → 最近一次产出它的节点（跨轮复用时连一条「上一轮结果」）
  const lastFile = new Map<string, string>()

  // 窗口前面还有更早的轮次：放一个入口节点（turn = -1，排在最左）
  if (from > 0) {
    nodes.push({
      id: 'more-earlier', turn: -1, stage: 0, kind: 'more',
      label: tr('更早的 {n} 轮', { n: from }),
      title: tr('窗口前面还有 {n} 轮', { n: from }),
      detail: tr('当前显示第 {a}–{b} 轮，共 {t} 轮', { a: from + 1, b: Math.min(all.length, from + size), t: all.length }),
      folded: from,
    })
  }

  turns.forEach((list, turn) => {
    const ask = list.find((x) => x.kind === 'user_message')
    const askId = ask ? `${ask.id}-ask` : `${turn}-ask`
    nodes.push({
      id: askId, turn, stage: 0, kind: 'ask',
      label: tk('你的提问'),
      title: ask?.text?.trim() ? ask.text.trim().slice(0, 400) : tk('你的提问'),
      detail: ask?.text?.trim() || undefined,
    })

    // chip：提问携带的引用
    const chips = ask?.chips ?? []
    const chipIds: { id: string; ref?: string }[] = []
    for (const [i, c] of chips.entries()) {
      const id = `${askId}-chip${i}`
      chipIds.push({ id, ref: c.ref })
      nodes.push({
        id, turn, stage: 0, kind: 'chip', label: c.label,
        title: `${c.label}${c.ref ? ` · ${c.ref}` : ''}`, detail: c.ref,
      })
      edges.push({ from: askId, to: id, kind: 'chip' })
    }

    // 阶段 1：工具 / 文字 / 授权
    const mid: FlowNode[] = []
    const fileNodes: FlowNode[] = []
    const fileOwner = new Map<string, string>()   // 文件 → 写它的工具节点 id
    for (const it of list) {
      if (it.kind === 'tool_call' && it.tool) {
        const name = it.tool.name
        const p = pathOf(name, it.tool.input)
        const detail = summarize(name, it.tool.input)
        mid.push({
          id: `${it.id}-tool`, turn, stage: 1, kind: 'tool',
          label: shortOf(name),
          title: [name, detail].filter(Boolean).join(' · '),
          detail: [detail, fmtAt(it.callAt ?? it.at)].filter(Boolean).join('  ·  '),
          ok: it.status !== 'failed',
          match: it.tool.input ? JSON.stringify(it.tool.input) : undefined,
        })
        if (p && WRITE_TOOLS.has(name)) {
          const fid = `${turn}-file-${basename(p)}`
          if (!fileOwner.has(p)) {
            fileNodes.push({ id: fid, turn, stage: 2, kind: 'file', label: basename(p), title: p, detail: p })
            fileOwner.set(p, `${it.id}-tool`)
            edges.push({ from: `${it.id}-tool`, to: fid, kind: 'write' })
          } else {
            // 同一轮重复写同一个文件：连线到已有产物节点
            edges.push({ from: `${it.id}-tool`, to: fileNodes.find((f) => f.title === p)?.id ?? fid, kind: 'write' })
          }
        }
      } else if (it.kind === 'agent_message') {
        mid.push({
          id: `${it.id}-text`, turn, stage: 1, kind: 'text',
          label: tk('AI 说明'),
          title: (it.text ?? '').trim().slice(0, 400) || tk('AI 说明'),
          detail: (it.text ?? '').trim().slice(0, 2000) || undefined,
          ok: it.status !== 'failed',
        })
      } else if (it.kind === 'auth_request') {
        mid.push({
          id: `${it.id}-auth`, turn, stage: 1, kind: 'auth',
          label: tk('授权'),
          title: it.text?.trim() || tk('授权'),
          detail: it.text?.trim(),
          ok: it.status !== 'failed',
        })
      }
    }

    // 提问 → 阶段 1（扇出）
    for (const n of mid) {
      edges.push({ from: askId, to: n.id, kind: 'ask' })
      // chip 带 ref 的，连到参数里出现该 ref 的工具上
      for (const c of chipIds) {
        if (c.ref && n.match?.includes(c.ref)) edges.push({ from: c.id, to: n.id, kind: 'chip' })
      }
    }

    // 跨轮：本轮的产物如果在更早的轮次出现过，连一条「接着用」
    for (const f of fileNodes) {
      const prev = lastFile.get(f.title ?? '')
      if (prev) edges.push({ from: prev, to: fileOwner.get(f.title ?? '') ?? f.id, kind: 'carry' })
    }
    for (const f of fileNodes) lastFile.set(f.title ?? '', f.id)

    // 折叠：阶段 1 / 2 超过 colMax 时收成「其余 +N」
    const fold = (arr: FlowNode[], stage: FlowStage): FlowNode[] => {
      if (arr.length <= colMax) return arr
      const keep = arr.slice(0, colMax - 1)
      const rest = arr.slice(colMax - 1)
      folded += rest.length - 1
      const head = rest[0]
      const more: FlowNode = {
        id: `${turn}-more-${stage}`, turn, stage,
        kind: head.kind, label: stage === 2 ? tk('其余产物') : tk('其余工具'),
        title: rest.map((r) => r.title).join('\n'),
        detail: rest.map((r) => r.title).join('; ').slice(0, 2000),
        count: rest.length,
        folded: rest.length,
      }
      // 折叠节点继承被折掉的工具的连线（谁指向它们就指向它）
      for (const r of rest) {
        for (const e of edges) if (e.to === r.id) e.to = more.id
        for (const e of edges) if (e.from === r.id) e.from = more.id
      }
      return [...keep, more]
    }

    nodes.push(...fold(mid, 1))
    nodes.push(...fold(fileNodes, 2))
  })

  return { nodes, edges, turns: turns.length, totalTurns: all.length, from, size, folded }
}

export { shortOf, pathOf, summarize }
