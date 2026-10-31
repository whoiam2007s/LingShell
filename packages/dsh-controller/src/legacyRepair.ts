/* eslint-disable @typescript-eslint/no-explicit-any */
// dsh 0.1.1 写下的 v0 会话日志修复：0.2 的 v0→v1 迁移器（@deepseek-ai/dsh-session-format-v0-to-v1）
// 对 turn/end 的校验比 0.1.1 写入时严，旧版「停止」留下的 turn/end 会被整份拒绝，resume 失败。
//
// 迁移器对 turn/end 的规则（读其 normalizeLegacyTurnEnd + turnEndReasonValue + llmFailureValue）：
//   data 只能有 turn（≥1 的整数）+ reason（对象）；reason.kind 必须是字符串；
//   completed / blocked / max-tokens / interrupted：reason 只能有 kind；
//   aborted：只能有 kind + reason；缺 reason 时迁移器自己补 { kind: 'legacy' }；
//     reason（cause）必须是对象：{ kind: user|parent|disposed|legacy } 或 { kind: 'hook', reason: 字符串 }，不许多余字段；
//   disposed：只能有 kind（迁移器转成 aborted/disposed）；
//   error：要么 { kind, error }，error = { message 非空, code 非空, status?100-599, providerRetryAfterMs?>0, requestId?非空 }；
//     要么旧形 { kind, step, failure } / { kind, step, message, code? }（迁移器自己转）；
//   其它 kind：只要求非空字符串（当不透明值保留）。
// 0.1.1 的 agent.cancel(cause) 把 cause 原样写进 reason.reason：旧版 LingShell 传的是字符串 'user'，
// 传 Error 则序列化成 {}——都过不了「cause 必须是对象且 kind 合法」。这里把这些都规范成迁移器接受的形状。
//
// dsh 没有迁移前的扩展点（格式目录是 jsonl 持久化包静态导入的，插件配置只有 root / compression），
// 所以自己修：读原日志 → 规范化 → 写到**新会话 id** 的目录（同一项目目录下），原文件一个字节都不动。
// 读写 zstd 用的是 dsh 持久化同款的 node:zlib zstd（拼接的标准帧，首帧只放 header 一行）。
import * as zlib from 'node:zlib'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { join, dirname, basename } from 'node:path'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0

const ABORT_KINDS = new Set(['user', 'parent', 'disposed', 'legacy'])
const SIMPLE_KINDS = new Set(['completed', 'blocked', 'max-tokens', 'interrupted'])

/** abort 的 cause → 迁移器接受的对象。字符串 'user' 等按原意保留，认不出的一律 legacy（迁移器自己也用它表示「旧版、原因不明」） */
export function normalizeAbortCause(cause: unknown): Obj {
  const kind = typeof cause === 'string' ? cause : isObj(cause) ? cause.kind : undefined
  if (kind === 'hook' && isObj(cause) && typeof cause.reason === 'string') return { kind: 'hook', reason: cause.reason }
  if (typeof kind === 'string' && ABORT_KINDS.has(kind)) return { kind }
  return { kind: 'legacy' }
}

function normalizeFailure(f: unknown): Obj {
  const o = isObj(f) ? f : {}
  const out: Obj = { message: nonEmpty(o.message) ? o.message : (typeof f === 'string' && f) || 'unknown error', code: nonEmpty(o.code) ? o.code : 'UNKNOWN' }
  if (Number.isSafeInteger(o.status) && (o.status as number) >= 100 && (o.status as number) <= 599) out.status = o.status
  if (typeof o.providerRetryAfterMs === 'number' && Number.isFinite(o.providerRetryAfterMs) && o.providerRetryAfterMs > 0) out.providerRetryAfterMs = o.providerRetryAfterMs
  if (nonEmpty(o.requestId)) out.requestId = o.requestId
  return out
}

/** turn/end 的 reason → 迁移器接受的形状（已经合规的原样返回同值） */
export function normalizeTurnEndReason(reason: unknown): unknown {
  const r: unknown = typeof reason === 'string' ? { kind: reason } : reason
  if (!isObj(r) || !nonEmpty(r.kind)) return { kind: 'aborted', reason: { kind: 'legacy' } }
  const kind = r.kind
  if (SIMPLE_KINDS.has(kind) || kind === 'disposed') return { kind }
  if (kind === 'aborted') return Object.hasOwn(r, 'reason') ? { kind, reason: normalizeAbortCause(r.reason) } : { kind }
  if (kind === 'error') {
    if (Object.hasOwn(r, 'error')) return { kind, error: normalizeFailure(r.error) }
    if (Object.hasOwn(r, 'failure')) return { kind, error: normalizeFailure(r.failure) }
    return { kind, error: normalizeFailure({ message: r.message, code: r.code }) }
  }
  return r   // 未知 kind：迁移器当不透明值保留
}

/**
 * 逐行修复 v0 日志（第 0 行是 header）。header id 与本会话的投递标记改成 toId（副本放在 toId 的目录下，dsh 要求一致）；
 * changes 只记真正的格式修复——为空说明修不了（不是我们认识的问题），调用方不必再试。
 */
