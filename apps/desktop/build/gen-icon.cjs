// logo.svg（48px 及以上）+ logo-small.svg（16 / 32px 简化版）→ 多尺寸 icon.ico，另出 1024px icon.png 供 Linux 打包。
// 跑法：cd apps/desktop && ./node_modules/.bin/electron build/gen-icon.cjs
// 用 .cjs 而非 .mjs：electron 二进制拿到 .mjs 入口会降级成 node 模式跑，拿不到 app/BrowserWindow。
const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')

const SIZES = [256, 128, 64, 48, 32, 16] // 16/32 给任务栏和资源管理器小图标，只留 256 会糊

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 256, height: 256, useContentSize: true, show: false,
    transparent: true, frame: false,
    webPreferences: { offscreen: true }, // offscreen 忽略系统 DPI 固定 1x，且窗口不显示也照常渲染
  })
  const shoot = async (f) => { await win.loadFile(join(__dirname, f)); await new Promise((r) => setTimeout(r, 500)); return win.capturePage() } // 等 SVG 渐变绘制完成
  const big = await shoot('logo.svg'), small = await shoot('logo-small.svg')

  // ICO：ICONDIR(6) + N×ICONDIRENTRY(16) + 各尺寸 PNG（Vista+ 允许条目内嵌 PNG）
  const pngs = SIZES.map((s) => (s <= 32 ? small : big).resize({ width: s, height: s, quality: 'best' }).toPNG())
  const dir = Buffer.alloc(6)
  dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(SIZES.length, 4)
  let offset = 6 + SIZES.length * 16
  const entries = SIZES.map((s, i) => {
    const e = Buffer.alloc(16)
    e[0] = s === 256 ? 0 : s; e[1] = s === 256 ? 0 : s // 256 在 ICO 里用 0 表示
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6)
    e.writeUInt32LE(pngs[i].length, 8); e.writeUInt32LE(offset, 12)
    offset += pngs[i].length
    return e
  })
  writeFileSync(join(__dirname, 'icon.ico'), Buffer.concat([dir, ...entries, ...pngs]))
  console.log('icon.ico 生成完成', offset, 'bytes,', SIZES.join('/'))

  // Linux（AppImage / deb）用 PNG：electron-builder 的 icon-tool 只认 .png/.svg/.icns，给 .ico 会直接失败。
  // 单独开 1024 的窗口渲染，避免把 256 的图放大导致糊。
  win.setContentSize(1024, 1024)
  const big1024 = await shoot('logo.svg')
  writeFileSync(join(__dirname, 'icon.png'), big1024.resize({ width: 1024, height: 1024, quality: 'best' }).toPNG())
  console.log('icon.png 生成完成 1024x1024')

  app.quit()
})
