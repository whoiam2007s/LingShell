import { useEffect, useRef } from 'react'
import { tr, type ThinkingLevel } from '@lingshell/shared'

/** 档位显示名（模型面板与滑杆共用，避免两处各写一份） */
export function thinkingLabel(lv: ThinkingLevel): string {
  return lv === 'off' ? tr('关') : lv === 'low' ? tr('低') : lv === 'medium' ? tr('中') : tr('高')
}

// 档位越高粒子越快、越密；off 也留几颗，表示"还活着"而不是一根死条
const SPEED: Record<ThinkingLevel, number> = { off: 0.12, low: 0.32, medium: 0.62, high: 1.15 }
const COUNT: Record<ThinkingLevel, number> = { off: 8, low: 13, medium: 20, high: 30 }

const TRACK_H = 22
const PAD_X = 10
const MAX_PARTICLES = 30

interface Particle { x: number; y: number; r: number; v: number; o: number }

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

// CSS 自定义属性取出来是 var() 字面量，喂给 canvas 会变成黑色；这里用固定色值（深浅主题都可见）

/**
 * 推理等级滑杆：渐变轨道 + 粒子，四档吸附（thinking 只有离散档位，不做连续值）。
 * 只在模型面板打开时挂载，卸载即停 rAF；prefers-reduced-motion 时退化为静态渐变。
 */
