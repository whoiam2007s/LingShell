// 批量修改主机（设置 → SSH 连接管理 →「批量修改」）：先预览每台 旧值→新值，确认后执行；执行前备份 hosts.json，可撤销上次。
// 只改非凭据字段；使用凭据的主机用户名不改（在凭据里改）
import { MAX_JUMP_DEPTH } from '../protocol/types.js'
import type { HostEnv, HostSummary } from '../protocol/index.js'
import { tk, tr } from '../i18n/i18n.js'

export type HostBatchField = 'host' | 'port' | 'username' | 'jumpHostId' | 'group' | 'env'
// 字段缺省 = 不改。hostFind/hostReplace：地址纯文本查找替换（全部出现处）；jumpHostId '' = 改直连；group '' = 清空；env '' = 未标注
export interface HostBatchPatch {
  hostFind?: string; hostReplace?: string
  port?: number
  username?: string
  jumpHostId?: string
  group?: string
  env?: HostEnv | ''
}
export interface HostBatchChange { field: HostBatchField; from: string; to: string }
export interface HostBatchItem { id: string; label: string; changes: HostBatchChange[]; skipped: string[] }
export interface HostBatchUndoInfo { at: string; count: number; backup: string }

export const HOST_BATCH_LABEL: Record<HostBatchField, string> = { host: tk('地址'), port: tk('端口'), username: tk('用户名'), jumpHostId: tk('跳板机'), group: tk('分组'), env: tk('分级') }
// 值进 HostBatchChange.from/to，界面按 c.to === '生产' 判断标红：保持中文，界面显示时再 tr()
const ENV_TEXT = (e?: string) => (e === 'prod' ? tk('生产') : e === 'test' ? tk('测试') : tk('未标注'))

/** 校验 patch，不合法抛错（中文原因） */
export function checkHostBatchPatch(p: HostBatchPatch): void {
  if (p.port !== undefined && !(Number.isInteger(p.port) && p.port >= 1 && p.port <= 65535)) throw new Error('batch_invalid: ' + tr('端口须是 1–65535 的整数'))
  if (p.username !== undefined && !p.username.trim()) throw new Error('batch_invalid: ' + tr('用户名不能为空'))
  if (p.env !== undefined && p.env !== '' && p.env !== 'prod' && p.env !== 'test') throw new Error('batch_invalid: ' + tr('分级不合法'))
  if (p.hostReplace !== undefined && !p.hostFind) throw new Error('batch_invalid: ' + tr('地址替换需填「查找」'))
}

/** 生成每台主机的修改计划（纯函数）。跳板按「全部改完后」的链路校验成环/超深，不合法的那台跳过跳板修改 */
export function planHostBatch(hosts: HostSummary[], ids: string[], p: HostBatchPatch): HostBatchItem[] {
  checkHostBatchPatch(p)
  const byId = new Map(hosts.map((h) => [h.id, h]))
  const jumpText = (id?: string) => (id ? byId.get(id)?.label ?? '?' : tr('直连'))
  const pick = [...new Set(ids)].map((id) => byId.get(id)).filter((h): h is HostSummary => !!h)
  const items = pick.map((h): HostBatchItem => {
    const changes: HostBatchChange[] = [], skipped: string[] = []
    const add = (field: HostBatchField, from: string, to: string) => { if (from !== to) changes.push({ field, from, to }) }
    if (p.hostFind && h.host.includes(p.hostFind)) {
      const to = h.host.split(p.hostFind).join(p.hostReplace ?? '').trim()
      if (to) add('host', h.host, to); else skipped.push(tr('替换后地址为空，地址不改'))
    }
    if (p.port !== undefined) add('port', String(h.port), String(p.port))
    if (p.username !== undefined) {
      if (h.credentialId) { if (h.username !== p.username.trim()) skipped.push(tr('使用凭据，用户名不改（请在凭据里改）')) }
      else add('username', h.username, p.username.trim())
    }
    if (p.jumpHostId !== undefined && (h.jumpHostId ?? '') !== p.jumpHostId) {
      if (p.jumpHostId === h.id) skipped.push(tr('不能以自己为跳板机'))
      else if (p.jumpHostId && h.proxyCommand) skipped.push(tr('已设 ProxyCommand，不能再设跳板机'))
      else if (p.jumpHostId && !byId.has(p.jumpHostId)) skipped.push(tr('跳板机不存在'))
      else add('jumpHostId', jumpText(h.jumpHostId), jumpText(p.jumpHostId || undefined))
    }
    if (p.group !== undefined) add('group', h.group ?? '', p.group.trim())
    if (p.env !== undefined) add('env', ENV_TEXT(h.env), ENV_TEXT(p.env))
    return { id: h.id, label: h.label, changes, skipped }
  })
  // 跳板：按改完后的链路逐台校验，坏的撤掉该台的跳板修改后再验一轮（直到稳定）
  for (let round = 0; round <= items.length; round++) {
    const jumpOf = new Map(hosts.map((h) => [h.id, h.jumpHostId]))
    for (const it of items) if (it.changes.some((c) => c.field === 'jumpHostId')) jumpOf.set(it.id, p.jumpHostId || undefined)
    const bad = items.find((it) => it.changes.some((c) => c.field === 'jumpHostId') && jumpChainError(it.id, jumpOf))
    if (!bad) break
    bad.skipped.push(tr('跳板机不可用：{v}', { v: String(jumpChainError(bad.id, jumpOf)) }))
    bad.changes = bad.changes.filter((c) => c.field !== 'jumpHostId')
  }
  return items.filter((it) => it.changes.length || it.skipped.length)
}

function jumpChainError(id: string, jumpOf: Map<string, string | undefined>): string | undefined {
  const seen = new Set([id])
  let cur = jumpOf.get(id)
  for (let depth = 1; cur; depth++) {
    if (seen.has(cur)) return tr('链路成环')
    if (depth > MAX_JUMP_DEPTH) return tr('最多 {n} 级', { n: MAX_JUMP_DEPTH })
    seen.add(cur)
    cur = jumpOf.get(cur)
  }
  return undefined
}
