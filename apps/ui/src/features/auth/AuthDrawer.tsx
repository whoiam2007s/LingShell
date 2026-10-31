import { useEffect, useState, useCallback } from 'react'
import { ShieldCheck, Trash2, ArrowUp, X } from 'lucide-react'
import { Select } from '../../components/ui/Select.js'
import { tr, tk, type AuthLevel, type TrustLevel, type HostSummary } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { cn } from '../../lib/cn.js'
import { AuditList } from './AuditList.js'
import { SudoLeaseList } from './SafetyBits.js'
import { useSession } from '../../lib/sessionContext.js'

const TRUST_LABEL: Record<TrustLevel, string> = { autonomous: tk('全自主'), confirm: tk('trust|确认'), readonly: tk('只读') }
const TRUST_ORDER: TrustLevel[] = ['autonomous', 'confirm', 'readonly']
const LEVEL_LABEL: Record<AuthLevel, string> = { none: tk('无'), read: tk('读取'), write: tk('写入') }

// hostKey → 友好名：'local'→「本地」；hostId→主机 label（user@host）；host:port 临时连接→原样
function hostKeyLabel(hostKey: string, hosts: HostSummary[]) {
  if (hostKey === 'local') return tr('本地')
  const h = hosts.find((x) => x.id === hostKey)
  return h ? tr('{label}（{user}@{host}）', { label: h.label, user: h.username, host: h.host }) : hostKey
}

