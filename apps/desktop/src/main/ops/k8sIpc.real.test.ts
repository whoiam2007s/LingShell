import { it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
import type { ExecStreamHandlers } from '@lingshell/terminal-core'
import type { K8sForward, K8sHealth, K8sList, K8sProbe, TerminalInfo } from '@lingshell/shared'
import { registerK8s } from './k8sIpc.js'
import { runSh } from '../terminal/index.js'
import { LOCAL_SHELL } from '../terminal/index.js'

// Kubernetes 视图：本机子进程跑一个假 kubectl（按参数回固定 JSON，stderr 夹警告行），核对解析 / 体检退回 / 滚动重启记录 / 新终端命令；
// SSH 端口转发用假的 exec 流（不连任何主机）核对：读到 Forwarding 行 → 接本机转发 → 停止时关流 + 拆转发
let dir = ''
const now = Date.now()
const ago = (m: number) => new Date(now - m * 60_000).toISOString()
const FAKE = `#!/bin/bash
D="$(dirname "$0")"; echo "$*" >> "$D/calls.log"
case "$*" in
  *"config current-context"*) echo dev ;;
  *"config view"*) printf 'dev\\tshop\\nprod\\t\\n' ;;
  *version*) echo "Client Version: v1.30.2" ;;
  *"get pods"*) echo "Warning: deprecated thing" >&2; cat "$D/pods.json" ;;
  *"get events"*) cat "$D/events.json" ;;
  *"get nodes"*) echo 'Error from server (Forbidden): nodes is forbidden: User "dev" cannot list resource "nodes"' >&2; exit 1 ;;
  *"rollout restart"*) echo "deployment.apps/web restarted" ;;
  *describe*) echo "Name: web" ;;
  *) echo "unsupported: $*" >&2; exit 1 ;;
esac
`
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'k8s-'))
  writeFileSync(join(dir, 'kubectl'), FAKE.replace(/\r/g, ''))
  chmodSync(join(dir, 'kubectl'), 0o755)
  writeFileSync(join(dir, 'pods.json'), JSON.stringify({ items: [
    { metadata: { name: 'web-1', namespace: 'shop', creationTimestamp: ago(60) }, spec: { containers: [{ name: 'web' }] }, status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: [{ name: 'web', ready: true, restartCount: 0, state: { running: {} } }] } },
    { metadata: { name: 'api-1', namespace: 'shop', creationTimestamp: ago(60) }, spec: { containers: [{ name: 'api' }] }, status: { phase: 'Running', containerStatuses: [{ name: 'api', ready: false, restartCount: 9, state: { waiting: { reason: 'CrashLoopBackOff' } }, lastState: { terminated: { reason: 'OOMKilled', exitCode: 137 } } }] } },
  ] }))
  writeFileSync(join(dir, 'events.json'), JSON.stringify({ items: [
    { metadata: { namespace: 'shop' }, type: 'Warning', reason: 'BackOff', involvedObject: { kind: 'Pod', name: 'api-1' }, message: 'Back-off restarting', count: 3, lastTimestamp: ago(1) },
  ] }))
})
afterAll(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ } })

const shell = { file: LOCAL_SHELL.file, env: () => ({ ...LOCAL_SHELL.env(), PATH: `${dir}${delimiter}${process.env.PATH ?? ''}` }) }
const terms: Record<string, TerminalInfo> = {
  loc: { id: 'loc', type: 'local', title: '本地终端' } as TerminalInfo,
  ssh: { id: 'ssh', type: 'ssh', os: 'linux', title: 'k8s-master' } as TerminalInfo,
}
const hs = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
const call = <T>(ch: string, ...a: unknown[]) => Promise.resolve().then(() => hs.get(ch)!({}, ...a)) as Promise<T>
const audits: { command: string; decision: string; exitCode?: number }[] = []
const lines: string[] = []
const tunnels: { op: string; id: string; port?: number }[] = []
let stream: { cmd: string; h: ExecStreamHandlers; closed: boolean } | undefined
registerK8s({
  handle: (ch, fn) => { hs.set(ch, fn) },
  terminal: (id) => terms[id],
  exec: () => () => { throw new Error('不该走 SSH exec') },
  localExec: (cmd, ms) => runSh(cmd, { timeoutMs: ms }, shell).then((r) => r.output),
  open: (_id, cmd, h) => { const s = { cmd, h, closed: false }; stream = s; return () => { s.closed = true } },
  tunnel: async (id, port) => { tunnels.push({ op: 'start', id, port }); return { id: 'fw1', localPort: 18080 } },
  untunnel: (_t, id) => { tunnels.push({ op: 'stop', id }) },
  audit: (_t, e) => { audits.push(e) },
  openTerminal: async (_t, line) => { lines.push(line) },
  fwdTimeoutMs: 2000,
})

