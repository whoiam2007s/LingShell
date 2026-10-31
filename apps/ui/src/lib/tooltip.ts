// 全局 tooltip：接管所有 title 属性。悬停时临时摘掉 title（原生提示就不出来），改显示随主题配色的提示框；移开再放回去。
// ponytail: 一个监听管全部 723 处 title，不逐个改组件；要富文本 / 可交互提示时再单独做组件
const DELAY = 350        // 首次悬停的等待
const WARM = 600         // 刚关掉一个提示后这么久内移到下一个，立即显示（像 VS Code）

type Rect = { left: number; right: number; top: number; bottom: number; width: number }
let place: ((text: string, r: Rect) => void) | null = null, hide: (() => void) | null = null
/** 手动显示（画在 canvas 上、没有元素可挂 title 的地方用，如终端滚动条标尺）：贴着 r 的下方 / 上方，立即显示 */
export const showTipAt = (text: string, r: Rect) => place?.(text, r)
export const hideTip = () => hide?.()

export function installTooltips(doc: Document = document) {
  const tip = doc.createElement('div')
  tip.setAttribute('role', 'tooltip')
  tip.dataset.appTooltip = ''
  Object.assign(tip.style, {
    position: 'fixed', zIndex: '2147483647', display: 'none', pointerEvents: 'none', maxWidth: 'calc(100vw - 8px)', overflow: 'hidden', textOverflow: 'ellipsis',
    padding: '4px 8px', borderRadius: '6px', fontSize: '12px', lineHeight: '1.45', whiteSpace: 'pre',   // 不自动折行，只按 title 里写的换行符分行
    background: 'var(--color-bg-raised)', color: 'var(--color-text-primary)', border: '1px solid var(--color-border-strong)',
    boxShadow: '0 4px 14px rgba(0,0,0,.28)',
  })
  doc.body.appendChild(tip)
  let cur: HTMLElement | null = null, saved = '', timer = 0, lastHide = 0
  // 悬停元素外层也带 title 的（路径栏整条有 title、每段又各有 title）：外层的也要先摘掉，
  // 否则浏览器会往上找到外层的 title 弹原生提示。离开时一起放回去
  let outer: [Element, string][] = []

  place = (text: string, r: Rect) => {
    tip.textContent = text
    tip.style.left = '0px'; tip.style.top = '0px'   // 先放左上角再量：贴右边时 fixed 元素会被挤窄、量出来的宽度偏小
    tip.style.display = 'block'
    const t = tip.getBoundingClientRect()
    const vw = doc.documentElement.clientWidth, vh = doc.documentElement.clientHeight
    const left = Math.max(4, Math.min(vw - t.width - 4, r.left + r.width / 2 - t.width / 2))
    const top = r.bottom + 6 + t.height <= vh ? r.bottom + 6 : Math.max(4, r.top - 6 - t.height)   // 下面放不下就放上面
    tip.style.left = `${left}px`; tip.style.top = `${top}px`
  }
  hide = () => { if (tip.style.display !== 'none') { tip.style.display = 'none'; lastHide = Date.now() } }
  const show = () => { if (cur?.isConnected) place!(saved, cur.getBoundingClientRect()) }
  const leave = () => {
    clearTimeout(timer)
    if (cur && !cur.hasAttribute('title')) cur.setAttribute('title', saved)   // 悬停期间组件改过 title 就用新的
    for (const [el, t] of outer) if (!el.hasAttribute('title')) el.setAttribute('title', t)
    outer = []
    cur = null
    hide!()
  }

  doc.addEventListener('pointerover', (e) => {
    const target = e.target as Element
    const el = target.closest?.('[title]') as HTMLElement | null   // cur 自己的 title 已摘掉，找到的是里层（或外层之外）的
    // 还在当前元素里、且没进到里层另一个带 title 的元素 → 不动；进了里层 → 改显示里层的
    if (cur?.contains(target) && !(el && el !== cur && cur.contains(el))) return
    leave()
    const text = el?.getAttribute('title') ?? ''   // SVG 元素的 .title 不是字符串，统一读属性
    if (!el || !text.trim()) return
    cur = el; saved = text; el.removeAttribute('title')
    for (let p = el.parentElement?.closest('[title]'); p; p = p.parentElement?.closest('[title]')) { outer.push([p, p.getAttribute('title') ?? '']); p.removeAttribute('title') }
    timer = window.setTimeout(show, Date.now() - lastHide < WARM ? 0 : DELAY)
  }, true)
  doc.addEventListener('pointerout', (e) => { if (cur && !cur.contains(e.relatedTarget as Node | null)) leave() }, true)
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'blur'] as const) (ev === 'blur' ? window : doc).addEventListener(ev, leave, true)
}
