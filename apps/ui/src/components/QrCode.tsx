import { useMemo } from 'react'
import { tr } from '@lingshell/shared'
import { qrMatrix } from '../lib/qr.js'

// 二维码（SVG）：固定白底黑块 + 4 格留白，深色主题下手机也扫得出
export function QrCode({ text, size = 168, className = '' }: { text: string; size?: number; className?: string }) {
  const { n, d } = useMemo(() => {
    const m = qrMatrix(text)
    let path = ''
    m.forEach((row, y) => row.forEach((dark, x) => { if (dark) path += `M${x + 4} ${y + 4}h1v1h-1z` }))
    return { n: m.length + 8, d: path }
  }, [text])
  return (
    <svg data-qr={text} width={size} height={size} viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges" className={`shrink-0 rounded ${className}`} role="img" aria-label={tr('二维码：{text}', { text })}>
      <rect width={n} height={n} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  )
}
