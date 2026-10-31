import { useEffect, useRef, useState, useCallback } from 'react'
import { Pencil, Trash2, Plus, FolderOpen, Download, ChevronDown, Folder, FileArchive, Sparkles, AlertTriangle, X } from 'lucide-react'
import { tk, tr, type SkillInfo, type SkillImportPreview } from '@lingshell/shared'
import { trx } from '../../../lib/trx.js'
import { client } from '../../../client/index.js'
import { ConfirmDialog } from '../../common/index.js'
import { Switch } from '../../../components/ui/Switch.js'
import { Radio } from '../../../components/ui/Radio.js'
import { Page, Section, Row, SaveBar, INPUT, BTN2, taCls, BTN1, ICON_BTN, ICON_DEL, Toolbar, EmptyState, BackLink, errText } from '../ui.js'

const PAGE_TIP = tk('Skill 是一份可复用的任务指令（SKILL.md，可附带脚本、参考文档等资源文件）。AI 平时只看到每个 skill 的名称和描述，任务匹配时才加载完整指令；你也可以在输入框「+」→「Skills」里点名使用。Skill 正文只是给 AI 的提示词，不会自动执行包里的任何文件；AI 读取资源文件时照常经过授权与脱敏。改动立即生效，不用重启。')
const ORIGIN: Record<SkillInfo['origin'], string> = { imported: tk('skill|导入'), created: tk('skill|新建'), manual: tk('目录里放入') }
const NAME_HINT = tk('小写字母、数字和连字符，如 nginx-check')

interface Form { old?: string; name: string; description: string; body: string }
const empty: Form = { name: '', description: '', body: '' }

