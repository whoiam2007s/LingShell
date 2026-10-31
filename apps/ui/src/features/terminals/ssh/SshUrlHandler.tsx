import { useEffect, useState } from 'react'
import { matchSshUrlHost, tr, type HostSummary, type SshUrlTarget } from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { ConfirmDialog } from '../../common/index.js'
import { paletteSend } from '../../../lib/paletteBus.js'
import { setSshConnectPrefill } from './SshConnectDialog.js'

// ssh:// 链接唤起（主进程见 desktop/main/app/sshUrl.ts）：匹配已存主机 → 确认后连接；不匹配 → 打开「新建连接」并预填（不自动连、不带密码）
export function SshUrlHandler() {
  const [ask, setAsk] = useState<HostSummary | null>(null)
  useEffect(() => {
    const handle = async (t: SshUrlTarget) => {
      const hosts = await client.hosts.list().catch(() => [] as HostSummary[])
      const h = matchSshUrlHost(hosts, t)
      if (h) { setAsk(h); return }
      setSshConnectPrefill({ host: t.host, port: t.port, username: t.user ?? '', label: `${t.user ? `${t.user}@` : ''}${t.host}`, saveAs: false })
      paletteSend({ type: 'newSsh' })
    }
    // 冷启动带的链接：挂载时取；启动即锁定（应用锁）时取不到，解锁后再取
    const take = () => client.sshUrl.takePending().then((t) => { if (t) void handle(t) }).catch(() => {})
    void take()
    return client.on((ev) => {
      if (ev.type === 'sshUrl:open') void handle(ev.target)
      else if (ev.type === 'app:lock' && !ev.locked) void take()
    })
  }, [])
  return (
    <ConfirmDialog open={!!ask} title={tr('打开 SSH 链接')} confirmText={tr('action|连接')}
      message={ask ? tr('打开到 {label}（{target}）的连接？{prod}链接来自外部程序（浏览器等），不认识就取消。',
        { label: ask.label, target: `${ask.username}@${ask.host}:${ask.port}`, prod: ask.env === 'prod' ? tr('这是生产主机。') : '' }) : ''}
      onConfirm={() => { if (ask) paletteSend({ type: 'connectHost', hostId: ask.id }); setAsk(null) }}
      onCancel={() => setAsk(null)} />
  )
}
