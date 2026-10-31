// 多台主机比对配置文件（只读，见 shared/files/fileCompare.ts）：并发读各台、逐台与基准做 unified diff。
// 单台读取失败（不存在 / 无权限 / 过大 / 二进制 / 连不上）只标这一台，不影响其它台。
import { COMPARE_MAX_BYTES, decodeText, normalizeConfig, unifiedDiff, tr, type CompareResult } from '@lingshell/shared'
import type { FileAccess } from './fileOps.js'

type Read = { ok: true; text: string } | { ok: false; error: string }

const errMsg = (e: unknown) => {
  const code = (e as { code?: unknown })?.code
  // SFTP 状态码 3 = PERMISSION_DENIED；本地 EACCES / EPERM
  if (code === 3 || code === 'EACCES' || code === 'EPERM') return tr('没有读取权限')
  if (code === 'EISDIR') return tr('是目录，不是文件')
  return e instanceof Error ? e.message : String(e)
}

/** 读一台：open 取文件访问（可能要建临时连接），按主机编码解码；任何失败都折成 error，不抛 */
export async function readForCompare(open: () => Promise<FileAccess>, path: string, maxBytes = COMPARE_MAX_BYTES): Promise<Read> {
  try {
    const fa = await open()
    const buf = await fa.read(await fa.resolve(path), maxBytes)
    if (buf === undefined) return { ok: false, error: tr('文件不存在') }
    if (buf.includes(0)) return { ok: false, error: tr('二进制文件，不比对') }
    return { ok: true, text: decodeText(buf, fa.encoding) }
  } catch (e) {
    return { ok: false, error: errMsg(e) }
  }
}

/** 逐台对比基准。added/removed 按 diff 的 +/- 行数（diff 超长被截断时只计截断前的部分） */
export function compareTexts(reads: Read[], baseline: number, path: string, ignoreNoise = false): CompareResult[] {
  const prep = (t: string) => (ignoreNoise ? normalizeConfig(t) : t)
  const base = reads[baseline]
  return reads.map((r, i): CompareResult => {
    if (!r.ok) return { status: 'error', error: r.error }
    if (i === baseline) return { status: 'baseline' }
    if (!base?.ok) return { status: 'skipped' }
    const diff = unifiedDiff(prep(base.text), prep(r.text), path)
    if (!diff) return { status: 'same' }
    const lines = diff.split('\n').slice(2)
    const added = lines.filter((l) => l.startsWith('+')).length, removed = lines.filter((l) => l.startsWith('-')).length
    return { status: 'diff', added, removed, diff }
  })
}

/** 并发读所有目标再比对；单台超时按失败计（连接卡死不拖住整体）。60s：临时连接首连可能要等用户确认指纹 */
export async function compareFiles(opens: (() => Promise<FileAccess>)[], path: string, baseline: number, ignoreNoise = false, timeoutMs = 60_000): Promise<CompareResult[]> {
  const reads = await Promise.all(opens.map((open) => {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<Read>((r) => { timer = setTimeout(() => r({ ok: false, error: tr('读取超时（{n}s）', { n: timeoutMs / 1000 }) }), timeoutMs) })
    return Promise.race([readForCompare(open, path), timeout]).finally(() => clearTimeout(timer))
  }))
  return compareTexts(reads, baseline, path, ignoreNoise)
}
