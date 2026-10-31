import { useEffect, useState } from 'react'
import { dateLocale, tr, type MobileStatus } from '@lingshell/shared'
import { trx } from '../../../lib/trx.js'
import { client } from '../../../client/index.js'
import { Switch } from '../../../components/ui/Switch.js'
import { Select } from '../../../components/ui/Select.js'
import { NumberInput } from '../../../components/ui/NumberInput.js'
import { BTN2, Page, Row, Section } from '../ui.js'
import { QrCode } from '../../../components/QrCode.js'
import { ConfirmDialog } from '../../common/index.js'

const errMsg = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': Error:\s*/, '')
const time = (ms: number) => new Date(ms).toLocaleString(dateLocale(), { hour12: false })

// 设置 →「手机访问」：局域网内用手机查看会话、处理授权（只看和批准，不能发消息 / 执行命令）。改动即时生效
export function MobileAccessSettings() {
  const [st, setSt] = useState<MobileStatus>()
  const [port, setPort] = useState<number>()
  const [err, setErr] = useState('')
  const [now, setNow] = useState(Date.now())
  const [revokeAll, setRevokeAll] = useState(false)
  const run = (p: Promise<MobileStatus>) => p.then((s) => { setSt(s); setErr('') }).catch((e) => setErr(errMsg(e)))
  // 配对 / 最近访问由手机端触发，页面开着时轮询刷新
  useEffect(() => {
    const tick = () => { setNow(Date.now()); client.mobile.status().then(setSt).catch(() => {}) }
    tick()
    const t = setInterval(tick, 2000)
    return () => clearInterval(t)
  }, [])
  if (!st) return null
  const left = st.pairing ? Math.max(0, Math.round((st.pairing.expiresAt - now) / 1000)) : 0
  const pairUrl = st.url && st.pairing ? `${st.url}#c=${st.pairing.code}` : undefined
  const addrs = st.addresses.some((a) => a.address === st.address) || !st.address ? st.addresses : [...st.addresses, { address: st.address, name: tr('当前不可用') }]

  // JSX 多行文字按行首尾去空白、行间补一个空格拼接：词条照此写成一句（<b> 前无空格）
  const risk = <>{trx('开启后，同一局域网里的手机可以在浏览器里查看 AI 会话、批准或拒绝授权请求（不能发消息、不能执行命令）。 走 HTTP（不用自签证书，免得手机报证书警告），靠一次性配对码换取设备令牌保护，所有接口都校验令牌。{b}；不用时关掉，关闭后立即停止服务并断开所有手机。 关闭不会撤销已配对设备，下次开启它们无需重新配对；手机丢了或不确定是否可信时，请在「已配对设备」里撤销（或全部撤销），不要只关开关。 设备令牌 30 天后过期，到期需重新配对。',
    { b: <b>{tr('只在可信的局域网（家里 / 公司内网）开启，公共 Wi-Fi 不要开')}</b> })}</>
  return (
    <Page>
      <Section title={tr('手机访问')} tip={risk}>
        <Row label={tr('允许手机在局域网查看与授权')} tip={risk}
          hint={st.running ? <>{trx('运行中：{url}', { url: <span className="font-mono text-[var(--color-accent)]" data-mobile-url>{st.url}</span> })}</> : st.error ? <span className="text-[var(--color-danger)]">{st.error}</span> : tr('已关闭')}>
          <Switch data-mobile-switch checked={st.enabled} onCheckedChange={(v) => run(client.mobile.setEnabled(v))} />
        </Row>
        <Row label={tr('网卡地址')} hint={tr('只绑定这个局域网地址；公网地址不会出现在列表里')}
          tip={tr('默认用第一个私有网段地址（10.x / 172.16–31.x / 192.168.x）。电脑有多块网卡（有线 / 无线 / 虚拟网卡）时，选手机所在的那个网络。选的地址不在了（换了网络）服务不会自动换到别的网卡，需要重新选。')}>
          <Select className="w-[230px]" value={st.address ?? st.addresses[0]?.address ?? ''} onValueChange={(v) => run(client.mobile.configure({ address: v }))}
            options={addrs.length ? addrs.map((a) => ({ value: a.address, label: tr('{addr}（{name}）', { addr: a.address, name: a.name }) })) : [{ value: '', label: tr('没有可用的局域网地址'), disabled: true }]} />
        </Row>
        <Row label={tr('端口')} hint={tr('首次开启时随机选定的高位端口，改后立即生效')}>
          <NumberInput className="w-[110px]" min={1024} max={65535} value={port ?? st.port} onChange={setPort} />
          {port !== undefined && port !== st.port && <button className={BTN2} onClick={() => { void run(client.mobile.configure({ port })); setPort(undefined) }}>{tr('btn|应用')}</button>}
        </Row>
        {err && <div className="px-3.5 py-2 text-[11.5px] text-[var(--color-danger)]">{err}</div>}
      </Section>

      {st.running && (
        <Section title={tr('配对新设备')} tip={tr('配对码 5 分钟内有效、只能用一次；同一台设备输错 5 次会锁定 10 分钟（不影响在电脑上重新生成配对码）。配对后手机会记住（浏览器 cookie，30 天有效），以后直接打开地址即可；清了浏览器数据需要重新配对。')}>
          <Row label={tr('配对码')} hint={tr('手机浏览器打开下面的地址，输入配对码')}>
            <button className={BTN2} onClick={() => run(client.mobile.newPairCode())}>{st.pairing ? tr('重新生成') : tr('生成配对码')}</button>
          </Row>
          {st.pairing && pairUrl ? (
            <Row label={tr('在手机上打开')} wide>
              <div className="flex flex-wrap items-center gap-4">
                <QrCode text={pairUrl} />
                <div className="min-w-0 flex-1 space-y-1.5 text-[12px]">
                  <div className="text-[var(--color-text-secondary)]">{tr('用手机相机或微信扫码，打开后自动配对；或在手机浏览器打开下面的地址，输入配对码')}</div>
                  <span data-mobile-code className="block font-mono text-[28px] font-semibold tracking-[6px] text-[var(--color-accent)]">{st.pairing.code}</span>
                  <div className="break-all font-mono text-[var(--color-text-primary)]">{st.url}</div>
                  <div className="text-[var(--color-text-muted)]">{trx('{m} 分 {s} 秒后过期 · 带码的链接 {url}', { url: <span className="break-all font-mono">{pairUrl}</span> }, { m: Math.floor(left / 60), s: left % 60 })}</div>
                  <button className={BTN2} title={tr('链接里含配对码，5 分钟内有效；不要发到群里')} onClick={() => { void navigator.clipboard.writeText(pairUrl) }}>{tr('复制含码链接')}</button>
                </div>
              </div>
            </Row>
          ) : st.url && (
            <Row label={tr('已配对的手机')} hint={tr('扫码直接打开（不含配对码，没配对过的手机需要先生成配对码）')} wide>
              <div className="flex items-center gap-4">
                <QrCode text={st.url} size={128} />
                <div className="space-y-1.5 text-[12px]">
                  <div className="break-all font-mono text-[var(--color-text-primary)]">{st.url}</div>
                  <button className={BTN2} onClick={() => { void navigator.clipboard.writeText(st.url ?? '') }}>{tr('复制地址')}</button>
                </div>
              </div>
            </Row>
          )}
        </Section>
      )}

      <Section title={tr('已配对设备')} tip={tr('撤销后该手机立即无法访问（下次刷新即要求重新配对）。设备令牌 30 天后自动过期。')}>
        {st.devices.length === 0 && <Row label={<span className="text-[var(--color-text-muted)]">{tr('还没有配对的设备')}</span>} />}
        {st.devices.length > 0 && (
          <Row label={tr('全部撤销')} hint={tr('手机丢失或不确定是否可信时用；撤销后所有手机都要重新配对')}>
            <button data-mobile-revoke-all className={`${BTN2} hover:text-[var(--color-danger)]`} onClick={() => setRevokeAll(true)}>{tr('全部撤销')}</button>
          </Row>
        )}
        {st.devices.map((dv) => (
          <Row key={dv.id} label={dv.name} hint={`${tr('配对于 {t}', { t: time(dv.createdAt) })}${dv.expiresAt ? tr(' · 有效期至 {t}', { t: time(dv.expiresAt) }) : ''}${dv.lastSeenAt ? tr(' · 最近访问 {t}', { t: time(dv.lastSeenAt) }) : ''}${dv.lastIp ? ` · ${dv.lastIp}` : ''}`}>
            <button data-mobile-revoke className={`${BTN2} hover:text-[var(--color-danger)]`} onClick={() => run(client.mobile.revoke(dv.id))}>{tr('撤销')}</button>
          </Row>
        ))}
      </Section>
      <ConfirmDialog open={revokeAll} title={tr('撤销全部手机设备')} confirmText={tr('全部撤销')}
        message={tr('所有已配对的手机都会立即无法访问，需要重新配对才能再用。确定撤销全部？')}
        onConfirm={() => { setRevokeAll(false); run(client.mobile.revokeAll()) }} onCancel={() => setRevokeAll(false)} />
    </Page>
  )
}
