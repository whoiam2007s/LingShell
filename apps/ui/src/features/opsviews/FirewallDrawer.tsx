import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileCode2, MessageSquareQuote, Radar, ShieldCheck } from 'lucide-react'
import { paletteSend } from '../../lib/paletteBus.js'
import {
  FW_ACTION_LABEL, FW_DIR_LABEL, FW_TOOL_LABEL, firewallQuote, listenLines, portsSupported, questionPort, redactSecrets, ruleMatchesPort, tr,
  type FwList, type FwTool, type TerminalInfo,
} from '@lingshell/shared'
import { client } from '../../client/index.js'
import { quoteToChat } from '../../lib/quoteToChat.js'
import { Input } from '../../components/ui/Input.js'
import { HelpTip } from '../../components/ui/form.js'
import { BTN, DrawerHeader, MUTED, Unsupported, errText } from './common.js'

const ACT_CLS = { allow: 'text-[var(--color-success)]', deny: 'text-[var(--color-danger)]', reject: 'text-[var(--color-danger)]', other: 'text-[var(--color-text-muted)]' }

// 防火墙规则可读化（只读）：firewalld / ufw / nftables / iptables 有哪个读哪个，解析成「方向 / 动作 / 协议 / 端口 / 来源 / 说明」。
// 顶部「问 AI」：问题里有端口号就高亮相关规则，并把规则原文 + 该端口的监听情况（ss）放进对话输入框
export function FirewallDrawer({ term, onClose }: { term?: TerminalInfo; onClose: () => void }) {
  const ok = !!term && portsSupported(term.type, term.os)
  const tid = term?.id ?? ''
  const [list, setList] = useState<FwList>()
  const [tool, setTool] = useState<FwTool>()
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  const [raw, setRaw] = useState(false)

  // 请求序号：迟到的旧响应不能覆盖新结果，也不能把连点刷新吞掉
  const seq = useRef(0)
  const refresh = useCallback(() => {
    if (!ok) return
    const n = ++seq.current
    setLoading(true)
    client.firewall.list(tid).then((r) => {
      if (n !== seq.current) return
      setList(r); setTool((t) => (r.sections.some((s) => s.tool === t) ? t : r.sections[0]?.tool)); setErr('')
    }).catch((e) => { if (n === seq.current) setErr(errText(e)) })
      .finally(() => { if (n === seq.current) setLoading(false) })
  }, [ok, tid])
  useEffect(() => { refresh() }, [refresh])

  const sec = list?.sections.find((s) => s.tool === tool)
  const port = questionPort(q)
  const listening = useMemo(() => (list && port ? listenLines(list.listen, port) : []), [list, port])
  const ask = async () => {
    if (!list) return
    const s = await client.settings.get().catch(() => undefined)
    const text = firewallQuote({ host: term?.title ?? '', question: q.trim() || tr('帮我看看这台主机的防火墙规则有没有问题'), list, port })
    quoteToChat(s?.system?.aiRedact === false ? text : redactSecrets(text))
    onClose()
  }

  const header = <DrawerHeader icon={<ShieldCheck className="h-3.5 w-3.5" />} title={tr('防火墙')} loading={loading} onRefresh={ok ? refresh : undefined} onClose={onClose}
    extra={ok ? <HelpTip>{tr('只读：只展示规则，不会修改。读规则需要 root：用 root 登录时直接读，否则用免密 sudo -n；要密码的标「需要 root」。云主机的安全组不在这里，要到云控制台看。')}</HelpTip> : undefined} />
  if (!ok) return <div className="flex h-full flex-col">{header}<Unsupported what={tr('防火墙视图')} /></div>

  return (
    <div className="flex h-full flex-col" data-firewall-drawer>
      {header}
      <div className="shrink-0 space-y-1 border-b border-[var(--color-border-subtle)] px-3 py-1.5">
        <div className="flex items-center gap-1.5">
          <Input data-fw-ask size="sm" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void ask() }}
            placeholder={tr('问 AI：为什么 8080 端口外部访问不了')} />
          <button data-fw-ask-btn disabled={!list} onClick={() => void ask()} title={tr('把问题、防火墙规则和该端口的监听情况放进对话输入框（按设置脱敏，不自动发送）')}
            className={`${BTN} text-[var(--color-accent)]`}><MessageSquareQuote className="h-3 w-3" />{tr('问 AI')}</button>
          <button data-fw-probe onClick={() => paletteSend({ type: 'connProbe', source: term?.hostId ? `host:${term.hostId}` : `term:${tid}` })} title={tr('从这台主机（可再加别的源）测到其他服务的 DNS / TCP / HTTP 连通性')}
            className={`${BTN} text-[var(--color-text-secondary)]`}><Radar className="h-3 w-3" />{tr('测连通')}</button>
        </div>
        {port !== undefined && list && (
          <div data-fw-listen className="text-[10.5px] leading-relaxed">
            <span className={MUTED}>{tr('端口 {port}：', { port })}</span>
            {listening.length ? <span className="font-mono text-[var(--color-text-secondary)]">{listening.map((l) => l.trim().replace(/\s+/g, ' ')).join(tr('；'))}</span>
              : <span className="text-[var(--color-warn)]">{tr('没有程序在这个端口上监听')}</span>}
            <span className={MUTED}>{tr(' · 下方高亮管这个端口的规则')}</span>
          </div>
        )}
      </div>
      {err && <div className="shrink-0 whitespace-pre-wrap break-all border-b border-[var(--color-border-subtle)] px-3 py-1.5 text-[11px] text-[var(--color-danger)]">{err}</div>}
      {list && list.sections.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--color-border-subtle)] px-3 py-1">
          {list.sections.map((s) => (
            <button key={s.tool} data-fw-tool={s.tool} onClick={() => setTool(s.tool)}
              className={`rounded px-2 py-0.5 text-[11px] ${s.tool === tool ? 'bg-[var(--color-accent-bg)] text-[var(--color-accent)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'}`}>
              {FW_TOOL_LABEL[s.tool]}<span className={`ml-1 text-[10px] ${s.denied ? 'text-[var(--color-warn)]' : MUTED}`}>{s.denied ? tr('需要 root') : s.active ? (s.tool === list.primary ? tr('在用') : tr('有规则')) : tr('未启用')}</span>
            </button>
          ))}
          <span className="ml-auto" />
          {sec && <button onClick={() => setRaw((r) => !r)} className={`${BTN} ${raw ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-secondary)]'}`}><FileCode2 className="h-3 w-3" />{tr('原始输出')}</button>}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {!list && <div className={`px-3 py-3 text-[12px] ${MUTED}`}>{loading ? tr('读取中…') : ''}</div>}
        {list && !list.sections.length && <div className={`px-3 py-3 text-[12px] ${MUTED}`}>{tr('没有找到 firewalld / ufw / nftables / iptables。这台主机可能没装防火墙，或由云厂商的安全组控制（安全组要在云控制台看）。')}</div>}
        {sec && raw && <pre className="whitespace-pre-wrap break-all px-3 py-2 font-mono text-[10.5px] leading-[1.5] text-[var(--color-text-secondary)]">{sec.raw || tr('（没有输出）')}</pre>}
        {sec && !raw && <>
          {sec.denied && <div className="px-3 py-2 text-[11.5px] text-[var(--color-warn)]">{tr('读取 {tool} 规则需要 root，而这台主机的 sudo 要输密码（这里只用免密 sudo -n）。可以在终端里手动执行 sudo 查看。', { tool: FW_TOOL_LABEL[sec.tool] })}</div>}
          {sec.policy.length > 0 && (
            <div data-fw-policy className="space-y-0.5 border-b border-[var(--color-border-subtle)] px-3 py-1.5 text-[11px] text-[var(--color-text-secondary)]">
              {sec.policy.map((p, i) => <div key={i}>· {tr(p)}</div>)}
            </div>
          )}
          {sec.rules.length > 0 && (
            <table className="w-full border-collapse text-[11px]">
              <thead className="sticky top-0 z-[1] bg-[var(--color-bg-panel)] text-left text-[10.5px] text-[var(--color-text-muted)]">
                <tr>{[tr('方向'), tr('col|动作'), tr('协议'), tr('端口'), tr('来源'), tr('说明')].map((h) => <th key={h} className="whitespace-nowrap border-b border-[var(--color-border-subtle)] px-1.5 py-1 font-medium first:pl-3">{h}</th>)}</tr>
              </thead>
              <tbody>
                {sec.rules.map((r, i) => {
                  // 回环 / 已建立连接这类不按端口的通用规则不算，免得满屏高亮
                  const hit = port !== undefined && (r.dir === 'in' || r.dir === 'other') && ruleMatchesPort(r, port) && r.iface !== 'lo' && !/established/i.test(r.raw)
                  return (
                    <tr key={i} data-fw-rule={i} data-hit={hit || undefined} title={`${r.chain ? `${r.chain}\n` : ''}${r.raw}`}
                      className={`align-top hover:bg-[var(--color-bg-hover)] ${hit ? 'bg-[color:color-mix(in_srgb,var(--color-accent)_14%,transparent)]' : ''}`}>
                      <td className="whitespace-nowrap border-b border-[var(--color-border-subtle)] px-1.5 py-1 pl-3 text-[var(--color-text-secondary)]">{tr(FW_DIR_LABEL[r.dir])}</td>
                      <td className={`whitespace-nowrap border-b border-[var(--color-border-subtle)] px-1.5 py-1 font-medium ${ACT_CLS[r.action]}`}>{r.action === 'reject' ? tr(FW_ACTION_LABEL.deny) : tr(FW_ACTION_LABEL[r.action])}</td>
                      <td className="whitespace-nowrap border-b border-[var(--color-border-subtle)] px-1.5 py-1 font-mono text-[var(--color-text-secondary)]">{r.proto || tr('全部')}</td>
                      <td className="max-w-[80px] truncate border-b border-[var(--color-border-subtle)] px-1.5 py-1 font-mono text-[var(--color-text-primary)]">{r.port || tr('全部')}</td>
                      <td className="max-w-[96px] truncate border-b border-[var(--color-border-subtle)] px-1.5 py-1 font-mono text-[var(--color-text-secondary)]">{r.source || tr('任何')}</td>
                      <td className="border-b border-[var(--color-border-subtle)] px-1.5 py-1 pr-3 text-[var(--color-text-primary)]">{tr(r.text)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
          {!sec.rules.length && !sec.denied && <div className={`px-3 py-2 text-[11.5px] ${MUTED}`}>{tr('（没有规则）')}</div>}
        </>}
      </div>
    </div>
  )
}
