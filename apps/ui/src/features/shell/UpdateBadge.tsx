// 顶栏「有新版本」提示：检测到后出现在用量统计图标**前面**。
// 三态：红色「有更新」圈形箭头（有新版本，点它开始下载）→ 环形进度 + 顶部细进度条 + 百分比（下载中）→ 红色「向上安装」符号（已下载，点它弹窗选现在装还是关闭后装）。
// 不用绿色：绿色像"已完成/正常"，这里是要用户注意并动手的事。
// 用户点了「跳过这个版本」后，这个版本不再出现在顶栏（设置页仍可手动检查）。
import { useEffect, useState } from 'react'
import { ArrowUpCircle, ArrowUpFromLine } from 'lucide-react'
import { tr, type UpdateStatus } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { UpdateReadyDialog } from './UpdateReadyDialog.js'

export function UpdateBadge() {
  const [st, setSt] = useState<UpdateStatus | null>(null)
  const [ask, setAsk] = useState(false)   // 已下载：问「现在重启」还是「关闭后安装」
  const [skip, setSkip] = useState('')    // 设置里「已跳过的版本」

  useEffect(() => {
    const loadSkip = () => client.settings.get().then((s) => setSkip(s.system?.updateSkipVersion ?? '')).catch(() => {})
    client.system.getUpdateStatus().then((r) => setSt(r.status)).catch(() => {})
    void loadSkip()
    // 设置页点「跳过此版本 / 恢复更新提示」时会广播这个事件：立刻重读，不用等下一次状态推送
    window.addEventListener('lingshell:settings-changed', loadSkip)
    const off = client.on((ev) => {
      if (ev.type !== 'update:status') return
      setSt({ state: ev.state, version: ev.version, percent: ev.percent, error: ev.error })
      // 下载完就弹窗（用户点了下载才有这一步）；已经在问的话不重复弹
      if (ev.state === 'downloaded') setAsk((open) => open || true)
    })
    return () => { window.removeEventListener('lingshell:settings-changed', loadSkip); off() }
  }, [])

  // 只在"确实有新版本"之后出现；已是最新 / 未配置 / 出错 / 用户跳过的版本都不在顶栏打扰（那些去 设置 → 关于 看）
  if (!st || (st.state !== 'available' && st.state !== 'downloading' && st.state !== 'downloaded')) return null
  if (st.state === 'available' && skip && st.version === skip) return null

  const v = st.version ? ` ${st.version}` : ''
  const done = st.state === 'downloaded'
  const pct = Math.max(0, Math.min(100, Math.round(st.percent ?? 0)))
  const tip = done
    ? tr('新版本{version}已下载，点击选择现在安装还是关闭后安装', { version: v })
    : st.state === 'downloading'
      ? tr('正在下载新版本{version}（{percent}%）', { version: v, percent: pct })
      : tr('发现新版本{version}，点击下载更新', { version: v })

  const onClick = () => {
    if (st.state === 'downloading') return          // 下载中不重复触发
    if (done) { setAsk(true); return }
    void client.system.downloadUpdate().catch(() => {})   // 有新版：真正开始下载
  }

  return (
    <>
      {/* 下载中：窗口最顶上一条 2px 进度条（不挡内容，像浏览器加载） */}
      {st.state === 'downloading' && (
        <div data-update-progress className="pointer-events-none fixed left-0 top-0 z-[80] h-0.5 w-full bg-transparent">
          <div className="h-full bg-[var(--color-danger)] transition-[width] duration-300" style={{ width: `${pct}%` }} />
        </div>
      )}

      <button
        data-update-badge
        onClick={onClick}
        title={tip}
        className={`relative flex h-9 items-center justify-center gap-0.5 text-[var(--color-danger)] transition-colors hover:bg-[var(--color-bg-hover)] ${st.state === 'downloading' ? 'w-12' : 'w-10'}`}
      >
        {st.state === 'downloading' ? (
          // 环形进度：外圈灰底 + 彩色弧，中心还是下载箭头，右边跟百分比数字
          <>
            <span className="relative flex h-4 w-4 items-center justify-center">
              <svg viewBox="0 0 16 16" className="absolute inset-0 h-4 w-4 -rotate-90" aria-hidden>
                <circle cx="8" cy="8" r="6.5" fill="none" strokeWidth="2" style={{ stroke: 'var(--color-bg-hover)' }} />
                <circle cx="8" cy="8" r="6.5" fill="none" strokeWidth="2" strokeLinecap="round" pathLength={100}
                  strokeDasharray={`${Math.max(pct, 2)} 100`} style={{ stroke: 'var(--color-danger)' }} />
              </svg>
              <ArrowUpCircle className="h-2 w-2" />
            </span>
            <span data-update-pct className="text-[9.5px] font-medium tabular-nums">{pct}%</span>
          </>
        ) : done ? (
          <ArrowUpFromLine className="h-4 w-4" />
        ) : (
          <ArrowUpCircle className="h-4 w-4" />
        )}
        {/* 有小圆点 = 需要你动手（有新版本 / 已下载待重启） */}
        {st.state !== 'downloading' && (
          <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-[var(--color-danger)]" />
        )}
      </button>

      {ask && done && (
        <UpdateReadyDialog
          version={st.version}
          onRestart={() => { setAsk(false); void client.system.installUpdate().catch(() => {}) }}
          onLater={() => setAsk(false)}
        />
      )}
    </>
  )
}