export function ThinkingBar({ value, levels, onChange, disabled }: {
  value: ThinkingLevel
  levels: ThinkingLevel[]   // 该模型可用的档位（升序），通常就是 THINKING_LEVELS
  onChange: (lv: ThinkingLevel) => void
  disabled?: boolean
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fracRef = useRef(0)
  const levelRef = useRef(value)
  const levelsRef = useRef(levels)
  const paintRef = useRef<() => void>(() => {})

  const idx = Math.max(0, levels.indexOf(value))
  // 端点贴边：off 在最左、high 在最右，不留空档
  const frac = levels.length > 1 ? idx / (levels.length - 1) : 0

  useEffect(() => { fracRef.current = frac }, [frac])
  useEffect(() => { levelRef.current = value }, [value])
  useEffect(() => { levelsRef.current = levels }, [levels])

  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // 粒子是用户明确要的视觉效果：即使系统开了「减少动效」也保留（只降低密度），否则看起来就是一根死条
    let w = 0
    let h = 0
    const accent = '#7c5cff'
    const gradTo = '#c084fc'
    const track = '#3f3f46'

    const readColors = () => {
      // 固定色值：自定义属性取出来可能是 var()/oklch 字面量，喂给 canvas 会画不出来
    }
    readColors()

    const particles: Particle[] = []
    for (let i = 0; i < MAX_PARTICLES; i++) {
      particles.push({
        x: Math.random() * 320,
        y: 0.18 + Math.random() * 0.64,
        r: 0.6 + Math.random() * 1.5,
        v: 0.45 + Math.random() * 0.9,
        o: 0.25 + Math.random() * 0.6,
      })
    }

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      w = wrap.clientWidth
      h = wrap.clientHeight
      canvas.width = Math.max(1, Math.round(w * dpr))
      canvas.height = Math.max(1, Math.round(h * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(wrap)

    // 换主题 / 换深浅色时色值会变，重读一次（只监听根节点，不影响性能）
    const mo = new MutationObserver(readColors)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })

    const draw = (now: number, dt: number) => {
      const lv = levelRef.current
      const lvs = levelsRef.current
      const speed = SPEED[lv] ?? 0.3
      const count = Math.min(COUNT[lv] ?? 12, MAX_PARTICLES)
      const usable = Math.max(1, w - PAD_X * 2)
      const fillW = Math.max(0, usable * fracRef.current)
      const top = (h - TRACK_H) / 2

      ctx.clearRect(0, 0, w, h)

      roundRect(ctx, PAD_X, top, usable, TRACK_H, TRACK_H / 2)
      ctx.fillStyle = track
      ctx.fill()

      const g = ctx.createLinearGradient(PAD_X, 0, PAD_X + fillW, 0)
      g.addColorStop(0, accent)
      g.addColorStop(1, gradTo)

      ctx.save()
      roundRect(ctx, PAD_X, top, fillW, TRACK_H, TRACK_H / 2)
      ctx.clip()
      ctx.fillStyle = g
      if (fillW > 0.5) ctx.fillRect(PAD_X, top, fillW, TRACK_H)

      // 粒子：亮色 + 阴影，深浅主题下都能看见
      ctx.globalCompositeOperation = 'lighter'
      for (let i = 0; i < count; i++) {
        const p = particles[i]
        p.x += (0.15 + p.v * speed) * dt * 0.00022 * usable
        if (p.x > usable + 6) p.x = -6
        p.y += (Math.random() - 0.5) * 0.01
        p.y = Math.min(0.85, Math.max(0.15, p.y))
        ctx.beginPath()
        ctx.arc(PAD_X + p.x, top + p.y * TRACK_H, p.r, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(255,255,255,${p.o})`
        ctx.fill()
      }
      ctx.globalCompositeOperation = 'source-over'
      ctx.restore()

      // 拖柄：放在填充末端，和吸附档位对齐
      const knobX = PAD_X + fillW
      ctx.save()
      ctx.shadowColor = 'rgba(15, 23, 42, 0.28)'
      ctx.shadowBlur = 7
      ctx.shadowOffsetY = 1
      ctx.beginPath()
      ctx.arc(knobX, h / 2, 10, 0, Math.PI * 2)
      ctx.fillStyle = '#ffffff'
      ctx.fill()
      ctx.restore()
      ctx.beginPath()
      ctx.arc(knobX, h / 2, 10, 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(15, 23, 42, 0.08)'
      ctx.lineWidth = 1
      ctx.stroke()

      // 不支持的档位标个灰点，说明"这里理论上有一档"
      if (lvs.length > 1) {
        for (let i = 0; i < lvs.length; i++) {
          const x = PAD_X + usable * (i / (lvs.length - 1))
          if (Math.abs(x - knobX) < 11) continue
          ctx.beginPath()
          ctx.arc(x, h / 2, 1.6, 0, Math.PI * 2)
          ctx.fillStyle = 'rgba(255, 255, 255, 0.55)'
          ctx.fill()
        }
      }
      void now
    }

    paintRef.current = () => draw(performance.now(), 0)

    let raf = 0
    let last = 0
    const loop = (now: number) => {
      const dt = last ? Math.min(48, now - last) : 16
      last = now
      draw(now, dt)
      raf = requestAnimationFrame(loop)
    }
    if (raf === 0) raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      mo.disconnect()
    }
  }, [])

  // reduced-motion 时没有 rAF，档位变了手动补一帧
  useEffect(() => { paintRef.current() }, [value, levels.length])

  const pickAt = (clientX: number) => {
    const wrap = wrapRef.current
    const lvs = levelsRef.current
    if (!wrap || disabled || lvs.length === 0) return
    const rect = wrap.getBoundingClientRect()
    const usable = rect.width - PAD_X * 2
    if (usable <= 0) return
    const fr = Math.max(0, Math.min(1, (clientX - rect.left - PAD_X) / usable))
    let best = -1
    let bd = Infinity
    for (let i = 0; i < lvs.length; i++) {
      const d = Math.abs((lvs.length > 1 ? i / (lvs.length - 1) : 0) - fr)
      if (d < bd) { bd = d; best = i }
    }
    const next = lvs[best]
    if (next && next !== value) onChange(next)
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (disabled || levels.length === 0) return
    const step = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1
      : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const next = levels[Math.max(0, Math.min(levels.length - 1, idx + step))]
    if (next && next !== value) onChange(next)
  }

  return (
    <div className={`px-3 pb-1.5 pt-1 select-none ${disabled ? 'opacity-50' : ''}`} data-thinking-bar>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[12px] text-[var(--color-text-secondary)]">{tr('推理等级')}</span>
        <span className="text-[12px] font-medium text-[var(--color-accent)]" data-thinking-level={value}>
          {thinkingLabel(value)}
        </span>
      </div>
      <div
        ref={wrapRef}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={tr('推理等级')}
        aria-valuemin={1}
        aria-valuemax={levels.length}
        aria-valuenow={idx + 1}
        aria-valuetext={thinkingLabel(value)}
        aria-disabled={disabled || undefined}
        data-thinking-track
        onKeyDown={onKey}
        onPointerDown={(e) => {
          if (disabled) return
          e.currentTarget.setPointerCapture(e.pointerId)
          pickAt(e.clientX)
        }}
        onPointerMove={(e) => { if (e.buttons === 1) pickAt(e.clientX) }}
        className="relative h-11 w-full cursor-pointer touch-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[color:color-mix(in_srgb,var(--color-accent)_45%,transparent)]"
      >
        <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />
      </div>
    </div>
  )
}
