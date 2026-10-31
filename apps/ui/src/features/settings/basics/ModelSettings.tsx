import { useCallback, useEffect, useRef, useState } from 'react'
import { Cpu, Pencil, Trash2, Plus, Copy, Star, Loader2, CheckCircle2, XCircle, AlertTriangle, Info } from 'lucide-react'
import { PROVIDERS, providerMeta, contextWindowOf, protocolOf, endpointBaseOf, multimodalDefault, tr, dateLocale, type ModelProfile, type ModelProtocol, type ModelTestResult } from '@lingshell/shared'
import { NumberInput } from '../../../components/ui/NumberInput.js'
import { Switch } from '../../../components/ui/Switch.js'
import { client } from '../../../client/index.js'
import { logger } from '../../../lib/logger.js'
import { ConfirmDialog } from '../../common/index.js'
import { Sel } from '../../../components/ui/form.js'
import { Combobox } from '../../../components/ui/Combobox.js'
import { BTN2, HelpTip, INPUT, Page, Row, SaveBar, Section, BTN1, ICON_BTN, ICON_DEL, LIST, ITEM, Toolbar, BackLink, errText } from '../ui.js'
import { notifyModelProfilesChanged } from '../../../lib/modelProfiles.js'
import { PasswordInput } from '../../../components/ui/PasswordInput.js'
import { DELAY_QUICK, DELAY_TEXT, profileError } from '../autoSave.js'
import { useAutoSave } from '../useAutoSave.js'
import { trx } from '../../../lib/trx.js'

const log = logger.scope('settings')
const newId = () => `mp_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`
const PROTOCOL_TAG: Record<ModelProtocol, string> = { anthropic: 'Anthropic', openai: 'OpenAI' }
const protocolTip = () => tr('Anthropic Messages：请求发到「地址/v1/messages」，Key 放 x-api-key 请求头；DeepSeek 官方地址（https://api.deepseek.com/anthropic）原生支持，推荐。')
  + tr('OpenAI 兼容：请求发到「地址/chat/completions」，Key 放 Authorization: Bearer；适合只支持 OpenAI 格式的自建 / 第三方网关。')
  + tr('API 地址填 DeepSeek 官方地址时会按协议自动修正（Anthropic → https://api.deepseek.com/anthropic，OpenAI → https://api.deepseek.com），自定义地址原样使用。')
  + tr('其它提供商（千问、Kimi、Ollama、OpenAI 兼容端点）固定走 OpenAI 兼容。改了协议，用这套配置的会话从下一回合起按新协议请求，历史对话保留。')
type Form = ModelProfile & { apiKey: string; isNew?: boolean; savedProvider?: string; keyFromName?: string }

