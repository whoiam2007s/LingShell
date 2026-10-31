import { useEffect, useState } from 'react'

// 当前时间，每 intervalMs 刷新一次（相对时间 / 实时计时用）。enabled=false 时不起定时器（已结束的计时不必刷）
export function useNow(intervalMs: number, enabled = true): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs, enabled])
  return enabled ? now : Date.now()
}
