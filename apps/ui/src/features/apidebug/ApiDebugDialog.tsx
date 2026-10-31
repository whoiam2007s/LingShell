import { useEffect, useMemo, useRef, useState } from 'react'
import { Braces, Copy, FileInput, Loader2, Plus, Save, Send, Trash2, X } from 'lucide-react'
import {
  API_METHODS, newApiRequest, parseCurl, prettyBody, toCurl, tk, tr,
  type ApiBodyType, type ApiEnv, type ApiKV, type ApiMethod, type ApiRequest, type ApiResponse, type ApiStore, type TerminalInfo,
} from '@lingshell/shared'
import { client } from '../../client/index.js'
import { onPalette, paletteSend } from '../../lib/paletteBus.js'
import { ActBtn } from '../../components/ActivityBar.js'
import { Checkbox } from '../../components/ui/Checkbox.js'
import { Input, Textarea } from '../../components/ui/Input.js'
import { Select } from '../../components/ui/Select.js'
import { uiLayerBusy } from '../../components/ui/layer.js'
import { HelpTip } from '../../components/ui/form.js'
import { openTableView } from '../table/index.js'
import { cn } from '../../lib/cn.js'

// 接口调试面板（类似 REST Client）：方法 / URL / 请求头 / 请求体，「发送位置」可选本机或某个 SSH 终端所在主机（内网接口也能调）。
// 请求集合与环境变量存数据目录（修改即自动保存）；{{变量}} 按当前环境替换，{{secret:名称}} 走密钥保险箱（发送时才在主进程展开，界面 / 历史只有占位符）。
// 打开：右侧活动栏「接口调试」/ 命令面板「接口调试」。弹窗只能点 × / 按 Esc 关
const errText = (e: unknown) => String((e as { message?: string })?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const BTN = 'flex h-7 shrink-0 items-center gap-1 rounded-md border border-[var(--color-border-default)] px-2 text-[11.5px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] disabled:opacity-40'
const TAB = 'rounded px-2 py-0.5 text-[11.5px]'
const tabCls = (on: boolean) => cn(TAB, on ? 'bg-[var(--color-bg-raised)] text-[var(--color-accent)]' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]')
const BODY_TYPES: { value: ApiBodyType; label: string }[] = [{ value: 'none', label: tk('无') }, { value: 'json', label: 'JSON' }, { value: 'form', label: tk('表单（每行 key=value）') }, { value: 'multipart', label: tk('表单（含文件）') }, { value: 'text', label: tk('原文') }]
// 请求体页签上只显示短名（去掉括号里的说明）
const BODY_SHORT: Record<ApiBodyType, string> = { none: tk('无'), json: 'JSON', form: tk('表单'), multipart: tk('文件表单'), text: tk('原文') }
const uid = () => crypto.randomUUID().slice(0, 12)
const statusCls = (s: number) => (s >= 500 ? 'text-[var(--color-danger)]' : s >= 400 ? 'text-[var(--color-warn)]' : s >= 300 ? 'text-[var(--color-accent)]' : 'text-[var(--color-success)]')

export function ApiDebugButton() {
  return <ActBtn title={tr('接口调试（HTTP 请求，可从某台主机发）')} onClick={() => paletteSend({ type: 'apiDebug' })}><Send className="h-4 w-4" /></ActBtn>
}

export function ApiDebugDialog({ terms }: { terms: TerminalInfo[] }) {
  const [open, setOpen] = useState(false)
  useEffect(() => onPalette((c) => { if (c.type === 'apiDebug') setOpen(true) }), [])
  return open ? <ApiBody terms={terms} onClose={() => setOpen(false)} /> : null
}

// 键值行编辑（请求头 / 环境变量共用）
function KvRows({ rows, onChange, keyPh, valPh }: { rows: ApiKV[]; onChange: (r: ApiKV[]) => void; keyPh: string; valPh: string }) {
  const set = (i: number, p: Partial<ApiKV>) => onChange(rows.map((r, k) => (k === i ? { ...r, ...p } : r)))
  return (
    <div className="space-y-1">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Checkbox checked={!r.off} onCheckedChange={(v) => set(i, { off: v ? undefined : true })} title={tr('勾掉 = 暂不使用')} />
          <Input size="sm" value={r.key} onChange={(e) => set(i, { key: e.target.value })} placeholder={keyPh} className="w-[38%] font-mono text-[11.5px]" />
          <Input size="sm" value={r.value} onChange={(e) => set(i, { value: e.target.value })} placeholder={valPh} className="font-mono text-[11.5px]" />
          <button title={tr('删除')} onClick={() => onChange(rows.filter((_, k) => k !== i))} className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"><X className="h-3.5 w-3.5" /></button>
        </div>
      ))}
      <button onClick={() => onChange([...rows, { key: '', value: '' }])} className="flex items-center gap-1 text-[11.5px] text-[var(--color-accent)] hover:underline"><Plus className="h-3 w-3" />{tr('添加')}</button>
    </div>
  )
}