// 设置 → 模型设置：多套模型配置（列表 + 编辑表单）。默认配置用于新会话和一次性调用（自然语言写命令、命令解释等）；
// 会话里点对话区顶部的模型名切换。Key 每套单独加密存，只进不出（渲染层只拿 hasApiKey）。
export function ModelSettings({ onSaved }: { onSaved?: () => void }) {
  const [list, setList] = useState<ModelProfile[] | null>(null)
  const [defaultId, setDefaultId] = useState<string>()
  const [form, setForm] = useState<Form | null>(null)
  const [delTarget, setDelTarget] = useState<ModelProfile | null>(null)
  const [err, setErr] = useState('')
  const [saved, setSaved] = useState(false)

  const refresh = useCallback(() => client.settings.get().then((s) => { setList(s.modelProfiles ?? []); setDefaultId(s.defaultProfileId) }), [])
  useEffect(() => { void refresh() }, [refresh])

  // 整表保存（key 留空的由主进程按 id 保留）。notify=false：只改了名称 / 地址这类，不让外层重试启动会话（自动保存很频繁）
  const persist = async (profiles: ModelProfile[], def?: string, notify = true) => {
    const d = profiles.find((x) => x.id === def) ?? profiles[0]
    await client.settings.save({ provider: d.provider, model: d.model, baseUrl: d.baseUrl, modelProfiles: profiles, defaultProfileId: d.id })
    log.info('model profiles saved', { count: profiles.length, default: d.id })
    await refresh()
    notifyModelProfilesChanged()
    if (notify) onSaved?.()
  }
  // 编辑已有配置：改了自动保存。以主进程最新的整表为准只替换这一套（免得用本页旧列表覆盖别处的改动）；
  // Key 只在离开输入框后才随保存发出（见 useAutoSave 的 typingSecret），存完清空输入框改显示「已配置」
  const autoSave = async (f: Form) => {
    const { isNew: _n, savedProvider, keyFromName: _k, ...p } = f
    const next: ModelProfile = { ...p, name: p.name.trim() || p.model.trim(), model: p.model.trim(), baseUrl: p.baseUrl.trim(), apiKey: p.apiKey || undefined }
    const s = await client.settings.get()
    const providerChanged = savedProvider !== next.provider
    await persist((s.modelProfiles ?? []).map((x) => (x.id === next.id ? next : x)), s.defaultProfileId, !!next.apiKey || providerChanged)
    setForm((c) => c && c.id === next.id ? {
      ...c, savedProvider: next.provider, apiKey: c.apiKey === f.apiKey ? '' : c.apiKey,
      hasApiKey: next.apiKey ? true : providerChanged ? false : c.hasApiKey, keyFrom: providerChanged ? undefined : c.keyFrom,
    } : c)
  }

  const create = () => {
    const p = PROVIDERS[0]
    setForm({ id: newId(), name: '', provider: p.id, model: p.models[0].id, baseUrl: p.defaultBaseUrl, contextWindow: 0, protocol: protocolOf(p.id), multimodal: multimodalDefault(p.id, p.models[0].id), apiKey: '', isNew: true }); setErr('')
  }
  const copy = (x: ModelProfile) => {
    setForm({ ...x, id: newId(), name: tr('{name} 副本', { name: x.name }), apiKey: '', isNew: true, hasApiKey: false, savedProvider: x.provider, ...(x.hasApiKey ? { keyFrom: x.id, keyFromName: x.name } : {}) }); setErr('')
  }
  const edit = (x: ModelProfile) => { setForm({ ...x, apiKey: '', savedProvider: x.provider }); setErr('') }
  const saveForm = async () => {
    if (!form || !list) return
    const { isNew, savedProvider: _s, keyFromName: _k, ...p } = form
    const next: ModelProfile = { ...p, name: p.name.trim() || p.model.trim(), model: p.model.trim(), baseUrl: p.baseUrl.trim(), apiKey: p.apiKey || undefined }
    try {
      await persist(isNew ? [...list, next] : list.map((x) => (x.id === next.id ? next : x)), defaultId)
      setForm(null); setErr(''); setSaved(true); setTimeout(() => setSaved(false), 2000)
    } catch (e) { setErr(errText(e)) }
  }
  const setDefault = (id: string) => { if (list) persist(list, id).catch((e) => setErr(errText(e))) }
  const doDelete = () => {
    if (list && delTarget) persist(list.filter((x) => x.id !== delTarget.id), defaultId).catch((e) => setErr(errText(e)))
    setDelTarget(null)
  }

  if (form) return <ProfileForm form={form} setForm={setForm} onCreate={() => void saveForm()} onAutoSave={autoSave} onBack={() => { setForm(null); setErr('') }} err={err} />
  if (!list) return <div className="text-[13px] text-[var(--color-text-muted)]">{tr('加载中…')}</div>
  const def = list.find((x) => x.id === defaultId)
  return (
    <Page>
      <Toolbar hint={def ? <>{trx('新会话用默认配置：{name}', { name: <b className="font-medium text-[var(--color-text-primary)]">{tr(def.name)}</b> })}</> : tr('新会话用默认配置')}
        tip={tr('可以配多套模型（不同提供商、同一家不同 Key 或不同模型）。默认配置用于新建的会话，以及自然语言写命令、命令解释这类一次性调用；已有会话可点对话区顶部的模型名单独切换，切换只影响该会话。')}>
        <button onClick={create} className={BTN1}><Plus className="h-3.5 w-3.5" />{tr('新建配置')}</button>
      </Toolbar>
      <div className={LIST}>
        {list.map((x) => {
          const meta = providerMeta(x.provider)
          const isDef = x.id === defaultId
          return (
            <div key={x.id} className={`${ITEM} cursor-pointer hover:bg-[var(--color-bg-hover)]`} onClick={() => edit(x)}>
              <Cpu className={`h-3.5 w-3.5 shrink-0 ${isDef ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'}`} />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-1.5">
                  <span className="truncate font-medium text-[var(--color-text-primary)]">{tr(x.name)}</span>
                  {isDef && <span className="shrink-0 rounded bg-[color:color-mix(in_srgb,var(--color-accent)_15%,transparent)] px-1.5 text-[10.5px] text-[var(--color-accent)]">{tr('默认')}</span>}
                  <span title={tr('接口协议')} className="shrink-0 rounded border border-[var(--color-border-default)] px-1.5 text-[10.5px] text-[var(--color-text-muted)]">{PROTOCOL_TAG[protocolOf(x.provider, x.protocol)]}</span>
                  {x.multimodal && <span data-tag-image title={tr('支持图片（多模态）：对话里可以附图片')} className="shrink-0 rounded border border-[color:color-mix(in_srgb,var(--color-accent)_40%,transparent)] px-1.5 text-[10.5px] text-[var(--color-accent)]">{tr('图片')}</span>}
                </span>
                <span className="truncate text-[11px] text-[var(--color-text-muted)]">{tr(meta.label)} · {x.model}</span>
              </div>
              <span className={`shrink-0 text-[11px] ${x.hasApiKey || !meta.needsApiKey ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-warn)]'}`}>
                {x.hasApiKey ? tr('Key 已配置') : meta.needsApiKey ? tr('未配置 Key') : tr('无需 Key')}
              </span>
              <span className="flex shrink-0 items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
                <button onClick={() => setDefault(x.id)} disabled={isDef} title={isDef ? tr('已是默认') : tr('设为默认')} className={ICON_BTN}><Star className={`h-3 w-3 ${isDef ? 'fill-current text-[var(--color-accent)]' : ''}`} /></button>
                <button onClick={() => edit(x)} title={tr('编辑')} className={ICON_BTN}><Pencil className="h-3 w-3" /></button>
                <button onClick={() => copy(x)} title={tr('复制')} className={ICON_BTN}><Copy className="h-3 w-3" /></button>
                <button onClick={() => setDelTarget(x)} disabled={list.length <= 1} title={list.length <= 1 ? tr('至少保留一套配置') : tr('删除')} className={ICON_DEL}><Trash2 className="h-3 w-3" /></button>
              </span>
            </div>
          )
        })}
      </div>
      {(err || saved) && <div className={`text-[12px] ${err ? 'text-[var(--color-danger)]' : 'text-[var(--color-success)]'}`}>{err || tr('已保存')}</div>}
      <ConfirmDialog open={!!delTarget} title={tr('删除模型配置')} message={tr('确定删除「{name}」？正在用它的会话会改用默认配置。', { name: delTarget?.name ?? '' })} onConfirm={doDelete} onCancel={() => setDelTarget(null)} />
    </Page>
  )
}

