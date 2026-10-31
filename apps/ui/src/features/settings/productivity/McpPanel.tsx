import { useEffect, useState, useCallback } from 'react'
import { Pencil, Trash2, Plus, ChevronRight, X, Loader2, PlugZap } from 'lucide-react'
import { tk, tr, type McpServerSummary, type McpServerInput, type McpServerStatus, type McpToolInfo } from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { ConfirmDialog } from '../../common/index.js'
import { Switch } from '../../../components/ui/Switch.js'
import { Sel } from '../../../components/ui/form.js'
import { Page, Section, Row, SaveBar, HelpTip, INPUT, BTN2, taCls, BTN1, ICON_BTN, ICON_DEL, Toolbar, EmptyState, BackLink, errText } from '../ui.js'
import { PasswordInput } from '../../../components/ui/PasswordInput.js'

const STATE: Record<McpServerStatus['state'], { text: string; color: string }> = {
  connected: { text: tk('已连接'), color: 'var(--color-success)' },
  connecting: { text: tk('连接中'), color: 'var(--color-accent)' },
  failed: { text: tk('失败'), color: 'var(--color-danger)' },
  disabled: { text: tk('已停用'), color: 'var(--color-text-muted)' },
}

// 键值行：saved=已存的键（值在主进程，UI 拿不到；留空 = 沿用）
interface KvRow { key: string; value: string; saved: boolean }
const rowsOf = (keys: string[]): KvRow[] => keys.map((key) => ({ key, value: '', saved: true }))
const recordOf = (rows: KvRow[]): Record<string, string | null> =>
  Object.fromEntries(rows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value ? r.value : r.saved ? null : '']))

interface Form { id?: string; name: string; enabled: boolean; transport: 'stdio' | 'http'; command: string; args: string; cwd: string; url: string; env: KvRow[]; headers: KvRow[] }
const empty: Form = { name: '', enabled: true, transport: 'stdio', command: '', args: '', cwd: '', url: '', env: [], headers: [] }
const toInput = (f: Form): McpServerInput => ({
  id: f.id, name: f.name.trim(), enabled: f.enabled, transport: f.transport,
  ...(f.transport === 'stdio'
    ? { command: f.command.trim(), args: f.args.split('\n').map((s) => s.trim()).filter(Boolean), cwd: f.cwd.trim() || undefined, env: recordOf(f.env) }
    : { url: f.url.trim(), headers: recordOf(f.headers) }),
})

const PAGE_TIP = tk('接入 MCP 服务后，AI 可以调用它提供的工具（查监控、查数据库、建工单…）。外部工具可能有副作用，默认每次调用都弹授权卡，显示服务、工具和参数；只有你逐个打开「免确认」的工具才直接执行。只读信任档与定时巡检只能用免确认的工具。每次调用都记入执行记录。')
const SECRET_TIP = tk('值经系统密钥链加密保存，界面上看不到；编辑时留空表示沿用已存的值，填了就替换。')