function ApiBody({ terms, onClose }: { terms: TerminalInfo[]; onClose: () => void }) {
  const [store, setStore] = useState<ApiStore>()
  const [req, setReq] = useState<ApiRequest>(() => newApiRequest(uid()))
  const [side, setSide] = useState<'collection' | 'history' | 'env'>('collection')
  const [reqTab, setReqTab] = useState<'headers' | 'body'>('headers')
  const [resTab, setResTab] = useState<'body' | 'headers'>('body')
  const [via, setVia] = useState('local')
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<ApiResponse>()
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')
  const [curlIn, setCurlIn] = useState<string | null>(null)   // 「从 curl 导入」输入框
  const [envEdit, setEnvEdit] = useState('')                    // 环境页正在编辑的环境
  const sendSeq = useRef(0)                                     // 每次发送 / 切请求递增：迟到的旧响应不能盖到新请求上

  useEffect(() => { client.api.load().then(setStore).catch((e) => setErr(errText(e))) }, [])
  // Esc 关（下拉面板开着时先关面板；curl 导入框开着先关它）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || uiLayerBusy() || document.querySelector('[data-table-dialog]')) return   // 上面叠着 JSON 树时 Esc 只关它
      e.stopPropagation()
      if (curlIn !== null) setCurlIn(null); else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, curlIn])
  // 修改即自动保存（集合 / 环境）：防抖 400ms
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const pending = useRef<ApiStore>(undefined)
  const flush = () => {
    clearTimeout(saveTimer.current)
    const s = pending.current; pending.current = undefined
    // 主进程会做长度 / 数量裁剪并把实际保存的内容返回：回填到界面，用户能看出哪些被截掉了
    if (s) client.api.save(s).then(setStore).catch((e) => setErr(tr('保存失败：{err}', { err: errText(e) })))
  }
  const persist = (s: ApiStore) => {
    setStore(s)
    pending.current = s
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(flush, 400)
  }
  useEffect(() => () => flush(), [])   // 关弹窗时没落盘的立即保存

  const flash = (t: string) => { setNote(t); setTimeout(() => setNote((n) => (n === t ? '' : n)), 2000) }
  const env = store?.envs.find((e) => e.id === store.activeEnv)
  const sshTerms = terms.filter((t) => t.type === 'ssh' && t.os !== 'windows' && t.status !== 'disconnected')
  const viaTerm = sshTerms.find((t) => t.id === via)
  useEffect(() => { if (via !== 'local' && !sshTerms.some((t) => t.id === via)) setVia('local') }, [terms])
  const saved = store?.requests.some((r) => r.id === req.id)
  const patch = (p: Partial<ApiRequest>) => setReq((r) => ({ ...r, ...p }))

  // 切换请求 / 新建 / 导入历史时让仍在途的响应作废（主进程请求仍会跑完，但结果不再显示）
  const cancelPending = () => { sendSeq.current++; setBusy(false) }
  const send = () => {
    if (!req.url.trim()) return
    const id = ++sendSeq.current
    setBusy(true); setErr(''); setRes(undefined)
    client.api.send({ request: req, vars: env?.vars ?? [], via })
      .then(({ response, history }) => { if (id !== sendSeq.current) return; setRes(response); setStore((s) => (s ? { ...s, history } : s)) })
      .catch((e) => { if (id === sendSeq.current) setErr(errText(e)); client.api.load().then((s) => setStore((x) => (x ? { ...x, history: s.history } : s))).catch(() => {}) })
      .finally(() => { if (id === sendSeq.current) setBusy(false) })
  }
  const saveReq = () => {
    if (!store) return
    const exists = store.requests.some((r) => r.id === req.id)
    persist({ ...store, requests: exists ? store.requests.map((r) => (r.id === req.id ? req : r)) : [...store.requests, req] })
    flash(exists ? tr('已更新集合里的请求') : tr('已保存到集合'))
  }
  const importCurl = () => {
    const r = parseCurl(curlIn ?? '', uid())
    if ('error' in r) { setErr(tr('导入失败：{err}', { err: tr(r.error) })); return }
    cancelPending(); setRes(undefined); setReq(r); setCurlIn(null); setErr(''); setReqTab(r.bodyType !== 'none' ? 'body' : 'headers')
  }
  // done：复制成功的提示（已翻译）
  const copy = (text: string, done: string) => navigator.clipboard.writeText(text).then(() => flash(done), () => flash(tr('复制失败')))
  const pretty = useMemo(() => (res ? prettyBody(res.body, res.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1]) : undefined), [res])

  const envs = store?.envs ?? []
  const editing = envs.find((e) => e.id === envEdit) ?? envs[0]
  const setEnv = (id: string, p: Partial<ApiEnv>) => store && persist({ ...store, envs: store.envs.map((e) => (e.id === id ? { ...e, ...p } : e)) })

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in">
      <div data-api-dialog onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !busy && req.url.trim()) { e.preventDefault(); send() } }}
        className="flex h-[86vh] w-[min(1240px,95vw)] flex-col overflow-hidden rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] shadow-2xl">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-4">
          <Send className="h-4 w-4 shrink-0 text-[var(--color-accent)]" />
          <span className="shrink-0 text-[13px] font-semibold text-[var(--color-text-primary)]">{tr('接口调试')}</span>
          <HelpTip>{tr('URL、请求头、请求体里可写 {v}（取当前环境，在左侧「环境」页编辑）和 {s}（密钥保险箱，发送时才替换成明文，界面、集合和历史里只显示占位符）。「发送位置」选某个 SSH 终端时，请求从那台主机用 curl 发出（内网接口也能调）。', { v: `{{${tr('syntax|变量')}}}`, s: tr('{{secret:名称}}') })}</HelpTip>
          <span className="ml-auto text-[11.5px] text-[var(--color-text-muted)]">{tr('环境')}</span>
          <Select size="sm" value={store?.activeEnv ?? ''} onValueChange={(v) => store && persist({ ...store, activeEnv: v || undefined })} className="w-36"
            options={[{ value: '', label: tr('（不用环境）') }, ...envs.map((e) => ({ value: e.id, label: e.name }))]} aria-label={tr('当前环境')} />
          <span className="text-[11.5px] text-[var(--color-text-muted)]">{tr('发送位置')}</span>
          <Select size="sm" value={via} onValueChange={setVia} className="w-56" aria-label={tr('发送位置')}
            options={[{ value: 'local', label: tr('本机') }, ...sshTerms.map((t) => ({ value: t.id, label: t.env === 'prod' ? tr('【生产】{title}（SSH）', { title: t.title }) : tr('{title}（SSH）', { title: t.title }) }))]} />
          {viaTerm?.env === 'prod' && <span data-api-prod title={tr('请求会从生产主机发出，改数据的请求请先确认')} className="shrink-0 rounded bg-[color:color-mix(in_srgb,var(--color-danger)_15%,transparent)] px-1.5 py-0.5 text-[10.5px] font-medium text-[var(--color-danger)]">{tr('生产')}</span>}
          <button title={tr('关闭（Esc）')} onClick={onClose} className="ml-1 rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"><X className="h-4 w-4" /></button>
        </div>
        <div className="flex min-h-0 flex-1">
          {/* 左：集合 / 历史 / 环境 */}
          <div className="flex w-60 shrink-0 flex-col border-r border-[var(--color-border-subtle)]">
            <div className="flex shrink-0 items-center gap-1 border-b border-[var(--color-border-subtle)] px-2 py-1.5">
              <button data-api-side="collection" className={tabCls(side === 'collection')} onClick={() => setSide('collection')}>{tr('集合')}</button>
              <button data-api-side="history" className={tabCls(side === 'history')} onClick={() => setSide('history')}>{tr('历史')}</button>
              <button data-api-side="env" className={tabCls(side === 'env')} onClick={() => setSide('env')}>{tr('环境')}</button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1.5 text-[11.5px]">
              {side === 'collection' && <>
                <div className="mb-1 flex gap-1">
                  <button onClick={() => { cancelPending(); setReq(newApiRequest(uid())); setRes(undefined); setErr('') }} className={BTN}><Plus className="h-3.5 w-3.5" />{tr('新建')}</button>
                  <button data-api-curl-import onClick={() => setCurlIn('')} className={BTN}><FileInput className="h-3.5 w-3.5" />{tr('从 curl 导入')}</button>
                </div>
                {!store?.requests.length && <div className="px-1 py-2 text-[var(--color-text-muted)]">{tr('还没有保存的请求：编辑好后点「保存」')}</div>}
                {store?.requests.map((r) => (
                  <div key={r.id} data-api-saved={r.name} onClick={() => { cancelPending(); setReq(r); setRes(undefined); setErr('') }}
                    className={cn('group flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 hover:bg-[var(--color-bg-hover)]', r.id === req.id && 'bg-[color:color-mix(in_srgb,var(--color-accent)_15%,transparent)]')}>
                    <span className="w-11 shrink-0 font-mono text-[10px] font-semibold text-[var(--color-accent)]">{r.method}</span>
                    <span className="min-w-0 flex-1 truncate text-[var(--color-text-primary)]" title={r.url}>{r.name}</span>
                    <button title={tr('删除')} onClick={(e) => { e.stopPropagation(); persist({ ...store, requests: store.requests.filter((x) => x.id !== r.id) }) }}
                      className="shrink-0 text-[var(--color-text-muted)] opacity-0 hover:text-[var(--color-danger)] group-hover:opacity-100"><Trash2 className="h-3 w-3" /></button>
                  </div>
                ))}
              </>}
              {side === 'history' && <>
                {!!store?.history.length && <button onClick={() => client.api.clearHistory().then(() => setStore((s) => (s ? { ...s, history: [] } : s))).catch(() => {})} className={cn(BTN, 'mb-1')}><Trash2 className="h-3.5 w-3.5" />{tr('清空历史')}</button>}
                {!store?.history.length && <div className="px-1 py-2 text-[var(--color-text-muted)]">{tr('还没有发送过请求')}</div>}
                {store?.history.map((h, i) => (
                  <div key={i} data-api-history onClick={() => { cancelPending(); setReq({ ...h.request, id: uid() }); setRes(undefined); setErr('') }} title={`${h.at}\n${tr('发送位置：{via}', { via: tr(h.via) })}${h.error ? `\n${h.error}` : ''}`}
                    className="cursor-pointer rounded px-1.5 py-1 hover:bg-[var(--color-bg-hover)]">
                    <div className="flex items-center gap-1.5">
                      <span className="w-11 shrink-0 font-mono text-[10px] font-semibold text-[var(--color-accent)]">{h.method}</span>
                      {h.status ? <span className={cn('font-mono text-[10.5px]', statusCls(h.status))}>{h.status}</span> : <span className="text-[10.5px] text-[var(--color-danger)]">{tr('失败')}</span>}
                      {h.ms !== undefined && <span className="text-[10px] text-[var(--color-text-muted)]">{h.ms} ms</span>}
                      <span className="ml-auto truncate text-[10px] text-[var(--color-text-muted)]">{tr(h.via)}</span>
                    </div>
                    <div className="truncate font-mono text-[10.5px] text-[var(--color-text-secondary)]">{h.url}</div>
                  </div>
                ))}
              </>}
              {side === 'env' && store && <>
                <div className="mb-1.5 flex gap-1">
                  <button data-api-env-add onClick={() => { const e: ApiEnv = { id: uid(), name: tr('环境 {n}', { n: envs.length + 1 }), vars: [{ key: 'base', value: 'http://127.0.0.1:8080' }] }; persist({ ...store, envs: [...envs, e], activeEnv: store.activeEnv ?? e.id }); setEnvEdit(e.id) }} className={BTN}><Plus className="h-3.5 w-3.5" />{tr('添加环境')}</button>
                  {editing && <button title={tr('删除这个环境')} onClick={() => persist({ ...store, envs: envs.filter((e) => e.id !== editing.id), activeEnv: store.activeEnv === editing.id ? undefined : store.activeEnv })} className={BTN}><Trash2 className="h-3.5 w-3.5" /></button>}
                </div>
                {!envs.length && <div className="px-1 py-2 leading-relaxed text-[var(--color-text-muted)]">{tr('环境 = 一组变量（如 dev / staging），请求里写 {{base}} 即替换成当前环境的值。')}</div>}
                {editing && <div className="space-y-1.5">
                  {envs.length > 1 && <Select size="sm" value={editing.id} onValueChange={setEnvEdit} options={envs.map((e) => ({ value: e.id, label: e.name }))} aria-label={tr('编辑哪个环境')} />}
                  <Input size="sm" value={editing.name} onChange={(e) => setEnv(editing.id, { name: e.target.value })} placeholder={tr('环境名')} aria-label={tr('环境名')} />
                  <div className="text-[10.5px] text-[var(--color-text-muted)]">{tr('变量（值里可写 {{secret:名称}}）')}</div>
                  <KvRows rows={editing.vars} onChange={(vars) => setEnv(editing.id, { vars })} keyPh={tr('名称')} valPh={tr('值')} />
                </div>}
              </>}
            </div>
          </div>
          {/* 右：请求 + 响应 */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="shrink-0 space-y-2 border-b border-[var(--color-border-subtle)] p-3">
              <div className="flex items-center gap-1.5">
                <Input size="sm" value={req.name} onChange={(e) => patch({ name: e.target.value })} placeholder={tr('请求名称')} className="w-60" aria-label={tr('请求名称')} />
                {saved && <span className="text-[10.5px] text-[var(--color-text-muted)]">{tr('（集合里的请求，改完点「保存」更新）')}</span>}
                <span className="ml-auto" />
                {note && <span className="text-[11px] text-[var(--color-success)]">{note}</span>}
                <button title={tr('复制为 curl（占位符原样保留）')} onClick={() => copy(toCurl(req), tr('已复制 curl 命令'))} className={BTN}><Copy className="h-3.5 w-3.5" />{tr('复制为 curl')}</button>
                <button data-api-save onClick={saveReq} className={BTN}><Save className="h-3.5 w-3.5" />{tr('保存')}</button>
              </div>
              <div className="flex items-center gap-1.5">
                <Select size="sm" value={req.method} onValueChange={(v) => patch({ method: v as ApiMethod })} className="w-28 font-mono" aria-label={tr('方法')} options={API_METHODS.map((m) => ({ value: m, label: m }))} />
                <Input data-api-url value={req.url} onChange={(e) => patch({ url: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter' && !busy && req.url.trim()) send() }}
                  placeholder={tr('https://example.com/api 或 {{base}}/api')} className="font-mono text-[12px]" aria-label="URL" />
                <button data-api-send disabled={busy || !req.url.trim()} onClick={send}
                  className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-transparent bg-[var(--color-accent)] px-4 text-[12.5px] font-medium text-[var(--color-bg-base)] hover:opacity-90 disabled:opacity-40">
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}{tr('发送')}</button>
              </div>
              <div className="flex items-center gap-1">
                <button className={tabCls(reqTab === 'headers')} onClick={() => setReqTab('headers')}>{req.headers.filter((h) => !h.off && h.key).length ? tr('请求头（{n}）', { n: req.headers.filter((h) => !h.off && h.key).length }) : tr('请求头')}</button>
                <button data-api-tab-body className={tabCls(reqTab === 'body')} onClick={() => setReqTab('body')}>{tr('请求体')}{req.bodyType !== 'none' ? ` · ${tr(BODY_SHORT[req.bodyType])}` : ''}</button>
              </div>
              <div className="max-h-[30vh] overflow-y-auto">
                {reqTab === 'headers' && <KvRows rows={req.headers} onChange={(headers) => patch({ headers })} keyPh={tr('Header 名（如 Authorization）')} valPh={tr('值（如 Bearer {{secret:token}}）')} />}
                {reqTab === 'body' && <div className="space-y-1.5">
                  <Select size="sm" value={req.bodyType} onValueChange={(v) => patch({ bodyType: v as ApiBodyType })} className="w-56" aria-label={tr('请求体类型')} options={BODY_TYPES.map((b) => ({ value: b.value, label: tr(b.label) }))} />
                  {req.bodyType !== 'none' && <Textarea data-api-body value={req.body} onChange={(e) => patch({ body: e.target.value })} rows={6} spellCheck={false}
                    placeholder={req.bodyType === 'json' ? '{"name": "value"}' : req.bodyType === 'form' ? 'name=value\nother={{var}}' : req.bodyType === 'multipart' ? 'name=value\nfile=@/tmp/a.txt' : tr('原文')} className="font-mono text-[11.5px]" />}
                  {req.bodyType === 'multipart' && <div className="text-[10.5px] text-[var(--color-text-muted)]">{via === 'local' ? tr('文件字段写 key=@路径（本机文件，如 file=@C:/a.txt），其余写 key=值。') : tr('文件字段写 key=@路径（这台 SSH 主机上的文件），其余写 key=值。')}</div>}
                  {(req.method === 'GET' || req.method === 'HEAD') && req.bodyType !== 'none' && <div className="text-[10.5px] text-[var(--color-warn)]">{tr('{method} 请求不发送请求体', { method: req.method })}</div>}
                </div>}
              </div>
            </div>
            {/* 响应 */}
            <div className="flex min-h-0 flex-1 flex-col" data-api-response>
              {err && <div data-api-error className="shrink-0 whitespace-pre-wrap break-all border-b border-[var(--color-border-subtle)] px-3 py-2 text-[12px] text-[var(--color-danger)]">{err}</div>}
              {!res && !err && <div className="px-3 py-4 text-[12px] text-[var(--color-text-muted)]">{busy ? tr('请求中…') : tr('点「发送」后在这里看响应（状态码、耗时、响应头、响应体）。')}</div>}
              {res && <>
                <div className="flex shrink-0 items-center gap-3 border-b border-[var(--color-border-subtle)] px-3 py-1.5 text-[12px]">
                  <span data-api-status className={cn('font-mono font-semibold', statusCls(res.status))}>{res.status} {res.statusText}</span>
                  <span className="text-[var(--color-text-muted)]">{res.ms} ms</span>
                  <span className="text-[var(--color-text-muted)]">{res.truncated ? tr('{n} 字节（已截断）', { n: res.size ?? new Blob([res.body]).size }) : tr('{n} 字节', { n: res.size ?? new Blob([res.body]).size })}</span>
                  <span className="text-[var(--color-text-muted)]">{tr('从 {via} 发送', { via: tr(res.via) })}</span>
                  <span className="ml-auto" />
                  <button className={tabCls(resTab === 'body')} onClick={() => setResTab('body')}>{tr('响应体')}</button>
                  <button className={tabCls(resTab === 'headers')} onClick={() => setResTab('headers')}>{tr('响应头（{n}）', { n: res.headers.length })}</button>
                  {pretty?.json && <button title={tr('用 JSON 树查看（可复制 jq 路径）')} onClick={() => openTableView({ title: `${req.method} ${req.url}`, command: `${req.method} ${req.url}`, output: res.body })} className={BTN}><Braces className="h-3.5 w-3.5" />{tr('JSON 树')}</button>}
                  <button onClick={() => copy(resTab === 'body' ? res.body : res.headers.map(([k, v]) => `${k}: ${v}`).join('\n'), resTab === 'body' ? tr('已复制响应体（原始内容）') : tr('已复制响应头'))} className={BTN}><Copy className="h-3.5 w-3.5" />{tr('复制')}</button>
                </div>
                <div className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[11.5px] leading-relaxed">
                  {resTab === 'body'
                    ? <pre data-api-body-view className="whitespace-pre-wrap break-all text-[var(--color-text-primary)]">{pretty?.text || tr('（空）')}</pre>
                    : res.headers.map(([k, v], i) => <div key={i} className="break-all"><span className="text-[var(--color-accent)]">{k}</span><span className="text-[var(--color-text-muted)]">: </span><span className="text-[var(--color-text-primary)]">{v}</span></div>)}
                </div>
              </>}
            </div>
          </div>
        </div>
      </div>
      {curlIn !== null && (
        <div className="fixed inset-0 z-[72] flex items-center justify-center bg-black/40">
          <div className="w-[600px] rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-4 shadow-2xl">
            <div className="mb-2 text-[13px] font-semibold text-[var(--color-text-primary)]">{tr('从 curl 导入')}</div>
            <Textarea data-api-curl-text autoFocus value={curlIn} onChange={(e) => setCurlIn(e.target.value)} rows={8} spellCheck={false}
              placeholder={"curl -X POST https://example.com/api \\\n  -H 'Content-Type: application/json' \\\n  -d '{\"a\":1}'"} className="font-mono text-[11.5px]" />
            <div className="mt-3 flex justify-end gap-2">
              <button onClick={() => setCurlIn(null)} className="rounded-md border border-[var(--color-border-default)] px-4 py-1.5 text-[12.5px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">{tr('取消')}</button>
              <button data-api-curl-ok onClick={importCurl} disabled={!curlIn.trim()} className="rounded-md border border-transparent bg-[var(--color-accent)] px-4 py-1.5 text-[12.5px] font-medium text-[var(--color-bg-base)] hover:opacity-90 disabled:opacity-40">{tr('导入')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