function ProfileForm({ form, setForm, onCreate, onAutoSave, onBack, err }: {
  form: Form; setForm: (f: Form) => void; onCreate: () => void; onAutoSave: (f: Form) => Promise<void>; onBack: () => void; err: string
}) {
  const [test, setTest] = useState<ModelTestResult | 'running' | null>(null)
  const meta = providerMeta(form.provider)
  const cur = useRef(form)   // 最新值（同步更新，flush 时不依赖渲染）
  cur.current = form
  // 新建的配置点「创建」才存；已有配置改了自动保存（返回列表 / 关弹窗时立即保存）
  const auto = useAutoSave({ validate: () => profileError(cur.current, providerMeta(cur.current.provider).needsApiKey), save: () => onAutoSave(cur.current) })
  const set = (patch: Partial<Form>, delay = DELAY_TEXT) => {
    cur.current = { ...cur.current, ...patch }
    setForm(cur.current); setTest(null)
    if (!cur.current.isNew) auto.schedule(delay)
  }
  // 已存的 key 只在提供商没换时沿用（主进程同规则）
  const keptKey = form.provider === form.savedProvider && (form.hasApiKey || !!form.keyFrom)
  const keyHint = form.apiKey ? (form.isNew ? undefined : tr('离开输入框后自动保存'))
    : keptKey ? (form.keyFrom ? tr('沿用「{name}」的 Key，留空则不修改', { name: String(form.keyFromName) }) : tr('已配置，留空则不修改'))
      : form.savedProvider && form.savedProvider !== form.provider && (form.hasApiKey || form.keyFrom) ? tr('换了提供商，需重新填写 Key')
        : meta.needsApiKey ? undefined : tr('本地服务可不填')
  const autoWindow = contextWindowOf(form.provider, form.model)
  const isDs = form.provider === 'deepseek'
  const protocol = protocolOf(form.provider, form.protocol)
  // f：「改用 OpenAI 兼容并重试」时传入刚改过协议的表单（setForm 还没生效）
  const runTest = async (f: Form = form) => {
    setTest('running')
    const { isNew: _n, savedProvider: _s, keyFromName: _k, ...p } = f
    try { setTest(await client.modelProfiles.test({ ...p, apiKey: p.apiKey || undefined })) }
    catch (e) { setTest({ ok: false, error: errText(e) }) }
  }
  const switchToOpenAi = () => { set({ protocol: 'openai' }, DELAY_QUICK); void runTest(cur.current) }
  return (
    <Page onBlur={auto.onBlur}>
      <BackLink onClick={onBack}>{tr('返回配置列表')}</BackLink>
      <Section title={form.isNew ? tr('新建模型配置') : tr('编辑「{name}」', { name: form.name || form.model })} tip={form.isNew ? tr('填好后点「创建」，之后再改就是自动保存。') : tr('改了自动保存（API Key 在离开输入框时才保存），用这套配置的会话从下一回合起按新设置请求；正在进行的回合不受影响。')}>
        <Row label={tr('名称')} hint={tr('在模型菜单里显示')}>
          <input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder={form.model || tr('如：DeepSeek 官方')} className={`${INPUT} w-60`} />
        </Row>
        <Row label={tr('提供商')}>
          <div className="w-60"><Sel value={form.provider} onChange={(v) => { const np = providerMeta(v); set({ provider: np.id, model: np.models[0].id, baseUrl: np.defaultBaseUrl, contextWindow: 0, protocol: protocolOf(np.id), multimodal: multimodalDefault(np.id, np.models[0].id) }, DELAY_QUICK) }}>{PROVIDERS.map((p) => <option key={p.id} value={p.id}>{tr(p.label)}</option>)}</Sel></div>
        </Row>
        <Row label={tr('接口协议')} hint={isDs ? undefined : tr('该提供商固定走 OpenAI 兼容')} tip={protocolTip()}>
          {isDs
            ? <div className="w-60"><Sel value={protocol} onChange={(v) => set({ protocol: v as ModelProtocol }, DELAY_QUICK)}>
              <option value="anthropic">{tr('Anthropic Messages（推荐，官方支持）')}</option>
              <option value="openai">{tr('OpenAI 兼容（Chat Completions）')}</option>
            </Sel></div>
            : <span className="text-[12px] text-[var(--color-text-muted)]">{tr('OpenAI 兼容（Chat Completions）')}</span>}
        </Row>
        {isDs && (
          <div className="px-3.5 py-2">
            <div className="flex items-start gap-2 rounded-md border border-[color:color-mix(in_srgb,var(--color-accent)_35%,transparent)] bg-[color:color-mix(in_srgb,var(--color-accent)_8%,transparent)] px-2.5 py-2 text-[11.5px] leading-[1.6] text-[var(--color-text-secondary)]">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
              <span className="flex-1">{tr('DeepSeek 默认通过 Anthropic Messages 协议调用（官方地址已支持）。如果你用的是自建或第三方网关且只支持 OpenAI 格式，请把接口协议改为「OpenAI 兼容」。')}</span>
              <HelpTip className="mt-0.5">{protocolTip()}</HelpTip>
            </div>
          </div>
        )}
        <Row label={tr('模型')} tip={form.provider === 'ollama' ? tr('填本地模型名，如 qwen3:8b；模型需支持工具调用。') : tr('传给接口的模型 id。')}>
          <div className="w-60">{meta.freeModel
            ? <Combobox value={form.model} onChange={(v) => set({ model: v, multimodal: multimodalDefault(form.provider, v) })} options={meta.models.map((m) => m.id)} placeholder={form.provider === 'ollama' ? tr('如 qwen3:8b') : tr('模型 id')} />
            : <Sel value={form.model} onChange={(v) => set({ model: v, multimodal: multimodalDefault(form.provider, v) }, DELAY_QUICK)}>{meta.models.map((m) => <option key={m.id} value={m.id}>{tr(m.label)}</option>)}</Sel>}</div>
        </Row>
        <Row label={tr('支持图片')} hint={tr('多模态：对话里可以附图片')}
          tip={tr('开了才能在对话里附图片（输入框「+」→「图片…」、Ctrl+V 粘贴截图、拖入图片），图片作为多模态内容随消息发给模型。按模型名给默认值：已知支持视觉的（如 gpt-4o、qwen-vl、glm-4v、llava、DeepSeek V4.1 Flash）默认开，其它默认关；换模型会重新按默认值设置。开了但模型其实不支持图片时，带图片的请求会被接口报错。')}>
          <Switch checked={!!form.multimodal} onCheckedChange={(v) => set({ multimodal: v }, DELAY_QUICK)} aria-label={tr('支持图片')} />
        </Row>
        <Row label={tr('API 地址')} hint={isDs ? tr('实际请求 {url}', { url: `${endpointBaseOf(form)}${protocol === 'anthropic' ? '/v1/messages' : '/chat/completions'}` }) : tr('Base URL，留空用提供商默认')}>
          <input value={form.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} spellCheck={false} placeholder={meta.defaultBaseUrl} className={`${INPUT} w-72`} />
        </Row>
        <Row label="API Key" hint={keyHint}
          tip={tr('每套配置的 Key 单独保存在本机数据目录：系统密钥链可用时加密存储、不以明文落盘；系统密钥链不可用时（部分 Linux）退化为明文，仅本机用户可读。界面读不回明文。换了提供商的配置不会沿用原来的 Key（避免把 A 家的 Key 发给 B 家）。「复制」出来的配置沿用原配置的 Key。')}>
          <PasswordInput value={form.apiKey} onChange={(e) => set({ apiKey: e.target.value })} className={`${INPUT} w-72`}
            placeholder={keptKey ? tr('••••••••（输入以替换）') : meta.needsApiKey ? tr('输入 API Key') : tr('可不填')} />
        </Row>
        <Row label={tr('上下文窗口')} hint={tr('{window} · 自动压缩阈值 {threshold}', {
          window: form.contextWindow ? 'tokens' : tr('tokens，0 = 自动（{n}）', { n: autoWindow.toLocaleString(dateLocale()) }),
          threshold: Math.min(600_000, Math.floor((form.contextWindow || autoWindow) * 0.6)).toLocaleString(dateLocale()),
        })}
          tip={tr('填 0 = 按模型自动。对话上下文超过「自动压缩阈值」时，自动把较早的对话压缩成摘要、任务不中断。阈值 = 上下文窗口的 60%，最多 600K，不用单独设置。')}>
          <NumberInput className="w-36" value={form.contextWindow ?? 0} min={0} max={2_000_000} step={1024} onChange={(n) => set({ contextWindow: n })} />
        </Row>
        <Row label={tr('测试连接')} hint={protocol === 'anthropic' ? tr('点了才发请求：按 Anthropic 协议发一个极小请求') : tr('点了才发请求：先查模型列表，查不到再发一个极小请求')}
          tip={tr('用表单当前的地址、模型、Key 和接口协议测试（Key 留空用已存的），不会自动测试。OpenAI 兼容：先请求 /models（不耗 token），端点不提供模型列表时发一条 1 token 的对话请求。Anthropic Messages：向 /v1/messages 发一条 1 token 的请求；返回 404 / 405 或格式不对时，多半是这个地址不支持 Anthropic 协议，可一键改用 OpenAI 兼容并重试。')}>
          <TestResult r={test} />
          {isDs && protocol === 'anthropic' && test !== 'running' && test?.protocolMismatch
            ? <button onClick={switchToOpenAi} className={BTN2}>{tr('改用 OpenAI 兼容并重试')}</button>
            : <button onClick={() => void runTest()} disabled={test === 'running'} className={BTN2}>{tr('测试连接')}</button>}
        </Row>
      </Section>
      {form.isNew && <SaveBar onSave={onCreate} label={tr('创建')} disabled={!form.model.trim()} msg={err ? { ok: false, text: err } : null} />}
    </Page>
  )
}

function TestResult({ r }: { r: ModelTestResult | 'running' | null }) {
  if (!r) return null
  if (r === 'running') return <span className="flex items-center gap-1 text-[11.5px] text-[var(--color-text-muted)]"><Loader2 className="h-3.5 w-3.5 animate-spin" />{tr('测试中…')}</span>
  const [Icon, color, text] = !r.ok ? [XCircle, 'var(--color-danger)', (r.error ? tr(r.error) : tr('失败'))] : r.warning ? [AlertTriangle, 'var(--color-warn)', tr(r.warning)] : [CheckCircle2, 'var(--color-success)', r.ms !== undefined ? tr('连接正常（{ms} ms）', { ms: r.ms }) : tr('连接正常')]
  return <span className="flex max-w-[300px] items-center gap-1 text-[11.5px]" style={{ color }} title={text}><Icon className="h-3.5 w-3.5 shrink-0" /><span className="line-clamp-2">{text}</span></span>
}
