// 顶栏「有新版本」提示：检测到后出现在用量统计图标**前面**。
// 三态：红色「有更新」圈形箭头（有新版本）→ 环形进度 + 顶部细进度条（下载中）→ 红色「向上安装」符号（已下载，点它安装）。
// 不用绿色：绿色像"已完成/正常"，这里是要用户注意并动手的事。
import { useEffect, useState } from 'react'
import { ArrowUpCircle, ArrowUpFromLine } from 'lucide-react'
import { tr, type UpdateStatus } from '@lingshell/shared'
import { client } from '../../client/index.js'

export function UpdateBadge() {
  const [st, setSt] = useState<UpdateStatus | null>(null)

  useEffect(() => {
    client.system.getUpdateStatus().then((r) => setSt(r.status)).catch(() => {})
    return client.on((ev) => {
      if (ev.type === 'update:status') setSt({ state: ev.state, version: ev.version, percent: ev.percent, error: ev.error })
    })
  }, [])

  // 只在“确实有新版本”之后出现；已是最新 / 未配置 / 出错都不在顶栏打扰（那些去 设置 → 关于 看）
  if (!st || (st.state !== 'available' && st.state !== 'downloading' && st.state !== 'downloaded')) return null

  const v = st.version ? ` ${st.version}` : ''
  const done = st.state === 'downloaded'
  const pct = Math.max(0, Math.min(100, Math.round(st.percent ?? 0)))
  const tip = done
    ? tr('新版本{version}已下载，点击立即重启更新', { version: v })
    : st.state === 'downloading'
      ? tr('正在下载新版本{version}（{percent}%）', { version: v, percent: pct })
      : tr('发现新版本{version}，点击下载更新', { version: v })

  const onClick = () => {
    if (done) void client.system.installUpdate().catch(() => {})
    else if (st.state === 'available') void client.system.checkUpdate().catch(() => {})
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
        className="relative flex h-9 w-10 items-center justify-center text-[var(--color-danger)] transition-colors hover:bg-[var(--color-bg-hover)]"
      >
        {st.state === 'downloading' ? (
          // 环形进度：外圈灰底 + 彩色弧，中心还是下载箭头
          <span className="relative flex h-4 w-4 items-center justify-center">
            <svg viewBox="0 0 16 16" className="absolute inset-0 h-4 w-4 -rotate-90" aria-hidden>
              <circle cx="8" cy="8" r="6.5" fill="none" strokeWidth="2" style={{ stroke: 'var(--color-bg-hover)' }} />
              <circle cx="8" cy="8" r="6.5" fill="none" strokeWidth="2" strokeLinecap="round" pathLength={100}
                strokeDasharray={`${Math.max(pct, 2)} 100`} style={{ stroke: 'var(--color-danger)' }} />
            </svg>
            <ArrowUpCircle className="h-2 w-2" />
          </span>
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
    </>
  )
}
