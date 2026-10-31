import { randomUUID } from 'node:crypto'
import {
  K8S_ACTION_TIMEOUT_MS, K8S_DECISION_RESTART, K8S_TIMEOUT_MS, isK8sContext, isK8sKind, isK8sName, isK8sResource, isK8sRestartKind, k8sDescribeCommand,
  k8sExecLine, k8sFollowLine, k8sHealth, k8sListCommand, k8sLogsCommand, k8sNamespacesCommand, k8sNodesCommand, k8sPortForwardLine, k8sPortForwardStream,
  k8sProbeCommand, k8sRestartCommand, k8sRestartLabel, k8sSupported, kubeErrorText, parseK8sList, parseK8sNamespaces, parseK8sProbe, parseKubeItems,
  parsePortForward, splitKube, toEvent, toNode, toPod,
  type K8sForward, type K8sFwdKind, type K8sHealth, type K8sNode, type K8sEvent, type TerminalInfo,
} from '@lingshell/shared'
import { tr, tk } from '@lingshell/shared'
import type { ExecStreamHandlers } from '@lingshell/terminal-core'

// Kubernetes 视图主进程侧（命令 / 解析 / 体检规则见 shared/k8s.ts）：SSH 终端走独立 exec channel，本地终端走本机子进程，都不碰交互 shell。
// 滚动重启记执行记录；进入容器 / 跟踪日志（本机）/ 端口转发（本机）新开终端标签跑；SSH 主机上的端口转发 = 远端后台 kubectl port-forward + 临时 SSH 本地转发
export type K8sExec = (cmd: string, timeoutMs: number) => Promise<string>
export interface K8sIpcDeps {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  terminal(id: string): TerminalInfo | undefined
  exec(id: string): K8sExec
  localExec: K8sExec
  open(terminalId: string, command: string, h: ExecStreamHandlers): () => void
  // 临时 SSH 本地转发（复用端口视图的「转发到本机」）
  tunnel(terminalId: string, remotePort: number): Promise<{ id: string; localPort: number }>
  untunnel(terminalId: string, id: string): void
  audit(terminalId: string, entry: { command: string; decision: string; exitCode?: number }): void
  openTerminal(terminalId: string, line: string): Promise<void>
  fwdTimeoutMs?: number
}

interface Fwd { info: K8sForward; terminalId: string; stop: () => void; tunnelId?: string }