// 设置弹窗「Skills」页：导入（文件夹 / .zip / .skill）、新建、编辑、启停、「AI 可自动调用」、删除、打开目录
export function SkillsPanel() {
  const [list, setList] = useState<SkillInfo[] | null>(null)
  const [form, setForm] = useState<Form | null>(null)
  const [preview, setPreview] = useState<SkillImportPreview | null>(null)
  const [delTarget, setDelTarget] = useState<SkillInfo | null>(null)
  const [importMenu, setImportMenu] = useState(false)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')

  const refresh = useCallback(() => { client.skills.list().then(setList).catch(() => setList([])) }, [])
  useEffect(() => { refresh() }, [refresh])

  const pick = async (kind: 'folder' | 'file') => {
    setImportMenu(false); setErr(''); setMsg('')
    try { const p = await client.skills.pickImport(kind); if (p) setPreview(p) }
    catch (e) { setErr(tr('导入失败：{error}', { error: errText(e) })) }
  }
  const setFlag = (s: SkillInfo, flags: { enabled?: boolean; modelInvocable?: boolean }) => {
    setList((l) => l && l.map((x) => (x.dir === s.dir ? { ...x, ...flags } : x)))
    client.skills.setFlags(s.name, flags).catch((e) => { setErr(errText(e)); refresh() })
  }
  const edit = async (s: SkillInfo) => {
    setErr('')
    try { const r = await client.skills.read(s.name); setForm({ old: s.name, ...r }) }
    catch (e) { setErr(errText(e)) }
  }
  const doDelete = () => {
    if (delTarget) client.skills.remove(delTarget.name).then(refresh).catch((e) => setErr(errText(e)))
    setDelTarget(null)
  }

  if (form) {
    const set = (p: Partial<Form>) => setForm({ ...form, ...p })
    const save = async () => {
      try { await client.skills.save({ name: form.name.trim(), description: form.description, body: form.body }, form.old); setForm(null); setErr(''); refresh() }
      catch (e) { setErr(errText(e)) }
    }
    return (
      <Page>
        <BackLink onClick={() => { setForm(null); setErr('') }}>{tr('返回 Skills 列表')}</BackLink>
        <Section title={form.old ? tr('编辑 Skill') : tr('新建 Skill')} tip={tr('保存为 skills/<名称>/SKILL.md（frontmatter 写 name 和 description，下面是正文）。编辑时 SKILL.md 里的其它字段原样保留。')}>
          <Row label={tr('名称')} hint={tr(NAME_HINT)}>
            <input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="disk-check" className={`w-64 font-mono ${INPUT}`} />
          </Row>
          <Row label={tr('描述')} hint={tr('AI 靠它判断什么时候用')} wide tip={tr('会出现在 AI 看到的 skill 目录里（只有名称和描述）。写清楚做什么、什么情况下用，例如「排查 Linux 磁盘占用：找出大目录和大文件，给出清理建议」。')}>
            <input value={form.description} onChange={(e) => set({ description: e.target.value })} placeholder={tr('做什么、什么时候用')} className={`w-full ${INPUT}`} />
          </Row>
          <Row label={tr('指令正文')} hint={tr('Markdown，AI 加载后照做')} wide tip={tr('写步骤、注意事项、要用的命令。引用同目录的资源文件时写相对路径（如 scripts/check.sh），AI 会按 skill 目录去找。')}>
            <textarea value={form.body} onChange={(e) => set({ body: e.target.value })} rows={14} className={`${taCls} font-mono`}
              placeholder={tr('## 步骤\n1. df -h 看各分区使用率\n2. du -xh --max-depth=1 / | sort -h 找大目录\n\n## 注意\n- 只读排查，不要删除文件')} />
          </Row>
        </Section>
        <SaveBar onSave={save} disabled={!form.name.trim() || !form.description.trim()} msg={err ? { ok: false, text: err } : null} />
      </Page>
    )
  }

  const createBtn = <button onClick={() => { setForm({ ...empty }); setErr('') }} className={BTN1}><Plus className="h-3.5 w-3.5" />{tr('新建 Skill')}</button>
  return (
    <Page>
      <Toolbar hint={tr('AI 按需加载的任务指令包')} tip={tr(PAGE_TIP)}>
        <button onClick={() => client.skills.openDir().catch((e) => setErr(errText(e)))} className={`flex items-center gap-1 ${BTN2}`}><FolderOpen className="h-3.5 w-3.5" />{tr('打开 Skills 目录')}</button>
        <ImportMenu open={importMenu} setOpen={setImportMenu} onPick={pick} />
        {createBtn}
      </Toolbar>
      {!list ? null : list.length === 0 ? (
        <EmptyState text={tr('还没有 Skill')} action={<div className="flex gap-2"><button onClick={() => setImportMenu(true)} className={BTN2}>{tr('导入 Skill')}</button>{createBtn}</div>} />
      ) : (
        <div className="space-y-2">
          {list.map((s) => (
            <div key={s.dir} data-skill-card={s.name} className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-3.5 py-2.5 text-[12.5px]">
              <div className="flex items-center gap-2.5">
                <Sparkles className={`h-4 w-4 shrink-0 ${s.enabled && !s.error ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'}`} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate font-mono font-medium text-[var(--color-text-primary)]">{s.name}</span>
                    <span className="shrink-0 rounded border border-[var(--color-border-subtle)] px-1 text-[10.5px] text-[var(--color-text-muted)]">{tr(ORIGIN[s.origin])}</span>
                    {s.files.length > 0 && <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]" title={s.files.join('\n')}>{tr('{n} 个资源文件', { n: s.files.length })}</span>}
                    {!s.userInvocable && !s.error && <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]" title={tr('SKILL.md 里写了 user-invocable: false')}>{tr('不在「+」菜单')}</span>}
                  </span>
                  {s.error
                    ? <span className="flex items-center gap-1 text-[11px] text-[var(--color-danger)]"><AlertTriangle className="h-3 w-3 shrink-0" /><span className="truncate" title={s.error}>{s.error}</span></span>
                    : <span className="block truncate text-[11px] text-[var(--color-text-muted)]" title={s.description}>{s.description}</span>}
                </span>
                {!s.error && (
                  <>
                    <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[11px] text-[var(--color-text-secondary)]" title={tr('关掉后 AI 不会自己加载它，只能在「+」→「Skills」里点名使用')}>
                      {tr('AI 可自动调用')}<Switch checked={s.modelInvocable} disabled={!s.enabled} onCheckedChange={(v) => setFlag(s, { modelInvocable: v })} />
                    </label>
                    <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[11px] text-[var(--color-text-secondary)]" title={tr('停用的 skill 不提供给 AI，也不出现在「+」菜单')}>
                      {tr('启用')}<Switch checked={s.enabled} onCheckedChange={(v) => setFlag(s, { enabled: v })} />
                    </label>
                    <button onClick={() => edit(s)} title={tr('编辑')} className={ICON_BTN}><Pencil className="h-3 w-3" /></button>
                  </>
                )}
                <button onClick={() => setDelTarget(s)} title={tr('删除')} className={ICON_DEL}><Trash2 className="h-3 w-3" /></button>
              </div>
            </div>
          ))}
        </div>
      )}
      {err && <div className="text-[12px] text-[var(--color-danger)]">{err}</div>}
      {msg && <div className="text-[12px] text-[var(--color-success)]">{msg}</div>}
      {preview && <ImportDialog preview={preview} onClose={() => { void client.skills.cancelImport(preview.token).catch(() => {}); setPreview(null) }}
        onDone={(name) => { setPreview(null); setMsg(tr('已导入 {name}，立即生效', { name })); refresh() }} />}
      <ConfirmDialog open={!!delTarget} title={tr('删除 Skill')} message={tr('确定删除 {name}？会删除它的整个目录（含资源文件），不可恢复。', { name: delTarget?.name ?? '' })} onConfirm={doDelete} onCancel={() => setDelTarget(null)} />
    </Page>
  )
}

