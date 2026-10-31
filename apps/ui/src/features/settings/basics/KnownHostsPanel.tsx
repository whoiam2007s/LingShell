import { useEffect, useState, useCallback } from 'react'
import { Fingerprint, Trash2, Download } from 'lucide-react'
import { tr, type HostSummary, type KnownHost } from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { ConfirmDialog } from '../../common/index.js'
import { FoldSection, type Fold } from '../../../components/sshParts.js'
import { BTN2 } from '../ui.js'

// 已信任的 SSH 主机指纹（主机与连接页）：查看 / 删除（删后下次连接重新确认）/ 从 ~/.ssh/known_hosts 导入
export function KnownHostsPanel({ hosts, fold }: { hosts: HostSummary[]; fold: Fold }) {
  const [list, setList] = useState<KnownHost[]>([])
  const [delTarget, setDelTarget] = useState<KnownHost | null>(null)
  const [msg, setMsg] = useState('')
  const refresh = useCallback(() => { client.knownHosts.list().then(setList).catch(() => {}) }, [])
  useEffect(() => {
    refresh()
    return client.on((ev) => { if (ev.type === 'hostKey:resolved') refresh() })   // 刚信任了新主机
  }, [refresh])

  // hostPort → 已存主机名（可能多台同地址，取全部）
  const labels = (hp: string) => hosts.filter((h) => `${h.host.trim().toLowerCase()}:${h.port}` === hp).map((h) => h.label).join(tr('、'))
  const doImport = () => {
    setMsg('')
    client.knownHosts.importOpenSsh()
      .then((n) => { setMsg(n ? tr('已导入 {n} 条', { n }) : tr('没有可导入的新条目（哈希条目无法导入）')); refresh() })
      .catch((e) => setMsg(String(e instanceof Error ? e.message : e).replace(/^.*Error: /, '')))
  }
  const doDelete = () => {
    if (delTarget) client.knownHosts.remove(delTarget.hostPort).then(refresh).catch(() => {})
    setDelTarget(null)
  }

  return (
    <FoldSection title={tr('已信任的主机指纹')} {...fold}
      tip={tr('首次连接主机时确认指纹后记录在这里。删除后下次连接会重新要求确认指纹。可从 ~/.ssh/known_hosts 导入明文条目（哈希条目无法导入）')}
      actions={<button onClick={doImport} title={tr('导入 ~/.ssh/known_hosts 中的明文条目')} className={`flex items-center gap-1 ${BTN2}`}><Download className="h-3.5 w-3.5" />{tr('从 ~/.ssh/known_hosts 导入')}</button>}>
    <div className="space-y-1 px-3.5 py-3">
      {msg && <div className="text-[11px] text-[var(--color-text-muted)]">{msg}</div>}
      {list.length === 0 ? (
        <div className="py-3 text-center text-[12px] text-[var(--color-text-muted)]">{tr('暂无，首次连接确认指纹后会记录在这里')}</div>
      ) : (
        <div className="space-y-1">
          {list.map((k) => (
            <div key={k.hostPort} className="flex items-center gap-2 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] px-3 py-1.5 text-[11.5px]">
              <Fingerprint className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
              <span className="shrink-0 font-medium text-[var(--color-text-primary)]">{labels(k.hostPort) || k.hostPort}</span>
              <span title={`${k.hostPort}  ${k.keyType}  ${k.fingerprint}\n${tr('记录于 {time}', { time: k.firstSeen })}`} className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--color-text-muted)]">{labels(k.hostPort) ? `${k.hostPort} · ` : ''}{k.keyType} {k.fingerprint}</span>
              <button onClick={() => setDelTarget(k)} title={tr('删除指纹')} className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[color:color-mix(in_srgb,var(--color-danger)_15%,transparent)] hover:text-[var(--color-danger)]"><Trash2 className="h-3 w-3" /></button>
            </div>
          ))}
        </div>
      )}
      <ConfirmDialog open={!!delTarget} title={tr('删除指纹')} confirmText={tr('删除指纹')}
        message={tr('删除 {host} 的指纹记录？下次连接时会重新要求确认指纹。', { host: delTarget?.hostPort ?? '' })}
        onConfirm={doDelete} onCancel={() => setDelTarget(null)} />
    </div>
    </FoldSection>
  )
}
