import { useEffect, useRef, useState } from 'react'
import { Boxes, CalendarClock, Database, HardDrive, LayoutGrid, Network, ShieldCheck } from 'lucide-react'
import { diskSupported, k8sSupported, portsSupported, tk, tr, type TerminalInfo } from '@lingshell/shared'
import { ActBtn } from '../../components/ActivityBar.js'
import { client } from '../../client/index.js'

// 「更多视图」里的低频运维视图；ok = 当前终端能不能用（本地终端：磁盘占用 / Kubernetes / 数据库）
export type OpsView = 'disk' | 'cron' | 'firewall' | 'topology' | 'k8s' | 'database'
export const OPS_VIEWS: { id: OpsView; label: string; desc: string; icon: typeof CalendarClock; ok: (t: TerminalInfo) => boolean }[] = [
  { id: 'disk', label: tk('磁盘占用'), desc: tk('逐层看谁占了空间、大文件、已删除仍被占用（只读）'), icon: HardDrive, ok: (t) => diskSupported(t.type, t.os) },
  { id: 'cron', label: tk('定时任务'), desc: tk('crontab 与 systemd timer，翻成人话，可用 AI 新建'), icon: CalendarClock, ok: (t) => portsSupported(t.type, t.os) },
  { id: 'firewall', label: tk('防火墙'), desc: tk('firewalld / ufw / nftables / iptables 规则可读化（只读）'), icon: ShieldCheck, ok: (t) => portsSupported(t.type, t.os) },
  { id: 'topology', label: tk('服务拓扑'), desc: tk('进程 / 容器之间谁连谁（按 ss 与 docker 网络推导）'), icon: Network, ok: (t) => portsSupported(t.type, t.os) },
  { id: 'k8s', label: 'Kubernetes', desc: tk('Pod / Deployment / Service / 事件，日志、进入容器、转发、滚动重启、集群体检'), icon: Boxes, ok: (t) => k8sSupported(t.type, t.os) },
  { id: 'database', label: tk('数据库'), desc: tk('MySQL / PostgreSQL / Redis / MongoDB：会话、慢查询、只读查询、表结构、Redis Key'), icon: Database, ok: (t) => t.type === 'local' || portsSupported(t.type, t.os) },
]
export const isOpsView = (v: unknown): v is OpsView => OPS_VIEWS.some((x) => x.id === v)
/** 当前终端能用的视图（一个都没有就不显示按钮） */
export const opsViewsFor = (t?: TerminalInfo) => (t ? OPS_VIEWS.filter((v) => v.ok(t)) : [])

// 每个终端探测一次 kubectl（菜单里提示「未检测到」；点进去仍可看安装说明）。状态在 lib，K8s 抽屉也会写
import { kubectlFound, noteKubectl } from '../../lib/kubectlSeen.js'
export { noteKubectl }

// 右侧活动栏「更多视图」：一个按钮收纳低频运维视图，点开小菜单再选；对应抽屉开着时按钮高亮。点外面 / Esc 收起
export function MoreViewsButton({ term, active, onPick }: { term?: TerminalInfo; active?: OpsView | null; onPick: (v: OpsView) => void }) {
  const [open, setOpen] = useState(false)
  const [, bump] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const list = opsViewsFor(term)
  const termId = term?.id
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey, true) }
  }, [open])
  useEffect(() => {
    if (!open || !termId || kubectlFound(termId) !== undefined || !list.some((v) => v.id === 'k8s')) return
    client.k8s.probe(termId).then((p) => { noteKubectl(termId, p.kubectl); bump((n) => n + 1) }).catch(() => {})
  }, [open, termId])
  const noKubectl = !!termId && kubectlFound(termId) === false
  return (
    <div ref={ref} className="relative" data-more-views>
      <ActBtn title={tr('更多视图：{list}', { list: list.map((v) => tr(v.label)).join(' / ') })} active={open || !!active} onClick={() => setOpen((o) => !o)}><LayoutGrid className="h-4 w-4" /></ActBtn>
      {open && (
        <div className="absolute right-full top-0 z-30 mr-1.5 w-64 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-1 text-[12px] shadow-lg">
          {list.map((v) => (
            <button key={v.id} data-view={v.id} onClick={() => { setOpen(false); onPick(v.id) }}
              className={`flex w-full items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-[var(--color-bg-hover)] ${active === v.id ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-primary)]'}`}>
              <v.icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
              <span className="min-w-0">
                <span className="block font-medium">{tr(v.label)}{v.id === 'k8s' && noKubectl && <span className="ml-1.5 text-[10.5px] font-normal text-[var(--color-warn)]">{tr('未检测到 kubectl')}</span>}</span>
                <span className="block text-[10.5px] leading-snug text-[var(--color-text-muted)]">{v.id === 'k8s' && noKubectl ? tr('点开看怎么安装 kubectl / 配 kubeconfig') : tr(v.desc)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
