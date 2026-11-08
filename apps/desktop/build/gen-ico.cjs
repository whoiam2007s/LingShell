// 应用图标生成（取代 build/gen-icon.cjs）：logo.svg / logo-small.svg → 多尺寸 icon.ico + 1024 icon.png
// 跑法：cd apps/desktop && ./node_modules/.bin/electron build/gen-ico.cjs
//
// 三个必须踩过才知道的点：
//   1. ICO 用**传统 BMP 帧**（BITMAPINFOHEADER + 32bpp BGRA），不用帧内嵌 PNG ——
//      PNG 帧虽然 Vista+ 认，但部分消费者（Windows 图标缓存 / 老 rcedit）读不出来，
//      结果 exe / 任务栏退回 Electron 默认的原子图标。
//   2. **不能开小窗口渲染**：窗口高度会被系统限制（请求 32×32 实际只有 32×26），
//      再 resize 回正方形就把图压扁了 —— 任务栏显示成「矩形」就是这么来的。
//      所以一律按 SIZE_BASE 渲染一次，再用 nativeImage.resize 按比例缩放。
//   3. 渲染时把 SVG 铺满视口：logo.svg 自身是固定 256×256，直接加载只会画在左上角。
const { app, BrowserWindow } = require('electron')
const { writeFileSync, rmSync } = require('node:fs')
const { join } = require('node:path')

const SIZES = [256, 128, 64, 48, 32, 24, 16]
const SIZE_BASE = 1024 // 渲染基准：足够大，缩放出去的小图标才清晰

/** 把 SVG 铺满整个视口（img 100vw/100vh，SVG 自己的宽高被拉伸到窗口大小） */
const page = (svg) => `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}img{display:block;width:100vw;height:100vh}</style>
<img src="${svg}">`

/** 传统 ICO 帧：40 字节头 + 自下而上的 32bpp BGRA + AND 掩码（全 0：透明信息走 alpha 通道） */
function bmpFrame(img) {
  const { width: w, height: h } = img.getSize()
  const bgra = img.toBitmap() // BGRA，自上而下
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(w, 4)
  header.writeInt32LE(h * 2, 8) // XOR 位图 + AND 掩码，高度写两份
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(0, 16) // BI_RGB
  header.writeUInt32LE(w * h * 4, 20)
  const xor = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) bgra.copy(xor, (h - 1 - y) * w * 4, y * w * 4, (y + 1) * w * 4)
  const andStride = Math.ceil(w / 32) * 4
  const and = Buffer.alloc(andStride * h) // 全 0 = 不额外抠像素，透明由 alpha 决定
  return Buffer.concat([header, xor, and])
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE_BASE, height: SIZE_BASE, useContentSize: true, show: false,
    transparent: true, frame: false, backgroundColor: '#00000000',
    webPreferences: { offscreen: true }, // offscreen：忽略系统 DPI，固定 1x 渲染
  })
  win.setContentSize(SIZE_BASE, SIZE_BASE)

  /** 渲染一次 SVG（基准尺寸），返回 nativeImage */
  const render = async (svg) => {
    const f = join(__dirname, `.render-${process.pid}.html`)
    writeFileSync(f, page(svg))
    try {
      await win.loadFile(f)
      await new Promise((r) => setTimeout(r, 600)) // 等渐变绘制完
      return await win.capturePage()
    } finally { rmSync(f, { force: true }) }
  }

  const full = await render('logo.svg')
  const small = await render('logo-small.svg')
  const { width: fw, height: fh } = full.getSize()
  if (fw !== fh) throw new Error(`渲染结果不是正方形（${fw}x${fh}），小尺寸会被压扁`)
  console.log(`基准渲染 ${fw}x${fh}`)

  // 16/24/32 用简化版（线条更粗、星芒变圆点），其余用完整版；全部从 1024 缩放，比例一致
  const frames = SIZES.map((s) => {
    const img = (s <= 32 ? small : full).resize({ width: s, height: s, quality: 'best' })
    return { size: s, data: bmpFrame(img) }
  })

  const dir = Buffer.alloc(6)
  dir.writeUInt16LE(0, 0)
  dir.writeUInt16LE(1, 2) // 1 = ICO
  dir.writeUInt16LE(frames.length, 4)
  let offset = 6 + frames.length * 16
  const entries = frames.map(({ size, data }) => {
    const e = Buffer.alloc(16)
    e[0] = size === 256 ? 0 : size // 256 在 ICO 里用 0 表示
    e[1] = size === 256 ? 0 : size
    e.writeUInt16LE(1, 4) // 1 = 不压缩
    e.writeUInt16LE(32, 6) // 32bpp
    e.writeUInt32LE(data.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += data.length
    return e
  })
  writeFileSync(join(__dirname, 'icon.ico'), Buffer.concat([dir, ...entries, ...frames.map((f) => f.data)]))
  console.log('icon.ico 生成完成', offset, 'bytes,', SIZES.join('/'), '（传统 BMP 帧）')

  // Linux（AppImage）/ macOS 用 PNG：直接用基准渲染，保证铺满整张画布
  writeFileSync(join(__dirname, 'icon.png'), full.toPNG())
  console.log(`icon.png 生成完成 ${fw}x${fh}`)

  app.quit()
})