export function repairV0Lines(lines: string[], fromId: string, toId: string): { lines: string[]; changes: string[] } {
  const changes: string[] = []
  const out = lines.map((line, i) => {
    let row: any
    try { row = JSON.parse(line) } catch { return line }   // 坏行交给迁移器的可恢复解码
    if (i === 0) return row?.type === 'session' ? JSON.stringify({ ...row, id: toId }) : line
    if (row?.type === 'session-log-deepseek/delivery-accepted' && row.data?.sessionId === fromId) {
      return JSON.stringify({ ...row, data: { ...row.data, sessionId: toId } })
    }
    if (row?.type !== 'turn/end' || !isObj(row.data)) return line
    const before = JSON.stringify(row.data)
    const data = { turn: row.data.turn, reason: normalizeTurnEndReason(row.data.reason) }
    const after = JSON.stringify(data)
    if (after === before) return line
    changes.push(`turn/end ${row.seq}: ${before.slice(0, 120)} → ${after}`)
    return JSON.stringify({ ...row, data })
  })
  return { lines: out, changes }
}

// ── zstd 读写（dsh 的日志 = 拼接的独立 zstd 帧；node 的一次性解压只解第一帧，所以逐帧切开）──
const z = zlib as any
const ZSTD_MAGIC = 0xfd2fb528

/** 切出完整帧（同 dsh-session-persistence-jsonl 的 scanZstdFrames）；末尾残缺帧（写一半被杀）丢掉 */
export function zstdFrames(b: Buffer): Buffer[] {
  const out: Buffer[] = []
  let o = 0
  while (b.length - o >= 6 && b.readUInt32LE(o) === ZSTD_MAGIC) {
    const start = o
    o += 4
    const d = b[o++]
    const csf = d >>> 6, single = (d & 32) !== 0, df = d & 3
    o += (single ? 0 : 1) + (df === 3 ? 4 : df) + (csf === 0 ? (single ? 1 : 0) : 1 << csf)
    for (;;) {
      if (b.length - o < 3) return out
      const h = b.readUIntLE(o, 3)
      o += 3 + (((h >>> 1) & 3) === 1 ? 1 : h >>> 3)
      if (o > b.length) return out
      if (h & 1) break
    }
    if (d & 4) o += 4
    if (o > b.length) return out
    out.push(b.subarray(start, o))
  }
  return out
}

/** 读日志为行（.zstd 逐帧解压，否则纯文本）；末尾不完整的一行丢掉 */
export async function readLogLines(path: string): Promise<string[]> {
  const buf = await readFile(path)
  const text = path.endsWith('.zstd') ? zstdFrames(buf).map((f) => z.zstdDecompressSync(f).toString('utf8')).join('') : buf.toString('utf8')
  const lines = text.split('\n')
  lines.pop()   // 正常结尾是 '\n' → 最后一段为空；否则是残行
  return lines.filter((l) => l.length > 0)
}

/** 按 dsh 的物理格式写日志：首帧只放 header 一行，其余行一帧；带校验和。先写临时文件再改名 */
export async function writeLogLines(path: string, lines: string[]): Promise<void> {
  const [header, ...rest] = lines
  let data: Buffer
  if (path.endsWith('.zstd')) {
    const opts = { params: { [z.constants.ZSTD_c_checksumFlag]: 1 } }
    const frames = [z.zstdCompressSync(Buffer.from(`${header}\n`), opts)]
    if (rest.length) frames.push(z.zstdCompressSync(Buffer.from(`${rest.join('\n')}\n`), opts))
    data = Buffer.concat(frames)
  } else data = Buffer.from(`${lines.join('\n')}\n`)
  const tmp = `${path}.repair.tmp`
  await writeFile(tmp, data)
  await rename(tmp, path)
}

export interface LegacyRepair { path: string; changes: string[] }

/**
 * 把 fromId 的 v0 日志修复成 toId 的副本（同一项目目录下 toId/ 目录），原日志不动。
 * 不是 v0、没有可修的问题 → undefined。store = dsh 的 sessionPersistence（用它定位日志）。
 */
export async function repairLegacyLog(store: any, fromId: string, toId: string): Promise<LegacyRepair | undefined> {
  if (!/^[A-Za-z0-9._-]+$/.test(toId)) throw new Error(`unsafe session id: ${toId}`)   // 这样目录名 = id（dsh 的 encodeSegment 不转义）
  const found = await store.findLog(fromId)
  if (!found?.sourcePath || found.sourceVersion !== 0) return undefined
  const fixed = repairV0Lines(await readLogLines(found.sourcePath), fromId, toId)
  if (!fixed.changes.length) return undefined
  const dir = join(dirname(dirname(found.sourcePath)), toId)
  await mkdir(dir, { recursive: true })
  const path = join(dir, basename(found.sourcePath))
  await writeLogLines(path, fixed.lines)
  return { path, changes: fixed.changes }
}

/** resume 失败原因 → 给人看的一句（取迁移器报的具体那条） */
export function failureSummary(e: unknown): string {
  const s = String((e as Error)?.message ?? e).replace(/^\w*Error:\s*/, '')
  const m = /Session: (.+)$/s.exec(s)
  return (m?.[1] ?? s).split(/;|\s\(raw log:/)[0].trim().slice(0, 160)
}