it('探测 + 列 Pod：stderr 警告不污染 JSON，异常置顶；上下文 / 命名空间进命令', async () => {
  const p = await call<K8sProbe>('k8s:probe', 'loc')
  expect(p).toMatchObject({ kubectl: true, current: 'dev', contexts: [{ name: 'dev', namespace: 'shop' }, { name: 'prod' }] })
  const l = await call<K8sList>('k8s:list', 'loc', 'dev', 'shop', 'pods')
  expect(l.pods?.map((x) => `${x.name} ${x.status} ${x.restarts}`)).toEqual(['api-1 CrashLoopBackOff 9', 'web-1 Running 0'])
  expect(readFileSync(join(dir, 'calls.log'), 'utf8')).toContain('--context dev get pods -n shop -o json')
  await expect(call('k8s:list', 'loc', 'dev', 'shop', 'secrets')).rejects.toThrow('非法的资源类型')
  // kubeconfig 允许带引号的 context：命令里会单引号转义，能正常执行
  expect((await call<K8sList>('k8s:list', 'loc', "x'y", 'shop', 'pods')).pods?.length).toBe(2)
  await expect(call('k8s:list', 'loc', 'x\ny', 'shop', 'pods')).rejects.toThrow('非法的上下文名')
}, 30_000)

it('体检：节点没权限写进说明，其余照常出结果', async () => {
  const h = await call<K8sHealth>('k8s:health', 'loc', undefined, 'shop')
  expect(h.scope).toBe('全部命名空间')
  expect(h.nodes).toBeUndefined()
  expect(h.notes[0]).toMatch(/^节点：没有权限/)
  expect(h.findings.map((f) => f.title)).toEqual(['shop/api-1 CrashLoopBackOff', 'BackOff · shop/Pod/api-1（3 次）'])
}, 30_000)

it('describe / 滚动重启（记执行记录）/ 新终端里的 exec 命令', async () => {
  expect(await call<string>('k8s:text', 'loc', undefined, 'shop', 'pod', 'web-1', 'describe')).toBe('Name: web')
  expect(await call<string>('k8s:restart', 'loc', 'dev', 'shop', 'deployment', 'web')).toBe('deployment.apps/web restarted')
  expect(audits).toEqual([{ command: 'kubectl --context dev rollout restart deployment/web -n shop', decision: 'k8s_restart', exitCode: 0 }])
  await expect(call('k8s:restart', 'loc', 'dev', 'shop', 'daemonset', 'web')).rejects.toThrow('非法的资源类型')
  await expect(call('k8s:text', 'loc', undefined, 'shop', 'pod', 'nope', 'yaml')).rejects.toThrow(/unsupported/)
  await call('k8s:openTerminal', 'loc', 'dev', 'shop', 'exec', { name: 'api-1', container: 'api' })
  await call('k8s:openTerminal', 'loc', undefined, 'shop', 'portForward', { kind: 'service', name: 'web', port: 80 })
  expect(lines).toEqual([
    "kubectl --context 'dev' exec -it 'api-1' -n 'shop' -c 'api' -- sh -c 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'",
    "kubectl port-forward svc/'web' -n 'shop' 80:80",
  ])
  await expect(call('k8s:forward', 'loc', undefined, 'shop', 'pod', 'web-1', 8080)).rejects.toThrow('本地终端')
}, 30_000)

it('SSH 端口转发：Forwarding 行 → 接本机转发；停止时关流 + 拆转发；没就绪就退出则报错', async () => {
  const p = call<K8sForward>('k8s:forward', 'ssh', 'dev', 'shop', 'pod', 'web-1', 8080)
  await new Promise((r) => setTimeout(r, 10))
  expect(stream!.cmd).toContain(':8080 --address 127.0.0.1')
  stream!.h.data(Buffer.from('Forwarding from 127.0.0.1:41000 -> 8080\nForwarding from [::1]:41000 -> 8080\n'))
  const f = await p
  expect(f).toMatchObject({ target: 'pod/web-1', port: 8080, remotePort: 41000, localPort: 18080 })
  expect(tunnels).toEqual([{ op: 'start', id: 'ssh', port: 41000 }])
  expect(await call<K8sForward[]>('k8s:forwards', 'ssh')).toHaveLength(1)
  const s1 = stream!
  await call('k8s:stopForward', 'ssh', f.id)
  expect(s1.closed).toBe(true)
  expect(tunnels.at(-1)).toEqual({ op: 'stop', id: 'fw1' })
  expect(await call<K8sForward[]>('k8s:forwards', 'ssh')).toEqual([])

  const q = call('k8s:forward', 'ssh', undefined, 'shop', 'pod', 'gone', 80)
  await new Promise((r) => setTimeout(r, 10))
  stream!.h.data(Buffer.from('Error from server (NotFound): pods "gone" not found\n'))
  stream!.h.end()
  await expect(q).rejects.toThrow(/对象不存在/)
  await expect(call('k8s:forward', 'ssh', undefined, 'shop', 'pod', 'x', 0)).rejects.toThrow('非法的端口')
})