export function registerK8s(d: K8sIpcDeps): { stopAll(): void } {
  const fwds = new Map<string, Fwd>()
  const target = (id: unknown) => {
    const t = typeof id === 'string' ? d.terminal(id) : undefined
    if (!t) throw new Error('terminal_not_found')
    if (!k8sSupported(t.type, t.os)) throw new Error(tr('Kubernetes 视图只支持本地终端和 Linux / macOS 的 SSH 终端'))
    return { t, exec: t.type === 'local' ? d.localExec : d.exec(t.id) }
  }
  const ctxOf = (v: unknown): string | undefined => {
    if (v === undefined || v === null || v === '') return undefined
    if (!isK8sContext(v)) throw new Error(tr('非法的上下文名'))
    return v
  }
  const nsOf = (v: unknown, all = false): string => {
    if (v === '' && all) return ''
    if (!isK8sName(v)) throw new Error(tr('非法的命名空间'))
    return v
  }
  // msg 是 tk() 标过的完整报错，抛出时再翻译
  const nameOf = (v: unknown, msg: string = tk('非法的名称')) => { if (!isK8sName(v)) throw new Error(tr(msg)); return v }
  // 文本类结果（describe / YAML / 日志）：失败把 kubectl 的 stderr 白话化
  const text = async (exec: K8sExec, cmd: string, ms = K8S_TIMEOUT_MS) => {
    const r = splitKube(await exec(cmd, ms))
    if (r.rc !== 0) throw new Error(kubeErrorText(r.err || r.out, r.rc))
    return r.out.trimEnd()
  }

  d.handle('k8s:probe', async (_e, id) => {
    const x = target(id)
    return parseK8sProbe(await x.exec(k8sProbeCommand(), 15_000))
  })
  d.handle('k8s:namespaces', async (_e, id, ctx) => parseK8sNamespaces(await target(id).exec(k8sNamespacesCommand(ctxOf(ctx)), K8S_TIMEOUT_MS)))
  d.handle('k8s:list', async (_e, id, ctx, ns, res) => {
    if (!isK8sResource(res)) throw new Error(tr('非法的资源类型'))
    return parseK8sList(res, await target(id).exec(k8sListCommand(ctxOf(ctx), nsOf(ns, true), res), K8S_TIMEOUT_MS))
  })
  d.handle('k8s:text', (_e, id, ctx, ns, kind, name, what) => {
    if (!isK8sKind(kind)) throw new Error(tr('非法的资源类型'))
    return text(target(id).exec, k8sDescribeCommand(ctxOf(ctx), nsOf(ns), kind, nameOf(name), what === 'yaml'))
  })
  d.handle('k8s:logs', (_e, id, ctx, ns, pod, opts) => {
    const o = (opts && typeof opts === 'object' ? opts : {}) as { container?: unknown; previous?: unknown; tail?: unknown }
    const container = o.container ? nameOf(o.container, tk('非法的容器名')) : undefined
    return text(target(id).exec, k8sLogsCommand(ctxOf(ctx), nsOf(ns), nameOf(pod, tk('非法的 Pod 名')), { container, previous: o.previous === true, tail: typeof o.tail === 'number' ? o.tail : undefined }))
  })
  // 写操作：成败都记一笔（超时 / 断线无退出码）
  d.handle('k8s:restart', async (_e, id, ctx, ns, kind, name) => {
    const x = target(id), c = ctxOf(ctx), n = nsOf(ns), nm = nameOf(name)
    if (!isK8sRestartKind(kind)) throw new Error(tr('非法的资源类型'))
    let r: ReturnType<typeof splitKube>
    try { r = splitKube(await x.exec(k8sRestartCommand(c, n, kind, nm), K8S_ACTION_TIMEOUT_MS)) }
    catch (e) { r = { out: '', err: e instanceof Error ? e.message : String(e) } }
    d.audit(x.t.id, { command: k8sRestartLabel(c, n, kind, nm), decision: K8S_DECISION_RESTART, exitCode: r.rc })
    if (r.rc !== 0) throw new Error(kubeErrorText(r.err || r.out, r.rc))
    return r.out.trim()
  })

  // 集群体检：Pod / 事件先看全部命名空间，没权限退回当前命名空间；节点没权限就跳过（写进说明）
  d.handle('k8s:health', async (_e, id, ctx, ns): Promise<K8sHealth> => {
    const x = target(id), c = ctxOf(ctx), cur = ns === '' ? '' : nsOf(ns)
    const notes: string[] = []
    let scope = tr('全部命名空间')
    const get = async <T>(res: 'pods' | 'events', map: (j: Record<string, unknown>) => T): Promise<T[]> => {
      try { return parseKubeItems(await x.exec(k8sListCommand(c, '', res), K8S_TIMEOUT_MS)).map(map) }
      catch (e) {
        // kubeErrorText 的提示已按界面语言翻译：中英文都认
        const m = e instanceof Error ? e.message : ''
        if (!cur || !(m.includes('没有权限') || m.includes(tr('没有权限（RBAC 不允许当前用户做这个操作）。')))) throw e   // i18n-ignore 匹配中文提示
        scope = tr('命名空间 {ns}（没有列出全部命名空间的权限）', { ns: cur })
        return parseKubeItems(await x.exec(k8sListCommand(c, cur, res), K8S_TIMEOUT_MS)).map(map)
      }
    }
    const [pods, nodes, events] = await Promise.all([
      get('pods', toPod),
      x.exec(k8sNodesCommand(c), K8S_TIMEOUT_MS).then((o) => parseKubeItems(o).map(toNode)).catch((e): K8sNode[] | undefined => { notes.push(tr('节点：{err}', { err: String(e instanceof Error ? e.message : e).split('\n')[0] })); return undefined }),
      get('events', toEvent).catch((e): K8sEvent[] => { notes.push(tr('事件：{err}', { err: String(e instanceof Error ? e.message : e).split('\n')[0] })); return [] }),
    ])
    return k8sHealth({ pods, nodes, events, now: Date.now(), scope, notes })
  })

  // 新开终端标签（同主机 / 本机）跑交互命令
  d.handle('k8s:openTerminal', async (_e, id, ctx, ns, what, p) => {
    const x = target(id), c = ctxOf(ctx), n = nsOf(ns)
    const o = (p && typeof p === 'object' ? p : {}) as { kind?: unknown; name?: unknown; container?: unknown; port?: unknown }
    const container = o.container ? nameOf(o.container, tk('非法的容器名')) : undefined
    const line = what === 'exec' ? k8sExecLine(c, n, nameOf(o.name, tk('非法的 Pod 名')), container)
      : what === 'logs' ? k8sFollowLine(c, n, nameOf(o.name, tk('非法的 Pod 名')), container)
        : what === 'portForward' ? k8sPortForwardLine(c, n, o.kind === 'service' ? 'service' : 'pod', nameOf(o.name), o.port as number)
          : ''
    if (!line) throw new Error(tr('非法的操作'))
    await d.openTerminal(x.t.id, line)
  })

  // SSH 主机：远端后台 port-forward（随机端口，只听 127.0.0.1）→ 读到 Forwarding from 行 → 临时 SSH 本地转发接到本机
  d.handle('k8s:forward', async (_e, id, ctx, ns, kind, name, port): Promise<K8sForward> => {
    const x = target(id)
    if (x.t.type !== 'ssh') throw new Error(tr('本地终端的端口转发请用新终端标签（kubectl port-forward）'))
    const c = ctxOf(ctx), n = nsOf(ns), k: K8sFwdKind = kind === 'service' ? 'service' : 'pod', nm = nameOf(name)
    const cmd = k8sPortForwardStream(c, n, k, nm, port as number)   // 端口在这里校验
    const fid = randomUUID()
    let out = ''
    const f: Fwd = { terminalId: x.t.id, stop: () => {}, info: { id: fid, namespace: n, target: `${k === 'pod' ? 'pod' : 'svc'}/${nm}`, port: port as number, remotePort: 0, localPort: 0 } }
    const remotePort = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => { f.stop(); reject(new Error(tr('kubectl port-forward 没有就绪：{out}', { out: out.trim().slice(0, 500) || tr('（无输出）') }))) }, d.fwdTimeoutMs ?? 20_000)
      let started = false
      f.stop = d.open(x.t.id, cmd, {
        data: (b) => {
          if (out.length < 8000) out += b.toString('utf8')
          const p = started ? undefined : parsePortForward(out)
          if (p) { started = true; clearTimeout(timer); resolve(p) }
        },
        end: (err) => {
          clearTimeout(timer)
          const raw = out.replace(/Forwarding from .*\n?/g, '').trim() || err || ''
          const why = raw ? kubeErrorText(raw).split('\n') : [tr('kubectl port-forward 没有输出就退出了')]
          if (!started) { reject(new Error(why.join('\n'))); return }
          // 运行中退出（Pod 被删 / 断线）：标记结束、拆掉本机转发
          f.info.ended = why[0] || tr('已结束')
          if (f.tunnelId) { d.untunnel(f.terminalId, f.tunnelId); f.tunnelId = undefined }
        },
      })
    })
    try {
      const tun = await d.tunnel(x.t.id, remotePort)
      f.tunnelId = tun.id
      f.info.remotePort = remotePort; f.info.localPort = tun.localPort
    } catch (e) { f.stop(); throw e }
    fwds.set(fid, f)
    return f.info
  })
  d.handle('k8s:forwards', (_e, id) => [...fwds.values()].filter((f) => f.terminalId === id).map((f) => f.info))
  const stopOne = (f: Fwd) => {
    fwds.delete(f.info.id)
    f.stop()
    if (f.tunnelId) d.untunnel(f.terminalId, f.tunnelId)
  }
  d.handle('k8s:stopForward', (_e, id, fid) => {
    const f = typeof fid === 'string' ? fwds.get(fid) : undefined
    if (f && f.terminalId === id) stopOne(f)
  })
  return { stopAll: () => { for (const f of [...fwds.values()]) stopOne(f) } }
}
