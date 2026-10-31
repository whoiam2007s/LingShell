import { useId } from 'react'

/**
 * 灵壳 Logo：符号「>_ + 星芒」固定，底框随场景换，颜色跟随当前主题强调色。
 * square = 圆角方块（关于页）；circle = 圆形（悬浮球）；bare = 无底框，符号直接用强调色（标题栏）。
 * 应用图标 / 托盘用的是 apps/desktop/build 下的静态 SVG（固定青绿），见 gen-icon.cjs
 */
export function Logo({ shape = 'square', className }: { shape?: 'square' | 'circle' | 'bare'; className?: string }) {
  const id = useId()
  const bare = shape === 'bare'
  const fg = bare ? 'var(--color-accent)' : 'var(--logo-fg, #ffffff)'
  const star = bare ? 'var(--color-warn)' : 'var(--logo-fg, #fef9c3)'
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden>
      {!bare && <>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" style={{ stopColor: 'var(--color-accent)' }} />
            <stop offset="1" style={{ stopColor: 'color-mix(in srgb, var(--color-accent) 62%, #000)' }} />
          </linearGradient>
        </defs>
        {shape === 'circle' ? <circle cx="32" cy="32" r="32" fill={`url(#${id})`} /> : <rect x="2" y="2" width="60" height="60" rx="15" fill={`url(#${id})`} />}
      </>}
      <g transform={shape === 'circle' ? 'translate(32 32) scale(0.72) translate(-32 -32)' : undefined}>
        <path d="M15 22 L27 32 L15 42" fill="none" stroke={fg} strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="31" y="39" width="17" height="6" rx="3" fill={fg} />
        <path d="M46 9 C46.8 14.2 48.8 16.2 54 17 C48.8 17.8 46.8 19.8 46 25 C45.2 19.8 43.2 17.8 38 17 C43.2 16.2 45.2 14.2 46 9 Z" fill={star} />
      </g>
    </svg>
  )
}
