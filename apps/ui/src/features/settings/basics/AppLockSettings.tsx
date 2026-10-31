import { useEffect, useState } from 'react'
import { LOCK_MIN_PASSWORD, lockPasswordError, tr, type LockStatus } from '@lingshell/shared'
import { trx } from '../../../lib/trx.js'
import { client } from '../../../client/index.js'
import { keyHint } from '../../../lib/keybindings.js'
import { Inp } from '../../../components/ui/form.js'
import { BTN2, Row, Section } from '../ui.js'

const errMsg = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': Error:\s*/, '')

// 应用锁分组：主密码的设置 / 修改 / 关闭（后两者要当前密码，主进程校验）。
// children = 空闲自动锁定等随页面自动保存的行（由 AI 与安全页传入）
export function AppLockSettings({ children }: { children?: React.ReactNode }) {
  const [st, setSt] = useState<LockStatus | null>(null)
  const [mode, setMode] = useState<'none' | 'set' | 'disable'>('none')
  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [err, setErr] = useState('')
  const refresh = () => client.lock.status().then(setSt).catch(() => {})
  useEffect(() => { void refresh() }, [])
  const reset = () => { setMode('none'); setCur(''); setNext(''); setAgain(''); setErr('') }

  const submit = async () => {
    setErr('')
    try {
      if (mode === 'disable') await client.lock.disable(cur)
      else {
        const bad = lockPasswordError(next)
        if (bad) return setErr(tr(bad))
        if (next !== again) return setErr(tr('两次输入不一致'))
        await client.lock.setPassword(next, st?.enabled ? cur : undefined)
      }
      reset(); void refresh()
    } catch (e) { setErr(errMsg(e)) }
  }

  // JSX 多行文字行间补一个空格：词条照此拼成一句
  const tip = st && <>{trx('锁定后需输入主密码才能操作终端、主机、文件、对话和授权，本地调用接口同样拒绝；已打开的连接、进行中的 AI 任务和定时巡检照常在后台运行， 待授权的请求等解锁后处理（超时照常拒绝）。{br}主密码只存加盐哈希，{b}：只能退出应用后删除 {file}。 这不会泄露已保存的凭据（它们由操作系统密钥链加密）——应用锁是防止他人趁你离开时使用本应用的访问屏障，不是加密，也挡不住能登录你系统账户并读写数据目录的人。',
    { br: <br />, b: <b>{tr('忘记后无法找回')}</b>, file: <code className="break-all">{st.lockFile}</code> })}</>

  return (
    <Section title={tr('应用锁')}>
      {st && (
        <Row label={tr('应用锁（主密码）')} hint={st.enabled ? tr('已启用：启动、空闲超时、系统锁屏时锁定') : tr('未启用')} tip={tip}>
          {st.enabled && <button className={BTN2} onClick={() => client.lock.lock().catch(() => {})} title={keyHint('app.lock').slice(1, -1)}>{tr('立即锁定')}</button>}
          {mode === 'none' && <button className={BTN2} onClick={() => setMode('set')}>{st.enabled ? tr('修改主密码') : tr('启用应用锁')}</button>}
          {mode === 'none' && st.enabled && <button className={BTN2} onClick={() => setMode('disable')}>{tr('关闭应用锁')}</button>}
        </Row>
      )}
      {st && mode !== 'none' && (
        <Row label={mode === 'disable' ? tr('关闭应用锁') : st.enabled ? tr('修改主密码') : tr('设置主密码')} wide>
          <div className="max-w-[360px] space-y-2">
            {st.enabled && <Inp type="password" value={cur} onChange={setCur} placeholder={tr('当前主密码')} />}
            {mode === 'set' && <>
              <Inp type="password" value={next} onChange={setNext} placeholder={tr('新主密码（至少 {n} 位）', { n: LOCK_MIN_PASSWORD })} />
              <Inp type="password" value={again} onChange={setAgain} placeholder={tr('再输一次')} />
            </>}
            {err && <div className="text-[11px] text-[var(--color-danger)]">{err}</div>}
            <div className="flex justify-end gap-2">
              <button className={BTN2} onClick={reset}>{tr('取消')}</button>
              <button className="rounded-md border border-transparent bg-[var(--color-accent)] px-3 py-1.5 text-[12px] font-medium text-[var(--color-bg-base)] hover:bg-[var(--color-accent-dim)]" onClick={submit}>
                {mode === 'disable' ? tr('确认关闭') : tr('确定')}
              </button>
            </div>
          </div>
        </Row>
      )}
      {children}
    </Section>
  )
}
