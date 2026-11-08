// 监听端口 → 上下文 chip：chip 上只显示「监听地址:端口」，随消息发给 AI 的是完整事实。
// 这里先做一件纯函数能做的事：**按监听地址判断是不是对外暴露**（0.0.0.0 / :: / *），
// 别让模型再去数数 —— 它只负责判断风险、给收紧办法。
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

/** chip 的名字 + 随消息发出去的全文 */
export interface ChipQuote { name: string; text: string }

/** 通配监听地址 = 所有网卡都在听，也就是对外暴露 */
export const isWildcard = (addr: string): boolean => ['0.0.0.0', '::', '[::]', '*'].includes(addr.trim())

/** 只在本机回环上听 */
export const isLoopback = (addr: string): boolean => /^(127\.|localhost|\[?::1\]?$)/i.test(addr.trim())

const addrKind = (addr: string): string =>
  isWildcard(addr) ? tr('所有网卡（对外）') : isLoopback(addr) ? tr('仅本机回环') : tr('指定地址 {addr}', { addr })

const procOf = (e: PortQuoteEntry): string =>
  e.process
    ? e.pid ? `${e.process}${tr('（PID {pid}）', { pid: e.pid })}` : e.process
    : tr('进程看不到（需要更高权限，或不是当前用户的进程）')

export interface PortEntryChipInput {
  host: string
  entry: PortQuoteEntry
  /** 面板用的探测工具：ss / netstat / Windows netstat */
  tool?: string
}

/** 单个端口：chip 名 = 地址:端口 */
export function portEntryChip(i: PortEntryChipInput): ChipQuote {
  const e = i.entry
  return {
    name: `${e.addr}:${e.port}`,
    text: [
      tr('【监听端口】'),
      tr('主机：{host}', { host: i.host }),
      tr('协议：{proto}', { proto: e.proto }),
      tr('监听地址：{addr}:{port}（{kind}）', { addr: e.addr, port: e.port, kind: addrKind(e.addr) }),
      tr('进程：{proc}', { proc: procOf(e) }),
      ...(i.tool ? [tr('探测工具：{tool}', { tool: i.tool })] : []),
      tr('说明：这是端口面板里的信息，不是命令输出。'),
    ].join('\n'),
  }
}

export interface PortBatchChipInput {
  host: string
  entries: PortQuoteEntry[]
  tool?: string
}

/** 一批端口：chip 名 = 「N 个端口」，全文按端口号排序，并统计对外暴露的条数 */
export function portBatchChip(i: PortBatchChipInput): ChipQuote {
  const sorted = [...i.entries].sort((a, b) => a.port - b.port)
  const list = sorted.slice(0, MAX_BATCH)
  const exposed = list.filter((e) => isWildcard(e.addr)).length
  const more = sorted.length > MAX_BATCH ? tr('（另有 {n} 条未带）', { n: sorted.length - MAX_BATCH }) : ''
  const lines = [
    tr('【监听端口】'),
    tr('主机：{host}', { host: i.host }),
    tr('共 {n} 条{more}，其中 {k} 条监听所有网卡 = 对外暴露：', { n: list.length, more, k: exposed }),
    ...(i.tool ? [tr('探测工具：{tool}', { tool: i.tool })] : []),
    '',
  ]
  list.forEach((e) => {
    lines.push(`- ${e.proto} ${e.addr}:${e.port} · ${procOf(e)}${isWildcard(e.addr) ? tr(' · 【对外】') : ''}`)
  })
  lines.push('', tr('说明：这是端口面板里的信息，不是命令输出。'))
  return { name: tr('{n} 个端口', { n: list.length }), text: lines.join('\n') }
}
