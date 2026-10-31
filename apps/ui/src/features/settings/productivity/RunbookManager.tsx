import { useEffect, useState, useCallback, useRef } from 'react'
import { BookOpen, BookOpenText, Pencil, Trash2, Plus, Upload, Download } from 'lucide-react'
import { openRunbookView } from '../../runbooks/index.js'
import { parseRunbookJson, tr, type Runbook, type RunbookInput } from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { ConfirmDialog } from '../../common/index.js'
import { RunbookEditor, emptyRunbook } from '../../runbooks/index.js'
import { Page, Section, SaveBar, BTN2, BTN1, ICON_BTN, ICON_DEL, LIST, ITEM, Toolbar, EmptyState, BackLink, errText } from '../ui.js'

// 设置弹窗内的「运维手册」页：列表、编辑、删除、导入/导出单个手册 JSON
export function RunbookManager() {
  const [list, setList] = useState<Runbook[] | null>(null)
  const [form, setForm] = useState<RunbookInput | null>(null)
  const [delTarget, setDelTarget] = useState<Runbook | null>(null)
  const [err, setErr] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(() => { client.runbooks.list().then(setList).catch(() => setList([])) }, [])
  useEffect(() => { refresh() }, [refresh])

  const save = async () => {
    if (!form) return
    try { await client.runbooks.save(form); setForm(null); setErr(''); refresh() }
    catch (e) { setErr(errText(e)) }
  }
  const doDelete = () => { if (delTarget) client.runbooks.delete(delTarget.id).then(refresh); setDelTarget(null) }
  const doExport = (r: Runbook) => {
    const { id: _id, updatedAt: _u, ...data } = r
    client.system.saveTextFile(`${r.name.replace(/[\\/:*?"<>|]/g, '_')}.runbook.json`, JSON.stringify(data, null, 2)).catch((e) => setErr(errText(e)))
  }
  // 导入：读 JSON → 校验 → 进编辑页，用户确认后保存
  const doImport = async (f?: File) => {
    if (!f) return
    try { setForm(parseRunbookJson(await f.text())); setErr('') }
    catch (e) { setErr(tr('导入失败：{msg}', { msg: errText(e) })) }
    if (fileRef.current) fileRef.current.value = ''
  }
  const create = () => { setForm(emptyRunbook()); setErr('') }

  if (form) {
    return (
      <Page>
        <BackLink onClick={() => { setForm(null); setErr('') }}>{tr('返回手册列表')}</BackLink>
        <Section title={form.id ? tr('编辑手册') : tr('新建手册')}>
          <div className="px-3.5 py-3"><RunbookEditor value={form} onChange={setForm} /></div>
        </Section>
        <SaveBar onSave={save} disabled={!form.name.trim()} msg={err ? { ok: false, text: err } : null} />
      </Page>
    )
  }

  const newBtn = <button onClick={create} className={BTN1}><Plus className="h-3.5 w-3.5" />{tr('新建')}</button>
  return (
    <Page>
      <Toolbar hint={tr('「打开」逐条手动执行，或在输入框旁「运维手册」交给 AI')} tip={tr('手册是一组按顺序执行的命令步骤，可带参数。「打开」进手册视图：参数填一次，每个命令块执行到当前终端并显示退出码与耗时。也可在执行记录里「保存为手册」、让 AI 生成；单个手册可导出 / 导入 JSON 便于分享，导入后先进编辑页确认再保存。')}>
        <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={(e) => void doImport(e.target.files?.[0])} />
        <button onClick={() => fileRef.current?.click()} className={`flex items-center gap-1 ${BTN2}`}><Upload className="h-3.5 w-3.5" />{tr('导入')}</button>
        {newBtn}
      </Toolbar>
      {err && <div className="text-[12px] text-[var(--color-danger)]">{err}</div>}
      {!list ? null : list.length === 0 ? <EmptyState text={tr('暂无手册')} action={newBtn} /> : (
        <div className={LIST}>
          {list.map((r) => (
            <div key={r.id} className={ITEM}>
              <BookOpen className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
              <span className="shrink-0 font-medium text-[var(--color-text-primary)]">{r.name}</span>
              <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">{tr('{n} 步', { n: r.steps.length })}</span>
              <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-muted)]" title={r.description}>{r.description}</span>
              <button data-runbook-open={r.name} onClick={() => openRunbookView(r.id)} title={tr('打开手册视图：参数填一次，逐条执行到当前终端')}
                className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px] text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]"><BookOpenText className="h-3 w-3" />{tr('打开')}</button>
              <button onClick={() => doExport(r)} title={tr('导出 JSON')} className={ICON_BTN}><Download className="h-3 w-3" /></button>
              <button onClick={() => { setForm(r); setErr('') }} title={tr('编辑')} className={ICON_BTN}><Pencil className="h-3 w-3" /></button>
              <button onClick={() => setDelTarget(r)} title={tr('删除')} className={ICON_DEL}><Trash2 className="h-3 w-3" /></button>
            </div>
          ))}
        </div>
      )}
      <ConfirmDialog open={!!delTarget} title={tr('删除手册')} message={tr('确定删除运维手册 {name}？', { name: delTarget?.name ?? '' })} onConfirm={doDelete} onCancel={() => setDelTarget(null)} />
    </Page>
  )
}