// 「导入 Skill」下拉：文件夹 / .zip、.skill 包
function ImportMenu({ open, setOpen, onPick }: { open: boolean; setOpen: (v: boolean) => void; onPick: (kind: 'folder' | 'file') => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open, setOpen])
  const ROW = 'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]'
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className={`flex items-center gap-1 ${BTN2}`}><Download className="h-3.5 w-3.5" />{tr('导入 Skill')}<ChevronDown className="h-3 w-3" /></button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-[210px] rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-1.5 shadow-2xl">
          <button onClick={() => onPick('folder')} className={ROW}><Folder className="h-4 w-4 text-[var(--color-text-muted)]" />{tr('从文件夹…')}</button>
          <button onClick={() => onPick('file')} className={ROW}><FileArchive className="h-4 w-4 text-[var(--color-text-muted)]" />{tr('从 .zip / .skill 包…')}</button>
        </div>
      )}
    </div>
  )
}

// 导入确认：SKILL.md 预览 + 包内文件清单；重名时选覆盖或改名
function ImportDialog({ preview, onClose, onDone }: { preview: SkillImportPreview; onClose: () => void; onDone: (name: string) => void }) {
  const [mode, setMode] = useState<'rename' | 'overwrite'>('rename')
  const [rename, setRename] = useState(preview.suggestedName)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const confirm = async () => {
    setBusy(true); setErr('')
    try {
      const name = await client.skills.commitImport(preview.token, preview.conflict ? (mode === 'overwrite' ? { overwrite: true } : { rename: rename.trim() }) : {})
      onDone(name)
    } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }
  // 捕获阶段拦下 Esc：只关导入框，别把下面的设置弹窗一起关了（同 ConfirmDialog）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50">
      <div data-skill-import className="flex max-h-[84vh] w-[min(680px,90vw)] flex-col overflow-hidden rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex h-11 shrink-0 items-center border-b border-[var(--color-border-subtle)] px-4">
          <span className="text-[13px] font-semibold text-[var(--color-text-primary)]">{trx('导入 Skill：{name}', { name: <span className="font-mono">{preview.name}</span> })}</span>
          <button onClick={onClose} className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"><X className="h-4 w-4" /></button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-[12.5px]">
          <div className="text-[var(--color-text-secondary)]">{preview.description}</div>
          <div className="text-[11px] text-[var(--color-text-muted)]">{tr('请确认内容可信：Skill 正文是给 AI 的指令，不会自动执行包里的任何文件。')}</div>
          {preview.conflict && (
            <div className="space-y-1.5 rounded-lg border border-[color:color-mix(in_srgb,var(--color-warn)_40%,transparent)] px-3 py-2">
              <div className="text-[var(--color-warn)]">{tr('已有同名 skill「{name}」', { name: preview.name })}</div>
              <label className="flex items-center gap-2"><Radio checked={mode === 'rename'} onSelect={() => setMode('rename')} />{tr('改名导入为')}
                <input value={rename} onChange={(e) => { setRename(e.target.value); setMode('rename') }} className={`w-48 font-mono ${INPUT}`} />
              </label>
              <label className="flex items-center gap-2"><Radio checked={mode === 'overwrite'} onSelect={() => setMode('overwrite')} />{tr('覆盖已有的（原目录会被替换）')}</label>
            </div>
          )}
          <div>
            <div className="mb-1 text-[11px] text-[var(--color-text-muted)]">SKILL.md</div>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] p-2.5 font-mono text-[11.5px] text-[var(--color-text-secondary)]">{preview.skillMd}</pre>
          </div>
          <div>
            <div className="mb-1 text-[11px] text-[var(--color-text-muted)]">{tr('包内文件（{n}）', { n: preview.files.length })}</div>
            <div className="max-h-36 overflow-auto rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] p-2 font-mono text-[11.5px] text-[var(--color-text-secondary)]">
              {preview.files.map((f) => <div key={f}>{f}</div>)}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 border-t border-[var(--color-border-subtle)] px-4 py-2.5">
          {err && <span className="min-w-0 truncate text-[12px] text-[var(--color-danger)]" title={err}>{err}</span>}
          <button onClick={onClose} className={`ml-auto ${BTN2}`}>{tr('取消')}</button>
          <button onClick={confirm} disabled={busy || (preview.conflict && mode === 'rename' && !rename.trim())} className={BTN1}>{tr('确认导入')}</button>
        </div>
      </div>
    </div>
  )
}
