// 连通性探测（只读，不记执行记录）：一个源一次调用。
//  - 本机：Node 的 dns.lookup / net.connect / fetch（不依赖本机有没有 curl）
//  - 远端：runBatchHost 跑 probeScript（同批量执行的通道：在线终端复用连接，否则临时连、跑完即断），解析见 shared/terminal/connProbe.ts
import { lookup } from 'node:dns/promises'
import { connect } from 'node:net'
import {
  PROBE_HTTP_TIMEOUT_SEC, PROBE_RUN_TIMEOUT_MS, PROBE_TCP_TIMEOUT_SEC, nodeErrReason, parseProbeOutput, plannedChecks, probeScript, sanitizeProbeChecks, sanitizeProbeTargets,
  type CompareTarget, type ProbeCell, type ProbeCheck, type ProbeItem, type ProbeSourceResult, type ProbeTarget,
} from '@lingshell/shared'
import { tr } from '@lingshell/shared'
import { BatchRuns, runBatchHost, type Runner } from './batchExec.js'

type NodeErr = { code?: string; message?: string; cause?: { code?: string; message?: string } }
const reason = (e: unknown) => { const x = e as NodeErr; return nodeErrReason(x?.cause?.code ?? x?.code, x?.cause?.message ?? x?.message) }
const since = (t0: number) => Date.now() - t0

async function localDns(host: string): Promise<Omit<ProbeItem, 'check'>> {
  const t0 = Date.now()
  try {
    const r = await Promise.race([lookup(host, { all: true }), new Promise<never>((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), 5000))])
    const ips = [...new Set(r.map((x) => x.address))]
    return { status: 'ok', ms: since(t0), detail: ips.slice(0, 4).join(', ') + (ips.length > 4 ? tr(' 等 {n} 个', { n: ips.length }) : ''), tool: 'node' }
  } catch (e) { return { status: 'fail', ms: since(t0), detail: reason(e), tool: 'node', raw: (e as Error).message } }
}

function localTcp(host: string, port: number, signal: AbortSignal): Promise<Omit<ProbeItem, 'check'>> {
  const t0 = Date.now()
  return new Promise((resolve) => {
    const s = connect({ host, port })
    const done = (r: Omit<ProbeItem, 'check'>) => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); s.destroy(); resolve({ ...r, ms: since(t0), tool: 'node' }) }
    const timer = setTimeout(() => done({ status: 'fail', detail: tr('超时') }), PROBE_TCP_TIMEOUT_SEC * 1000)
    const onAbort = () => done({ status: 'fail', detail: tr('已取消') })
    signal.addEventListener('abort', onAbort)
    s.once('connect', () => done({ status: 'ok', detail: tr('端口可连') }))
    s.once('error', (e) => done({ status: 'fail', detail: reason(e), raw: e.message }))
  })
}

async function localHttp(url: string, signal: AbortSignal): Promise<Omit<ProbeItem, 'check'>> {
  const t0 = Date.now()
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(PROBE_HTTP_TIMEOUT_SEC * 1000)]) })
    const ms = since(t0)
    void res.body?.cancel().catch(() => {})
    const c = res.status
    return { status: c >= 200 && c < 400 ? 'ok' : 'warn', ms, detail: `HTTP ${c}`, tool: 'node', raw: `HTTP ${c} ${res.statusText}` }
  } catch (e) { return { status: 'fail', ms: since(t0), detail: reason(e), tool: 'node', raw: String((e as NodeErr)?.cause?.message ?? (e as Error).message) } }
}

/** 本机探测：各目标并行 */
export async function probeLocal(targets: ProbeTarget[], checks: ProbeCheck[], signal: AbortSignal): Promise<ProbeCell[]> {
  return Promise.all(targets.map(async (t) => ({
    items: await Promise.all(plannedChecks(t, checks).map(async ({ check, skip }): Promise<ProbeItem> => {
      if (skip) return { check, status: 'skip', detail: skip }
      const r = check === 'dns' ? await localDns(t.host) : check === 'tcp' ? await localTcp(t.host, t.port!, signal) : await localHttp(t.url!, signal)
      return { check, ...r }
    })),
  })))
}

/** 远端探测：跑脚本并解析；连不上 → error */
export async function probeRemote(open: () => Promise<Runner>, targets: ProbeTarget[], checks: ProbeCheck[], signal: AbortSignal): Promise<ProbeSourceResult> {
  const r = await runBatchHost(open, probeScript(targets, checks), PROBE_RUN_TIMEOUT_MS, signal, undefined, 30_000)
  if (r.status === 'conn_error') return { cells: [], error: r.error ?? tr('连接失败') }
  if (r.status === 'canceled' && !r.output) return { cells: [], error: tr('已取消') }
  return { cells: parseProbeOutput(r.output ?? '', targets, checks), raw: r.output, ...(r.status === 'timeout' ? { error: tr('探测超时，部分结果') } : {}) }
}

export interface ConnProbeDeps {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  runner(t: CompareTarget): () => Promise<Runner>
  log?(level: 'info' | 'warn', message: string, data?: unknown): void
}

export function registerConnProbe(d: ConnProbeDeps) {
  const runs = new BatchRuns()
  d.handle('probe:run', async (_e, runId, source, targets, checks): Promise<ProbeSourceResult> => {
    const ts = sanitizeProbeTargets(targets), cs = sanitizeProbeChecks(checks)
    const s = source as CompareTarget
    const signal = runs.signal(String(runId))
    d.log?.('info', '连通性探测', { source: s?.kind, targets: ts.length, checks: cs })   // i18n-ignore 日志
    if (s?.kind === 'local') return { cells: await probeLocal(ts, cs, signal) }
    if ((s?.kind === 'host' && typeof s.hostId === 'string') || (s?.kind === 'terminal' && typeof s.terminalId === 'string')) return probeRemote(d.runner(s), ts, cs, signal)
    throw new Error(tr('非法的源'))
  })
  d.handle('probe:cancel', (_e, runId) => { runs.cancel(String(runId)) })
}
