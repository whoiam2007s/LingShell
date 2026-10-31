// 配置按键对比：读一端的文件（本机 / 已保存主机 / 在线 SSH 终端，连接选择同「多台主机比对文件」，见 ipc.ts 注入的 open）。
// 只读，上限 1MB、按主机编码解码、二进制拒绝（复用 fileCompare.readForCompare）；拍平与对比在渲染层（shared/ops/configDiff.ts）
import { COMPARE_MAX_BYTES, tr, type CompareTarget } from '@lingshell/shared'
import { readForCompare } from '../files/index.js'
import type { FileAccess } from '../files/index.js'

export interface ConfigDiffDeps {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  /** 取文件访问；close 断开临时连接（复用在线终端时为空操作） */
  open(t: CompareTarget): Promise<{ fa: FileAccess; close(): void }>
  log?(message: string, data?: unknown): void
}

const isTarget = (t: unknown): t is CompareTarget => {
  const x = t as { kind?: unknown; hostId?: unknown; terminalId?: unknown } | null
  return !!x && (x.kind === 'local' || (x.kind === 'host' && typeof x.hostId === 'string') || (x.kind === 'terminal' && typeof x.terminalId === 'string'))
}

export function registerConfigDiff(d: ConfigDiffDeps): void {
  d.handle('configDiff:read', async (_e, t, p) => {
    if (!isTarget(t)) throw new Error(tr('非法的目标'))
    if (typeof p !== 'string' || !p.trim() || p.length > 4096) throw new Error(tr('请填写文件路径'))
    let conn: { fa: FileAccess; close(): void } | undefined
    try {
      const r = await readForCompare(async () => (conn = await d.open(t)).fa, p.trim(), COMPARE_MAX_BYTES)
      d.log?.('configDiff read', { kind: t.kind, ok: r.ok })
      if (!r.ok) throw new Error(r.error)
      return { text: r.text }
    } finally { conn?.close() }
  })
}
