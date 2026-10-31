import { useEffect, useRef, useState } from 'react'
import { client } from '../../../client/index.js'
import { ProxyFields, emptyProxy, proxyDraftOf, proxyInputOf, type ProxyDraft } from '../../../components/sshParts.js'
import { Switch } from '../../../components/ui/Switch.js'
import { Page, Row, Section } from '../ui.js'
import { DELAY_QUICK, DELAY_TEXT, proxyError } from '../autoSave.js'
import { useAutoSave } from '../useAutoSave.js'
import { tr } from '@lingshell/shared'
import { trx } from '../../../lib/trx.js'

// 设置 → 网络代理：全局默认出站代理（HTTP CONNECT / SOCKS5）。所有 SSH 连接默认经它；
// 主机可在 主机与连接 → 编辑 → 高级 →「出站代理」里改成单独设置或「不使用代理」。经跳板的主机不走代理。
// 改了自动保存（对之后新建的连接生效）；代理密码在离开密码框时才存。
export function NetworkSettings() {
  const [on, setOn] = useState(false)
  const [draft, setDraft] = useState<ProxyDraft>(emptyProxy)
  const [loaded, setLoaded] = useState(false)
  const cur = useRef({ on, draft })   // 最新值（同步更新，flush 时不依赖渲染）
  useEffect(() => {
    client.proxy.get().then((p) => { cur.current = { on: !!p, draft: p ? proxyDraftOf(p) : emptyProxy }; setOn(cur.current.on); setDraft(cur.current.draft); setLoaded(true) }).catch(() => setLoaded(true))
  }, [])
  const auto = useAutoSave({
    validate: () => proxyError(cur.current.on, cur.current.draft),
    save: async () => {
      const { on: o, draft: d } = cur.current
      const p = await client.proxy.save(o ? proxyInputOf(d) : null)
      // 密码已存进密钥链：框里清空显示「留空不改」；保存期间又改了的不动
      const next = { ...cur.current.draft, saved: !!p?.hasPassword, password: cur.current.draft.password === d.password ? '' : cur.current.draft.password }
      cur.current = { ...cur.current, draft: next }; setDraft(next)
    },
  })
  const update = (o: boolean, p: Partial<ProxyDraft>, delay: number) => {
    cur.current = { on: o, draft: { ...cur.current.draft, ...p } }
    setOn(o); setDraft(cur.current.draft)
    auto.schedule(delay)
  }
  if (!loaded) return <div className="text-[13px] text-[var(--color-text-muted)]">{tr('加载中…')}</div>
  return (
    <Page onBlur={auto.onBlur}>
      <Section title={tr('出站代理')} tip={tr('改了自动保存，对之后新建的连接生效；已连着的不受影响。')}>
        <Row label={tr('经代理出站')} hint={tr('公司网络必须走代理才能连外网时开启')}
          tip={trx('终端、批量执行、文件传输、端口转发等所有 SSH 连接都会经这个代理（经跳板机的主机不走代理）。 单台主机可在「主机与连接」编辑 → 高级 →「出站代理」里覆盖或选「不使用代理」。{br}代理密码经操作系统密钥链加密存储，离开密码框时才保存。关掉开关会清除已存的代理（含密码）。HTTP 代理需支持 CONNECT 方法（且允许连 22 等非 443 端口）；SOCKS5 由代理解析主机名。', { br: <br /> })}>
          <Switch checked={on} onCheckedChange={(v) => update(v, {}, DELAY_QUICK)} />
        </Row>
        {on && (
          <div className="px-3.5 py-3">
            <ProxyFields value={draft} onChange={(p) => update(true, p, p.type ? DELAY_QUICK : DELAY_TEXT)} />
          </div>
        )}
      </Section>
    </Page>
  )
}