// 设置弹窗「MCP 服务」页：增删改/启停/连接测试；已连上的服务展开可逐个把工具标为「免确认」
export function McpPanel() {
  const [list, setList] = useState<McpServerSummary[] | null>(null)
  const [status, setStatus] = useState<McpServerStatus[]>([])
  const [form, setForm] = useState<Form | null>(null)
  const [open, setOpen] = useState<string>()
  const [delTarget, setDelTarget] = useState<McpServerSummary | null>(null)
  const [err, setErr] = useState('')
  const [test, setTest] = useState<{ busy?: boolean; error?: string; tools?: McpToolInfo[] }>()

  const refresh = useCallback(() => {
    client.mcp.list().then(setList).catch(() => setList([]))
    client.mcp.status().then(setStatus).catch(() => {})
  }, [])
  useEffect(() => {
    refresh()
    return client.on((ev) => { if (ev.type === 'mcp:status') setStatus(ev.servers) })
  }, [refresh])

  const save = async (input: McpServerInput) => {
    try { await client.mcp.save(input); setForm(null); setErr(''); setTest(undefined); refresh() }
    catch (e) { setErr(errText(e)) }
  }
  const runTest = async (f: Form) => {
    setTest({ busy: true })
    try {
      const r = await client.mcp.test(toInput(f))
      setTest(r.ok ? { tools: r.tools ?? [] } : { error: r.error })
    } catch (e) { setTest({ error: errText(e) }) }
  }
  const toggleAuto = (s: McpServerSummary, tool: string, on: boolean) => {
    const next = on ? [...(s.autoApprove ?? []), tool] : (s.autoApprove ?? []).filter((t) => t !== tool)
    setList((l) => l && l.map((x) => (x.id === s.id ? { ...x, autoApprove: next } : x)))
    client.mcp.setAutoApprove(s.id, next).catch((e) => setErr(errText(e)))
  }
  const doDelete = () => { if (delTarget) client.mcp.delete(delTarget.id).then(refresh).catch((e) => setErr(errText(e))); setDelTarget(null) }
  const create = () => { setForm({ ...empty }); setErr(''); setTest(undefined) }

  if (form) {
    const set = (p: Partial<Form>) => { setForm({ ...form, ...p }); setTest(undefined) }
    const ready = !!form.name.trim() && (form.transport === 'stdio' ? !!form.command.trim() : !!form.url.trim())
    const stdio = form.transport === 'stdio'
    return (
      <Page>
        <BackLink onClick={() => { setForm(null); setErr(''); setTest(undefined) }}>{tr('返回 MCP 服务列表')}</BackLink>
        <Section title={form.id ? tr('编辑服务') : tr('添加服务')}>
          <Row label={tr('名称')}><input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder={tr('如：grafana、工单系统')} className={`w-64 ${INPUT}`} /></Row>
          <Row label={tr('连接方式')} tip={tr('本机命令：在本机启动一个进程，通过标准输入输出通信（npx、uvx、node 等）。远程 HTTP：连接已部署的 MCP 服务，先试 Streamable HTTP，连不上自动试 SSE。')}>
            <div className="w-48">
              <Sel value={form.transport} onChange={(v) => set({ transport: v as Form['transport'] })}>
                <option value="stdio">{tr('本机命令（stdio）')}</option>
                <option value="http">{tr('远程 HTTP / SSE')}</option>
              </Sel>
            </div>
          </Row>
          {stdio ? (
            <>
              <Row label={tr('启动命令')} wide><input value={form.command} onChange={(e) => set({ command: e.target.value })} placeholder={tr('如：npx、uvx、node、C:\\tools\\server.exe')} className={`w-full font-mono ${INPUT}`} /></Row>
              <Row label={tr('参数')} hint={tr('每行一个')} wide>
                <textarea value={form.args} onChange={(e) => set({ args: e.target.value })} rows={3} className={`${taCls} font-mono`} placeholder={'-y\n@modelcontextprotocol/server-postgres\npostgresql://localhost/mydb'} />
              </Row>
              <Row label={tr('环境变量')} hint={tr('值加密存储')} tip={tr(SECRET_TIP)} wide><KvEditor rows={form.env} onChange={(env) => set({ env })} keyHint="API_TOKEN" /></Row>
              <Row label={tr('工作目录')} hint={tr('可选')}><input value={form.cwd} onChange={(e) => set({ cwd: e.target.value })} className={`w-72 ${INPUT}`} /></Row>
            </>
          ) : (
            <>
              <Row label="URL" wide tip={tr('Streamable HTTP 地址；连不上会自动改用 SSE。')}>
                <input value={form.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://mcp.example.com/mcp" className={`w-full font-mono ${INPUT}`} />
              </Row>
              <Row label={tr('请求头')} hint={tr('值加密存储')} tip={tr(SECRET_TIP)} wide><KvEditor rows={form.headers} onChange={(headers) => set({ headers })} keyHint="Authorization" /></Row>
            </>
          )}
          <Row label={tr('启用')} hint={tr('停用后 AI 不能使用它的工具')}><Switch checked={form.enabled} onCheckedChange={(v) => set({ enabled: v })} /></Row>
        </Section>
        <Section title={tr('连接测试')} tip={tr('按当前填写的内容试连一次并列出工具，不保存。首次用 npx / uvx 可能要先下载，会慢一些。')}
          actions={<button onClick={() => runTest(form)} disabled={!ready || test?.busy} className={`flex items-center gap-1 ${BTN2}`}><PlugZap className="h-3.5 w-3.5" />{tr('连接测试')}</button>}>
          <div className="px-3.5 py-2.5 text-[12px]">
            {!test ? <span className="text-[var(--color-text-muted)]">{tr('填好后点「连接测试」检查能否连上')}</span>
              : test.busy ? <span className="flex items-center gap-1.5 text-[var(--color-text-muted)]"><Loader2 className="h-3.5 w-3.5 animate-spin" />{tr('连接中…')}</span>
              : test.error ? <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all text-[11px] text-[var(--color-danger)]">{tr('连接失败：{error}', { error: test.error })}</pre>
              : <ToolList tools={test.tools ?? []} title={tr('连接成功，共 {n} 个工具', { n: test.tools?.length ?? 0 })} />}
          </div>
        </Section>
        <SaveBar onSave={() => save(toInput(form))} disabled={!ready} msg={err ? { ok: false, text: err } : null} />
      </Page>
    )
  }

  const edit = (s: McpServerSummary) => { setErr(''); setTest(undefined); setForm({
    id: s.id, name: s.name, enabled: s.enabled, transport: s.transport, command: s.command ?? '', args: (s.args ?? []).join('\n'),
    cwd: s.cwd ?? '', url: s.url ?? '', env: rowsOf(s.envKeys), headers: rowsOf(s.headerKeys),
  }) }
  const addBtn = <button onClick={create} className={BTN1}><Plus className="h-3.5 w-3.5" />{tr('添加服务')}</button>
  return (
    <Page>
      <Toolbar hint={tr('接入后 AI 可调用这些服务提供的工具')} tip={tr(PAGE_TIP)}>{addBtn}</Toolbar>
      {!list ? null : list.length === 0 ? <EmptyState text={tr('还没有接入 MCP 服务')} action={addBtn} /> : (
        <div className="space-y-2">
          {list.map((s) => {
            const st = status.find((x) => x.id === s.id)
            const state = STATE[st?.state ?? (s.enabled ? 'connecting' : 'disabled')]
            const isOpen = open === s.id
            return (
              <div key={s.id} data-mcp-card={s.name} className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] text-[12.5px]">
                <div className="flex items-center gap-2.5 px-3.5 py-2.5">
                  <button onClick={() => setOpen(isOpen ? undefined : s.id)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left" title={isOpen ? tr('收起工具列表') : tr('展开工具列表')}>
                    <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)] transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: state.color }} title={tr(state.text)} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate font-medium text-[var(--color-text-primary)]">{s.name}</span>
                        <span className="shrink-0 text-[11px]" style={{ color: state.color }}>{tr(state.text)}</span>
                        {st?.state === 'connected' && <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">{tr('{n} 个工具', { n: st.tools.length })}</span>}
                      </span>
                      <span className="block truncate font-mono text-[11px] text-[var(--color-text-muted)]">{s.transport === 'stdio' ? [s.command, ...(s.args ?? [])].join(' ') : s.url}</span>
                    </span>
                  </button>
                  <Switch checked={s.enabled} onCheckedChange={(v) => save({ id: s.id, name: s.name, enabled: v, transport: s.transport, command: s.command, args: s.args, cwd: s.cwd, url: s.url })} title={s.enabled ? tr('已启用') : tr('已停用')} />
                  <button onClick={() => edit(s)} title={tr('编辑')} className={ICON_BTN}><Pencil className="h-3 w-3" /></button>
                  <button onClick={() => setDelTarget(s)} title={tr('删除')} className={ICON_DEL}><Trash2 className="h-3 w-3" /></button>
                </div>
                {isOpen && (
                  <div className="border-t border-[var(--color-border-subtle)] px-3.5 py-2.5">
                    {st?.error && <pre className="mb-1.5 max-h-24 overflow-auto whitespace-pre-wrap break-all text-[11px] text-[var(--color-danger)]">{st.error}</pre>}
                    {st?.tools.length
                      ? <ToolList tools={st.tools} title={tr('打开「免确认」的工具调用时不弹授权卡')} tip={tr('只读信任档、定时巡检里也只能用免确认的工具。')} auto={s.autoApprove ?? []} onToggle={(t, on) => toggleAuto(s, t, on)} />
                      : <div className="text-[11px] text-[var(--color-text-muted)]">{st?.state === 'connected' ? tr('该服务没有提供工具') : tr('连上后在这里显示工具列表')}</div>}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      {err && <div className="text-[12px] text-[var(--color-danger)]">{err}</div>}
      <ConfirmDialog open={!!delTarget} title={tr('删除 MCP 服务')} message={tr('确定删除 {name}？AI 将不能再使用它的工具。', { name: delTarget?.name ?? '' })} onConfirm={doDelete} onCancel={() => setDelTarget(null)} />
    </Page>
  )
}

function ToolList({ tools, title, tip, auto, onToggle }: { tools: McpToolInfo[]; title: string; tip?: string; auto?: string[]; onToggle?: (tool: string, on: boolean) => void }) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">{title}{tip && <HelpTip>{tip}</HelpTip>}</div>
      <div className="max-h-56 space-y-0.5 overflow-auto">
        {tools.map((t) => (
          <div key={t.name} className="flex items-center gap-2 rounded px-1 py-1 hover:bg-[var(--color-bg-hover)]">
            <code className="shrink-0 font-mono text-[11px] text-[var(--color-text-primary)]">{t.name}</code>
            <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-muted)]" title={t.description}>{t.description}</span>
            {onToggle && (
              <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[11px] text-[var(--color-text-secondary)]">
                {tr('免确认')}<Switch checked={auto?.includes(t.name) ?? false} onCheckedChange={(v) => onToggle(t.name, v)} />
              </label>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// 键值编辑：已存的值看不到，显示占位「已保存」，留空即沿用；填了就替换
function KvEditor({ rows, onChange, keyHint }: { rows: KvRow[]; onChange: (rows: KvRow[]) => void; keyHint: string }) {
  const put = (i: number, p: Partial<KvRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...p } : r)))
  return (
    <div className="space-y-1.5">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input value={r.key} onChange={(e) => put(i, { key: e.target.value })} placeholder={keyHint} className={`w-44 font-mono ${INPUT}`} />
          <PasswordInput value={r.value} onChange={(e) => put(i, { value: e.target.value })} placeholder={r.saved ? tr('已保存（留空沿用）') : tr('值')} className={`min-w-0 flex-1 font-mono ${INPUT}`} />
          <button onClick={() => onChange(rows.filter((_, j) => j !== i))} title={tr('删除')} className={ICON_BTN}><X className="h-3 w-3" /></button>
        </div>
      ))}
      <button onClick={() => onChange([...rows, { key: '', value: '', saved: false }])} className="flex items-center gap-1 text-[11.5px] text-[var(--color-text-secondary)] hover:text-[var(--color-accent)]"><Plus className="h-3 w-3" />{tr('添加')}</button>
    </div>
  )
}
