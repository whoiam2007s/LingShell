// Git 面板「分支」页：本地 / 远程分支与标签。切换、新建、合并到当前、变基、重命名、删除、推送；远程分支检出为本地、删除；标签新建 / 推送 / 删除
import { useEffect, useMemo, useState } from 'react'
import { Check, FileText, GitBranchPlus, GitMerge, Globe, Loader2, Search, Tag } from 'lucide-react'
import { tr, type GitRef, type GitRemote } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { Input } from '../../components/ui/Input.js'
import { cn } from '../../lib/cn.js'
import { IB, RowMenu, errText, refNameError, shortDate, type GitCtx, type MenuItem } from './gitUi.js'

export function GitBranches({ ctx, onShowLog }: { ctx: GitCtx; onShowLog: (ref: string) => void }) {
  const { tid, root, st } = ctx
  const [refs, setRefs] = useState<GitRef[]>()
  const [remotes, setRemotes] = useState<GitRemote[]>([])
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  useEffect(() => {
    setErr('')
    client.git.refs(tid, root).then(setRefs).catch((e) => setErr(errText(e)))
    client.git.remotes(tid, root).then(setRemotes).catch(() => setRemotes([]))
  }, [tid, root, ctx.version])

  const ql = q.trim().toLowerCase()
  const shown = useMemo(() => (refs ?? []).filter((r) => !ql || r.name.toLowerCase().includes(ql)), [refs, ql])
  const cur = st.detached ? '' : st.branch
  const nameField = (value = '') => ({ key: 'name', label: tr('名称'), value, required: true, validate: refNameError, placeholder: tr('如 feature/login') })

  const newBranch = (from?: string) => ctx.ask({
    title: from ? tr('从 {from} 新建分支', { from }) : tr('新建分支'), ok: tr('新建'), fields: [nameField()], checks: [{ key: 'checkout', label: tr('新建后切换过去'), value: true }],
    onOk: (v, c) => void ctx.run({ op: 'createBranch', name: v.name, ...(from ? { from } : {}), checkout: c.checkout }, { done: tr('已新建分支 {name}', { name: v.name }) }),
  })
  const remoteNameError = (v: string) => (!v || /^[\w.-]{1,100}$/.test(v) && !v.startsWith('-') ? undefined : tr('只能用字母、数字、. _ -'))
  const urlError = (v: string) => (!v || (!/\s/.test(v) && !v.startsWith('-')) ? undefined : tr('地址不能有空格，不能以 - 开头'))
  const addRemote = () => ctx.ask({
    title: tr('添加远程仓库'), ok: tr('添加'), fields: [
      { key: 'name', label: tr('名字'), value: remotes.some((x) => x.name === 'origin') ? '' : 'origin', required: true, validate: (v) => remoteNameError(v) ?? (remotes.some((x) => x.name === v) ? tr('已经有这个名字了') : undefined), placeholder: tr('如 backup、upstream') },
      { key: 'url', label: tr('git|地址'), required: true, validate: urlError, placeholder: tr('git@host:group/repo.git 或 https://…') },
    ],
    onOk: (v) => void ctx.run({ op: 'remoteAdd', name: v.name, url: v.url }, { done: tr('已添加远程 {name}', { name: v.name }) }),
  })
  // 下拉选远程，默认选当前上游以外的第一个
  const pushTo = (branch: string) => {
    const up = refs?.find((x) => x.kind === 'local' && x.name === branch)?.upstream?.split('/')[0]
    const def = remotes.find((x) => x.name !== up) ?? remotes[0]
    ctx.ask({
      title: tr('把 {branch} 推送到其他远程', { branch }), ok: tr('推送'), text: tr('推送后这个远程的同名分支会成为 {branch} 的上游。', { branch }),
      fields: [{ key: 'remote', label: tr('推送到'), value: def?.name ?? '', required: true, options: remotes.map((x) => ({ value: x.name, label: `${x.name}${x.name === up ? tr('（当前上游）') : ''}\u3000${x.fetchUrl}` })) }],   // i18n-ignore \u5168\u89d2\u7a7a\u683c\u53ea\u662f\u5206\u9694
      onOk: (v) => void ctx.run({ op: 'push', branch, remote: v.remote }, { done: tr('已推送到 {remote}', { remote: v.remote }) }),
    })
  }
  const newTag = () => ctx.ask({
    title: tr('在当前提交（{oid}）上打标签', { oid: st.oid?.slice(0, 7) ?? 'HEAD' }), ok: tr('新建'), fields: [nameField(), { key: 'message', label: tr('说明（可空；填了就是附注标签）'), multiline: true }],
    onOk: (v) => void ctx.run({ op: 'createTag', name: v.name, ...(v.message ? { message: v.message } : {}) }, { done: tr('已新建标签 {name}', { name: v.name }) }),
  })

  const localMenu = (r: GitRef): MenuItem[] => [
    { label: tr('查看历史'), onClick: () => onShowLog(r.name) },
    { label: tr('与当前（{cur}）比较', { cur: cur || 'HEAD' }), disabled: r.current, onClick: () => ctx.openCompare(cur || 'HEAD', r.name) },
    { label: tr('从这里新建分支…'), onClick: () => newBranch(r.name) },
    { sep: true, label: '', onClick: () => {} },
    { label: tr('合并到当前分支（{cur}）', { cur: cur || '—' }), disabled: r.current || !cur, onClick: () => void ctx.run({ op: 'merge', ref: r.name }, { confirm: { title: tr('合并分支'), text: tr('把 {name} 合并到当前分支 {cur}？有冲突时会停在「正在合并」，可以在「更改」页处理或中止。', { name: r.name, cur }), ok: tr('合并') }, done: tr('已合并 {name}', { name: r.name }) }) },
    { label: tr('把当前分支变基到这里'), disabled: r.current || !cur, onClick: () => void ctx.run({ op: 'rebase', onto: r.name }, { confirm: { title: tr('变基'), danger: true, ok: tr('变基'), text: tr('把 {cur} 上自己的提交重新放到 {name} 之后（改写 {cur} 的历史：已经推送过的话，之后要强制推送）。', { cur, name: r.name }) }, done: tr('变基完成') }) },
    { label: r.upstream ? tr('推送') : tr('推送并设为上游（origin）'), onClick: () => void ctx.run({ op: 'push', branch: r.name, setUpstream: !r.upstream || !r.current }, { done: tr('已推送 {name}', { name: r.name }) }) },
    { label: tr('强制推送（--force-with-lease）…'), onClick: () => void ctx.run({ op: 'push', branch: r.name, setUpstream: !r.upstream || !r.current, force: true }, { confirm: { title: tr('强制推送'), danger: true, ok: tr('强制推送'), text: tr('用 --force-with-lease 把 {name} 推上去，覆盖远程上的同名分支。远程从你上次抓取后被别人推过时会拒绝，不会覆盖别人的提交。', { name: r.name }) }, done: tr('已强制推送 {name}', { name: r.name }) }) },
    { label: tr('推送到其他远程…'), disabled: remotes.length < 2, onClick: () => pushTo(r.name) },
    { sep: true, label: '', onClick: () => {} },
    { label: tr('重命名…'), onClick: () => ctx.ask({ title: tr('重命名分支 {name}', { name: r.name }), ok: tr('重命名'), fields: [nameField(r.name)], onOk: (v) => void ctx.run({ op: 'renameBranch', from: r.name, to: v.name }, { done: tr('已重命名') }) }) },
    { label: tr('删除…'), danger: true, disabled: r.current, onClick: () => del(r) },
  ]
  const del = (r: GitRef) => void ctx.run({ op: 'deleteBranch', name: r.name, force: false }, { confirm: { title: tr('删除分支'), danger: true, ok: tr('删除'), text: tr('删除本地分支 {name}？只删本地，远程分支不动。没合并过的分支会拒绝删除。', { name: r.name }) }, done: tr('已删除 {name}', { name: r.name }) })
    .then((ok) => { if (!ok) ctx.ask({ title: tr('强制删除？'), danger: true, ok: tr('强制删除'), text: tr('{name} 上有还没合并到别处的提交（或删除失败）。强制删除后这些提交只能靠 reflog 找回。确定强制删除？', { name: r.name }), onOk: () => void ctx.run({ op: 'deleteBranch', name: r.name, force: true }, { done: tr('已删除 {name}', { name: r.name }) }) }) })
  const remoteMenu = (r: GitRef): MenuItem[] => {
    const [remote, ...rest] = r.name.split('/'), short = rest.join('/')
    return [
      { label: tr('查看历史'), onClick: () => onShowLog(r.name) },
      { label: tr('与当前（{cur}）比较', { cur: cur || 'HEAD' }), disabled: r.current, onClick: () => ctx.openCompare(cur || 'HEAD', r.name) },
      { label: tr('检出为本地分支 {name}', { name: short }), disabled: refs?.some((x) => x.kind === 'local' && x.name === short), onClick: () => void ctx.run({ op: 'checkoutRemote', remote: r.name, local: short }, { done: tr('已检出 {name}', { name: short }) }) },
      { label: tr('从这里新建分支…'), onClick: () => newBranch(r.name) },
      { label: tr('合并到当前分支（{cur}）', { cur: cur || '—' }), disabled: !cur, onClick: () => void ctx.run({ op: 'merge', ref: r.name }, { confirm: { title: tr('合并分支'), text: tr('把 {name} 合并到当前分支 {cur}？', { name: r.name, cur }), ok: tr('合并') }, done: tr('已合并 {name}', { name: r.name }) }) },
      { sep: true, label: '', onClick: () => {} },
      { label: tr('删除远程分支…'), danger: true, onClick: () => void ctx.run({ op: 'deleteRemoteBranch', remote, name: short }, { confirm: { title: tr('删除远程分支'), danger: true, ok: tr('删除'), text: tr('在远程仓库 {remote} 上删除分支 {name}？所有人都会看不到这个分支。', { remote, name: short }) }, done: tr('已删除 {name}', { name: r.name }) }) },
    ]
  }
  const tagMenu = (r: GitRef): MenuItem[] => [
    { label: tr('查看历史'), onClick: () => onShowLog(r.name) },
    { label: tr('与当前（{cur}）比较', { cur: cur || 'HEAD' }), disabled: r.current, onClick: () => ctx.openCompare(cur || 'HEAD', r.name) },
    { label: tr('生成从这个标签到当前的更新日志…'), onClick: () => ctx.openChangelog(r.name) },
    { label: tr('推送到 origin'), onClick: () => void ctx.run({ op: 'pushTag', name: r.name }, { done: tr('已推送标签 {name}', { name: r.name }) }) },
    { label: tr('从这里新建分支…'), onClick: () => newBranch(r.name) },
    { sep: true, label: '', onClick: () => {} },
    { label: tr('删除本地标签…'), danger: true, onClick: () => void ctx.run({ op: 'deleteTag', name: r.name }, { confirm: { title: tr('删除标签'), danger: true, ok: tr('删除'), text: tr('删除本地标签 {name}？远程上的不动。', { name: r.name }) }, done: tr('已删除标签 {name}', { name: r.name }) }) },
  ]

  const section = (title: string, kind: GitRef['kind']) => {
    const rs = shown.filter((r) => r.kind === kind)
    if (!rs.length) return null
    return (
      <div className="mb-2" data-git-refs={kind}>
        <div className="px-3 py-1 text-[10.5px] font-medium text-[var(--color-text-muted)]">{tr('{title}（{n}）', { title, n: rs.length })}</div>
        {rs.map((r) => (
          <div key={r.full} data-git-ref={r.name} onDoubleClick={() => kind === 'local' && !r.current && void ctx.run({ op: 'checkout', branch: r.name }, { done: tr('已切换到 {name}', { name: r.name }) })}
            className={cn('group flex items-center gap-1.5 px-3 py-[3px] text-[11.5px] hover:bg-[var(--color-bg-hover)]', r.current && 'bg-[color:color-mix(in_srgb,var(--color-accent)_12%,transparent)]')}>
            <span className="flex w-3.5 shrink-0 justify-center">{r.current ? <Check className="h-3 w-3 text-[var(--color-accent)]" /> : kind === 'tag' ? <Tag className="h-3 w-3 text-[var(--color-text-muted)]" /> : null}</span>
            <span className={cn('min-w-0 truncate font-mono', r.current ? 'font-semibold text-[var(--color-accent)]' : 'text-[var(--color-text-primary)]')} title={r.full}>{r.name}</span>
            {r.upstream && <span className="shrink-0 font-mono text-[10px] text-[var(--color-text-muted)]" title={tr('上游 {name}', { name: r.upstream })}>→ {r.upstream}</span>}
            {(r.ahead > 0 || r.behind > 0) && <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]" title={tr('领先 {a}，落后 {b}', { a: r.ahead, b: r.behind })}>{r.ahead > 0 && `↑${r.ahead}`}{r.behind > 0 && ` ↓${r.behind}`}</span>}
            {r.gone && <span className="shrink-0 rounded px-1 text-[10px] text-[var(--color-warn)]" title={tr('上游分支在远程已被删除')}>{tr('上游已删除')}</span>}
            <span className="min-w-0 flex-1 truncate text-[10.5px] text-[var(--color-text-muted)]" title={`${r.oid} ${r.subject}\n${shortDate(r.date)}`}>{r.subject}</span>
            <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">{shortDate(r.date).slice(0, 8)}</span>
            {kind === 'local' && !r.current && <button title={tr('切换到这个分支（双击行也可以）')} disabled={!!ctx.busy} onClick={() => void ctx.run({ op: 'checkout', branch: r.name }, { done: tr('已切换到 {name}', { name: r.name }) })} className={cn(IB, 'h-5 w-5 hidden group-hover:flex')}><Check className="h-3 w-3" /></button>}
            {kind !== 'tag' && !r.current && cur && <button title={tr('合并到 {cur}', { cur })} disabled={!!ctx.busy} onClick={() => void ctx.run({ op: 'merge', ref: r.name }, { confirm: { title: tr('合并分支'), text: tr('把 {name} 合并到当前分支 {cur}？', { name: r.name, cur }), ok: tr('合并') }, done: tr('已合并 {name}', { name: r.name }) })} className={cn(IB, 'h-5 w-5 hidden group-hover:flex')}><GitMerge className="h-3 w-3" /></button>}
            <RowMenu items={kind === 'local' ? localMenu(r) : kind === 'remote' ? remoteMenu(r) : tagMenu(r)} />
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--color-border-subtle)] px-3 py-1.5">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-text-muted)]" />
          <Input size="sm" className="pl-7" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('搜索分支 / 标签')} />
        </div>
        <button data-git-new-branch onClick={() => newBranch()} title={tr('新建分支\n从当前提交新建（可选新建后切换过去）')} className={IB}><GitBranchPlus className="h-3.5 w-3.5" /></button>
        <button data-git-new-tag onClick={newTag} disabled={!st.oid} title={tr('新建标签\n在当前提交上打标签（填说明就是附注标签）')} className={IB}><Tag className="h-3.5 w-3.5" /></button>
        <button data-git-changelog onClick={() => ctx.openChangelog()} title={tr('生成更新日志\n把两个版本之间的提交交给 AI 整理成发布说明（可写给运维 / 用户 / 开发）')} className={IB}><FileText className="h-3.5 w-3.5" /></button>
        <button data-git-remote-add onClick={addRemote} title={tr('添加远程仓库\n比如再加一个备份仓库 / 上游仓库')} className={IB}><Globe className="h-3.5 w-3.5" /></button>
      </div>
      {err && <div className="px-3 py-1.5 text-[11px] text-[var(--color-danger)]">{err}</div>}
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {!refs && !err && <div className="flex items-center gap-1.5 px-3 py-3 text-[12px] text-[var(--color-text-muted)]"><Loader2 className="h-3.5 w-3.5 animate-spin" />{tr('读取中…')}</div>}
        {refs && !shown.length && <div className="px-3 py-3 text-[12px] text-[var(--color-text-muted)]">{q ? tr('没有匹配的分支') : tr('还没有分支（空仓库先提交一次）')}</div>}
        {section(tr('本地分支'), 'local')}
        {section(tr('远程分支'), 'remote')}
        {section(tr('标签'), 'tag')}
        <div className="mb-2" data-git-remotes>
          <div className="px-3 py-1 text-[10.5px] font-medium text-[var(--color-text-muted)]">{tr('远程仓库（{n}）', { n: remotes.length })}</div>
          {!remotes.length && <div className="px-3 text-[11px] text-[var(--color-text-muted)]">{tr('没有远程仓库，点工具栏的地球图标添加')}</div>}
          {remotes.map((rm) => (
            <div key={rm.name} data-git-remote={rm.name} className="group flex items-center gap-1.5 px-3 py-[3px] text-[11.5px] hover:bg-[var(--color-bg-hover)]">
              <Globe className="h-3 w-3 shrink-0 text-[var(--color-text-muted)]" />
              <span className="shrink-0 font-mono text-[var(--color-text-primary)]">{rm.name}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-[var(--color-text-muted)]" title={rm.pushUrl && rm.pushUrl !== rm.fetchUrl ? tr('拉取：{fetch}\n推送：{push}', { fetch: rm.fetchUrl, push: rm.pushUrl }) : rm.fetchUrl}>{rm.fetchUrl}</span>
              <RowMenu items={[
                { label: tr('修改地址…'), onClick: () => ctx.ask({ title: tr('修改远程 {name} 的地址', { name: rm.name }), ok: tr('保存'), text: tr('地址里带的密码 / token 不会显示出来；改地址需要重新填完整。'), fields: [{ key: 'url', label: tr('git|地址'), required: true, validate: urlError, placeholder: tr('git@host:group/repo.git 或 https://…') }], onOk: (v) => void ctx.run({ op: 'remoteSetUrl', name: rm.name, url: v.url }, { done: tr('已修改地址') }) }) },
                { label: tr('重命名…'), onClick: () => ctx.ask({ title: tr('重命名远程 {name}', { name: rm.name }), ok: tr('重命名'), fields: [{ key: 'name', label: tr('新名字'), value: rm.name, required: true, validate: remoteNameError }], onOk: (v) => void ctx.run({ op: 'remoteRename', from: rm.name, to: v.name }, { done: tr('已重命名') }) }) },
                { sep: true, label: '', onClick: () => {} },
                { label: tr('删除…'), danger: true, onClick: () => void ctx.run({ op: 'remoteRemove', name: rm.name }, { confirm: { title: tr('删除远程'), danger: true, ok: tr('删除'), text: tr('从本仓库去掉远程 {name}（只删本地的配置和它的远程分支记录，远程仓库本身不受影响）。', { name: rm.name }) }, done: tr('已删除 {name}', { name: rm.name }) }) },
              ]} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
