// 监听端口 → 对话：把端口面板已有的字段拼成引用文本。
// 这里先做一件纯函数能做的事：**按监听地址判断是不是对外暴露**（0.0.0.0 / :: / *），
// 别让模型再去数数 —— 它只负责判断风险和给收紧办法。
import { tr } from '@lingshell/shared'

/** 一次最多带多少条端口（再多就成日志了） */
export const MAX_BATCH = 30

export interface PortQuoteEntry {
  proto: string
  addr: string
  port: number
  process?: string
  pid?: number
}

/** 通配监听地址 = 所有网卡都在听，也就是对外暴露 */
export const isWildcard = (addr: string): boolean => ['0.0.0.0', '::', '[::]', '*'].includes(addr.trim())

/** 只在本机回环上听 */
export const isLoopback = (addr: string): boolean => /^(127\.|localhost|\[?::1\]?$)/i.test(addr.trim())

const addrKind = (addr: string): string =>
  isWildcard(addr) ? tr('所有网卡（对外）') : isLoopback(addr) ? tr('仅本机回环') : tr('指定地址 {addr}', { addr })

const procOf = (e: PortQuoteEntry): string =>
  e.process ? (e.pid ? tr('{name}（PID {pid}）', { name: e.process, pid: e.pid }) : e.process) : tr('看不到进程（需要更高权限）')

export interface PortEntryQuoteInput {
  host: string
  entry: PortQuoteEntry
  /** 面板用的探测工具：ss / netstat / Windows netstat */
  tool?: string
}

/** 单个端口：该不该对外、谁在听、要不要收紧 */
export function portEntryQuote(i: PortEntryQuoteInput): string {
  const e = i.entry
  return [
    tr('帮我看看这个监听端口有没有风险。'),
    '',
    tr('（下面是我从「监听端口」面板复制的信息，不是命令输出）'),
    tr('主机：{host}', { host: i.host }),
    tr('协议：{proto}', { proto: e.proto }),
    tr('监听：{addr}:{port}（{kind}）', { addr: e.addr, port: e.port, kind: addrKind(e.addr) }),
    tr('进程：{proc}', { proc: procOf(e) }),
    ...(i.tool ? [tr('探测工具：{tool}', { tool: i.tool })] : []),
    '',
    tr('请判断：1) 这个监听地址是否意味着对外可访问，风险有多大；2) 这个端口的常见用途，以及是不是该限制到内网或只监听回环；3) 给具体做法（防火墙规则或改配置），命令要能直接跑。'),
  ].join('\n')
}

export interface PortBatchQuoteInput {
  host: string
  entries: PortQuoteEntry[]
  tool?: string
}

/** 一批端口：找对外暴露的、可疑的，给收紧建议 */
export function portBatchQuote(i: PortBatchQuoteInput): string {
  const sorted = [...i.entries].sort((a, b) => a.port - b.port)
  const list = sorted.slice(0, MAX_BATCH)
  const exposed = list.filter((e) => isWildcard(e.addr)).length
  const lines = [
    tr('帮我看下【{host}】上这些监听端口，哪些不该对外。', { host: i.host }),
    '',
    tr('（从「监听端口」面板复制的 {n} 条记录；其中 {k} 条监听所有网卡 = 对外暴露）', { n: list.length, k: exposed }),
    ...(i.tool ? [tr('探测工具：{tool}', { tool: i.tool })] : []),
    '',
  ]
  list.forEach((e) => {
    lines.push(`- ${e.proto} ${e.addr}:${e.port} · ${procOf(e)}${isWildcard(e.addr) ? tr(' · 【对外】') : ''}`)
  })
  if (sorted.length > MAX_BATCH) lines.push(tr('（后面还有 {n} 条没带上）', { n: sorted.length - MAX_BATCH }))
  lines.push('', tr('请回答：1) 哪些端口对外暴露、风险排序；2) 其中哪些像是意外暴露（开发调试、数据库、管理端口）；3) 收紧办法（防火墙规则 / 改监听地址），命令要能直接跑。'))
  return lines.join('\n')
}