// 会话授权抽屉：信任档选择器 + 已授权列表（本地/主机，可撤销/升级）+ 添加授权；另一个标签页是执行记录。
// 授权粒度是 hostKey（本地 + 每台主机），同主机所有终端共享一份授权。
// 仅在抽屉打开时挂载；sessionId 来自全局 SessionProvider。
export function AuthDrawer({ onClose }: { onClose: () => void }) {
  const { sessionId } = useSession()
  const [trust, setTrust] = useState<TrustLevel>('autonomous')
  const [list, setList] = useState<{ hostKey: string; level: AuthLevel }[]>([])
  const [hosts, setHosts] = useState<HostSummary[]>([])
  const [pick, setPick] = useState('')
  const [tab, setTab] = useState<'auth' | 'audit'>('auth')

  const refresh = useCallback(() => {
    if (!sessionId) return
    client.auth.getTrust(sessionId).then(setTrust).catch(() => {})
    client.auth.listForSession(sessionId).then(setList).catch(() => {})
    client.hosts.list().then(setHosts).catch(() => {})
  }, [sessionId])

  // 挂载即拉数据
  useEffect(() => { refresh() }, [refresh])
  // 授权状态变化（auth:resolved）时刷新
  useEffect(() => {
    const off = client.on((ev) => { if (ev.type === 'auth:resolved') refresh() })
    return off
  }, [refresh])

  const onTrustChange = (level: TrustLevel) => {
    setTrust(level)
    client.auth.setTrust(sessionId, level).catch(() => refresh())
  }
  const onRevoke = (hostKey: string) => {
    client.auth.revoke(sessionId, hostKey).then(refresh).catch(() => {})
  }
  const onGrant = (hostKey: string, level: 'read' | 'write') => {
    client.auth.grant(sessionId, hostKey, level).then(() => { setPick(''); refresh() }).catch(() => {})
  }

  // 添加授权候选：本地 + 每台已保存主机，过滤掉已授权的 hostKey
  const candidates: { value: string; label: string }[] = [
    { value: 'local', label: tr('本地') },
    ...hosts.map((h) => ({ value: h.id, label: tr('{label}（{user}@{host}）', { label: h.label, user: h.username, host: h.host }) })),
  ].filter((c) => !list.some((it) => it.hostKey === c.value))

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-3 pl-3.5">
        <div className="flex flex-1 items-center gap-1">
          {([['auth', tk('会话授权')], ['audit', tk('执行记录')]] as const).map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
              className={cn('rounded px-2 py-0.5 text-[12.5px] transition-colors',
                tab === k ? 'bg-[var(--color-bg-hover)] font-semibold text-[var(--color-text-primary)]' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]')}>
              {tr(label)}
            </button>
          ))}
        </div>
        <button onClick={onClose} title={tr('关闭')} className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]"><X className="h-4 w-4" /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {!sessionId ? (
          <div className="py-6 text-center text-[12px] text-[var(--color-text-muted)]">{tr('会话尚未就绪')}</div>
        ) : tab === 'audit' ? (
          <AuditList sessionId={sessionId} hosts={hosts} />
        ) : (
          <>
            {/* 信任档选择器 */}
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-medium text-[var(--color-text-secondary)]">{tr('会话信任档')}</span>
              <Select size="sm" className="w-24" value={trust} onValueChange={(v) => onTrustChange(v as TrustLevel)}
                options={TRUST_ORDER.map((t) => ({ value: t, label: tr(TRUST_LABEL[t]) }))} />
            </div>

            {/* 已授权列表（本地 + 主机） */}
            <div className="mt-4 space-y-1.5">
              <div className="text-[12px] font-medium text-[var(--color-text-secondary)]">{tr('已授权（本地/主机）')}</div>
              {list.length === 0 ? (
                <div className="rounded-md border border-dashed border-[var(--color-border-subtle)] px-2.5 py-2 text-[11px] text-[var(--color-text-muted)]">
                  {tr('暂无已授权')}
                </div>
              ) : (
                list.map((it) => (
                  <div
                    key={it.hostKey}
                    className="flex items-center gap-2 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-2.5 py-1.5"
                  >
                    <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-[var(--color-success)]" />
                    <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-text-secondary)]">{hostKeyLabel(it.hostKey, hosts)}</span>
                    <span className="shrink-0 rounded bg-[var(--color-bg-raised)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">
                      {tr(LEVEL_LABEL[it.level])}
                    </span>
                    {it.level === 'read' && (
                      <button
                        onClick={() => onGrant(it.hostKey, 'write')}
                        title={tr('升级为写入')}
                        className="flex h-5 shrink-0 items-center gap-0.5 rounded px-1 text-[10px] text-[var(--color-text-muted)] transition-colors hover:bg-[color:color-mix(in_srgb,var(--color-accent)_15%,transparent)] hover:text-[var(--color-accent)]"
                      >
                        <ArrowUp className="h-3 w-3" />{tr('升级为写')}
                      </button>
                    )}
                    <button
                      onClick={() => onRevoke(it.hostKey)}
                      title={tr('撤销授权')}
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--color-text-muted)] transition-colors hover:bg-[color:color-mix(in_srgb,var(--color-danger)_15%,transparent)] hover:text-[var(--color-danger)]"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                ))
              )}
            </div>

            {/* 限时提权（授权卡上选的「N 分钟内允许提权」）：剩余时间 + 立即收回 */}
            <SudoLeaseList sessionId={sessionId} hosts={hosts} />

            {/* 添加授权：把本地或某台主机授权给当前会话 */}
            <div className="mt-4 space-y-1.5">
              <div className="text-[12px] font-medium text-[var(--color-text-secondary)]">{tr('添加授权')}</div>
              <div className="flex items-center gap-1.5">
                <Select size="sm" className="flex-1" value={pick} onValueChange={setPick} placeholder={tr('选择本地或主机…')} options={candidates} />
                <button
                  disabled={!pick}
                  onClick={() => pick && onGrant(pick, 'read')}
                  className="h-7 shrink-0 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-2.5 text-[12px] text-[var(--color-text-secondary)] transition-colors hover:border-[color:color-mix(in_srgb,var(--color-accent)_60%,transparent)] hover:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {tr('授读')}
                </button>
                <button
                  disabled={!pick}
                  onClick={() => pick && onGrant(pick, 'write')}
                  className="h-7 shrink-0 rounded-md border border-transparent bg-[var(--color-accent)] px-2.5 text-[12px] font-medium text-[var(--color-bg-base)] transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {tr('授写')}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
