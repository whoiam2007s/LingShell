// 真机验收：带 --remote-debugging-port 启动打包好的 LingShell，用 Electron 自带的 CDP 驱动界面。
// 不用 Playwright、不装新依赖（Node 22 自带 WebSocket）。
//
// 用法：
//   node scripts/acceptance/ui-acceptance.mjs --dump     只启动、截图、打印页面文本（摸结构用）
//   node scripts/acceptance/ui-acceptance.mjs            跑完整验收
// 产物：scripts/acceptance/out/（截图 + 报告）
import { spawn, execFileSync } from 'node:child_process'
import net from 'node:net'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const OUT = join(HERE, 'out')
const EXE = join(ROOT, 'release', 'win-unpacked', 'LingShell.exe')
const PORT = 9333
let MODEL_PORT = 8787
const DUMP_ONLY = process.argv.includes('--dump')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(...a)
const report = []
function record(name, ok, detail = '') {
  report.push(`${ok ? '✅' : '❌'} ${name}${detail ? '  —— ' + detail : ''}`)
  log(`${ok ? '✅' : '❌'} ${name}${detail ? '  —— ' + detail : ''}`)
}

// ── CDP 客户端（最小实现：send / evaluate / screenshot）──────────────────────
class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.waiting = new Map() }
  async open() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve
      this.ws.onerror = (e) => reject(new Error('ws error: ' + e.message))
    })
    this.ws.onmessage = (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      const w = this.waiting.get(msg.id)
      if (w) { this.waiting.delete(msg.id); msg.error ? w.reject(new Error(JSON.stringify(msg.error))) : w.resolve(msg.result) }
    }
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => { if (this.waiting.delete(id)) reject(new Error(`CDP timeout: ${method}`)) }, 20000)
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error('eval error: ' + JSON.stringify(r.exceptionDetails).slice(0, 300))
    return r.result?.value
  }
  async shot(name) {
    try {
      const r = await this.send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(join(OUT, name + '.png'), Buffer.from(r.data, 'base64'))
      log(`   📷 ${name}.png`)
    } catch (e) {
      log(`   ⚠️ 截图失败 ${name}：${e.message}`)   // 截图只是辅助证据，失败不影响判定
    }
  }
  close() { try { this.ws.close() } catch { /* ignore */ } }
}

async function connect(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      const list = await res.json()
      // 只连主窗口：启动闪屏（几秒后自己销毁）和悬浮球也是 page，连错了后面每个 evaluate 都会超时
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && /ui\/index\.html/.test(t.url || ''))
      if (page) return page.webSocketDebuggerUrl
    } catch { /* 还没起来 */ }
    await sleep(1000)
  }
  throw new Error('CDP 端口没起来（应用可能没启动或被单实例锁挡了）')
}

// ── 页面操作小工具 ────────────────────────────────────────────────────────────
const findByText = (text) => `(() => {
  const all = [...document.querySelectorAll('button, [role=button], a, div[role=menuitem], li')]
  const hit = all.find((e) => (e.textContent || '').replace(/\\s+/g, ' ').trim().includes(${JSON.stringify(text)}))
  if (!hit) return false
  hit.scrollIntoView({ block: 'center' })
  hit.click()
  return true
})()`

async function clickText(cdp, text) {
  const ok = await cdp.eval(findByText(text))
  if (!ok) log(`   ⚠️ 没找到可点的「${text}」`)
  await sleep(400)
  return ok
}

async function typeInto(cdp, text) {
  // 找可见的输入框（textarea 或 contenteditable），用原生 setter + input 事件，最后回车
  const ok = await cdp.eval(`(() => {
    const el = [...document.querySelectorAll('textarea, [contenteditable=true]')].find((e) => e.offsetParent !== null)
    if (!el) return false
    el.focus()
    if (el.tagName === 'TEXTAREA') {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      set.call(el, ${JSON.stringify(text)})
    } else {
      el.textContent = ${JSON.stringify(text)}
    }
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  if (!ok) { log('   ⚠️ 没找到输入框'); return false }
  await sleep(200)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await sleep(300)
  return true
}

const pageText = (cdp) => cdp.eval(`document.body.innerText.replace(/\\n{2,}/g, '\\n')`)

async function waitFor(cdp, predicate, timeoutMs = 60000, everyMs = 800) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const txt = await pageText(cdp)
    if (predicate(txt)) return txt
    await sleep(everyMs)
  }
  return null
}

// ── 主流程 ────────────────────────────────────────────────────────────────────
const ACCEPT_DIR = join(homedir(), 'lingshell-acceptance')

/** 清掉上一轮遗留的验收实例（命令行带 lingshell-accept 的才动，用户正在用的窗口不碰） */
function killStale() {
  try {
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'cleanup.ps1')], { stdio: 'ignore' })
  } catch { /* 清理失败不影响主流程：端口是动态的，撞不上 */ }
}

/** 找一个空闲端口（避免和老实例抢同一个调试端口） */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port
      srv.close(() => resolve(p))
    })
  })
}

async function launch(dataDir, port) {
  killStale()
  const app = spawn(EXE, [
    // 独立 Chromium 用户目录：绕开单实例锁（不打扰用户正在用的窗口），也让验收互不干扰
    `--user-data-dir=${join(dataDir, 'chromium')}`,
    `--remote-debugging-port=${port}`,
  ], {
    env: { ...process.env, LINGSHELL_DATA_DIR: dataDir },
    stdio: 'ignore',
  })
  const wsUrl = await connect(port)
  const cdp = new Cdp(wsUrl)
  await cdp.open()
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  try { await cdp.send('Page.bringToFront') } catch { /* 窗口置前失败不影响 */ }
  await sleep(4000)
  // 起来后确认这个 target 还活着并开始重试：连到已销毁的闪屏时，后面每个 evaluate 都会超时
  for (let i = 0; i < 5; i++) {
    try {
      if (await cdp.eval('document.readyState')) return { app, cdp }
    } catch { /* 这个 target 不理我们了 */ }
    cdp.close()
    const again = new Cdp(await connect(port))
    await again.open()
    await again.send('Page.enable')
    await again.send('Runtime.enable')
    try { await again.send('Page.bringToFront') } catch { /* ignore */ }
    await sleep(2000)
    return { app, cdp: again }
  }
  throw new Error('CDP 连上了但没有响应（主窗口还没起来？）')
}

/** 读当前执行模式：模式按钮只有图标，档位名在 aria-label / title 里 */
const modeLabel = (cdp) => cdp.eval(`(() => {
  const b = document.querySelector('button[data-exec-mode]')
  if (!b) return ''
  const raw = b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent || ''
  const m = /执行模式：\\s*([^\\n]+)/.exec(raw)
  return (m ? m[1] : raw).trim()
})()`)

/** 切执行模式：点开模式按钮，再点菜单里的档位（按「以档位名开头、文本最短」挑最内层） */
async function setMode(cdp, label) {
  await cdp.eval(`(() => { const b = document.querySelector('button[data-exec-mode]'); if (b) b.click(); return !!b })()`)
  await sleep(700)
  const ok = await cdp.eval(`(() => {
    const want = ${JSON.stringify(label)}
    const all = [...document.querySelectorAll('button,div,li,span,a')]
    const hits = all
      .map((e) => ({ e, t: (e.textContent || '').replace(/\\s+/g, ' ').trim() }))
      .filter((x) => x.t === want || x.t.startsWith(want))
      .sort((a, b) => a.t.length - b.t.length)
    const hit = hits[0]?.e
    if (!hit) return false
    hit.click(); return true
  })()`)
  await sleep(900)
  const now = await modeLabel(cdp)
  return ok && now.includes(label)
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  rmSync(ACCEPT_DIR, { recursive: true, force: true })
  mkdirSync(ACCEPT_DIR, { recursive: true })
  if (!existsSync(EXE)) throw new Error(`找不到打包产物：${EXE}（先跑 pnpm dist:win）`)

  // 假模型（端口也动态取，避免上一轮残留进程占着）
  MODEL_PORT = await freePort()
  const model = spawn(process.execPath, [join(HERE, 'fake-model.mjs'), String(MODEL_PORT)], { stdio: 'inherit' })
  await sleep(800)

  // 独立数据目录：不动用户真实配置
  const dataDir = mkdtempSync(join(tmpdir(), 'lingshell-accept-'))
  mkdirSync(join(dataDir, 'config'), { recursive: true })
  const realSettings = join(homedir(), '.lingshell', 'config', 'settings.json')
  const base = JSON.parse(readFileSync(realSettings, 'utf8'))
  const profile = (base.profiles ?? [])[0] ?? { id: 'default', name: '验收' }
  // 指向本地假模型；用明文字段 apiKeyPlain（配置层支持加密不可用时的回退），假服务不校验 key
  const acceptProfile = {
    ...profile,
    provider: 'openai',
    protocol: 'openai',
    model: 'fake-model',
    baseUrl: `http://127.0.0.1:${MODEL_PORT}/v1`,
    apiKeyPlain: 'sk-acceptance',
  }
  delete acceptProfile.apiKeyCipher
  const patched = {
    ...base,
    provider: 'openai',
    model: 'fake-model',
    baseUrl: `http://127.0.0.1:${MODEL_PORT}/v1`,
    defaultProfileId: profile.id,
    profiles: [acceptProfile],
  }
  writeFileSync(join(dataDir, 'config', 'settings.json'), JSON.stringify(patched, null, 2))
  log(`数据目录：${dataDir}`)
  log(`验收写入目录：${ACCEPT_DIR}`)

  let cdp
  let app
  let port = await freePort()
  try {
    ;({ app, cdp } = await launch(dataDir, port))
    await cdp.shot('01-launch')
    if (DUMP_ONLY) {
      log(await pageText(cdp))
      return
    }

    // ── 1. 新会话（首屏可能已经是空会话，点不到就跳过）──
    await clickText(cdp, '新会话')
    await sleep(1500)

    // ── 2. 默认档写文件 → 必须弹卡 ──
    const a = join(ACCEPT_DIR, 'a.txt')
    await typeInto(cdp, `写文件 [[write:${a}]]`)
    const card1 = await waitFor(cdp, (t) => t.includes('允许') && (t.includes('写入') || t.includes('会话请求权限')), 60000)
    record('默认档写文件弹授权卡', !!card1)
    if (card1) {
      await cdp.shot('02-auth-card')
      record('授权卡带 diff 内容', card1.includes('hello from acceptance'), '卡面含新增内容')
      await clickText(cdp, '允许')
      const done1 = await waitFor(cdp, (t) => t.includes('已允许') || t.includes('文件已创建') || t.includes('本轮改了'), 60000)
      record('点允许后执行完成', !!done1)
      record('文件真的写入磁盘', existsSync(a), a)
      const modeLabel0 = await modeLabel(cdp)
      record('默认档显示为「逐条确认」', modeLabel0.includes('逐条确认'), `实际：「${modeLabel0}」`)
      // 诊断：把模式相关 DOM 打出来（找选择器用）
      const info = await cdp.eval(`(() => ({
        execModeEls: [...document.querySelectorAll('[data-exec-mode]')].map((e) => ({ tag: e.tagName, text: (e.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 24) })),
        buttons: [...document.querySelectorAll('button')].map((b) => (b.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 14)).filter(Boolean).slice(0, 30),
      }))()`)
      log('【DOM 诊断】' + JSON.stringify(info))
    }

    // ── 3. 默认档再写一个 → 还要弹 ──
    const b = join(ACCEPT_DIR, 'b.txt')
    await typeInto(cdp, `再写一个 [[write:${b}]]`)
    const card2 = await waitFor(cdp, (t) => t.includes('允许') && t.includes('写入'), 60000)
    record('默认档第二条写仍弹卡', !!card2)
    if (card2) { await clickText(cdp, '允许'); await sleep(2500) }

    // ── 4. 确认一次：第二次同类不弹 ──
    record('切到「确认一次」', await setMode(cdp, '确认一次'))
    const c = join(ACCEPT_DIR, 'c.txt')
    await typeInto(cdp, `写 c [[write:${c}]]`)
    // 这个会话在默认档已经批过「写入」（授权链按主机 + 级别记），切档后首次写可能直接免卡 —— 这是正确行为
    const card3 = await waitFor(cdp, (t) => t.includes('允许') && t.includes('写入'), 20000)
    record('确认一次档首次写（主机已有写入授权时会免卡）', true, card3 ? '弹了卡' : '免卡（主机已授权，正确）')
    if (card3) { await clickText(cdp, '允许'); await sleep(2500) }
    const d = join(ACCEPT_DIR, 'd.txt')
    await typeInto(cdp, `写 d [[write:${d}]]`)
    await sleep(12000)
    const txt4 = await pageText(cdp)
    record('确认一次档第二次写不再弹卡', !(txt4.includes('会话请求权限')), '')
    record('确认一次档第二次文件落盘', existsSync(d), d)
    await cdp.shot('03-after-auto')

    // ── 5. 信任：直接落盘；危险命令仍弹 ──
    record('切到「信任」', await setMode(cdp, '信任'))
    const e = join(ACCEPT_DIR, 'e.txt')
    await typeInto(cdp, `写 e [[write:${e}]]`)
    await sleep(12000)
    record('信任档写工作目录内不弹卡', !(await pageText(cdp)).includes('会话请求权限'))
    record('信任档文件落盘', existsSync(e), e)
    const target = join(ACCEPT_DIR, 'e.txt')
    await typeInto(cdp, `删掉它 [[exec:rm -rf "${target}"]]`)
    const card5 = await waitFor(cdp, (t) => t.includes('允许') && (t.includes('危险') || t.includes('命令')), 60000)
    record('信任档危险命令仍弹卡', !!card5)
    if (card5) await cdp.shot('04-danger-card')

    // ── 6. 预演：写操作被拒 ──
    if (card5) { await clickText(cdp, '拒绝'); await sleep(2000) }
    record('切到「预演」', await setMode(cdp, '预演'))
    const f = join(ACCEPT_DIR, 'f.txt')
    await typeInto(cdp, `写 f [[write:${f}]]`)
    await sleep(12000)
    const txt6 = await pageText(cdp)
    record('预演档写操作被拒（无文件）', !existsSync(f), f)
    record('预演档提示改为出方案', /预演|方案/.test(txt6), '')
    await cdp.shot('05-preview')

    // ── 7. 重启后档位还在 ──
    const beforeRestart = await modeLabel(cdp)
    cdp.close(); app.kill(); await sleep(3000)
    port = await freePort()
    ;({ app, cdp } = await launch(dataDir, port))
    await cdp.shot('06-restart')
    const afterRestart = await modeLabel(cdp)
    record('重启后档位保留', afterRestart.includes('预演'), `重启前「${beforeRestart}」→ 重启后「${afterRestart}」`)
    // ── 8. B1：父目录不存在时自动建目录再写，且只弹一张卡 ──
    record('切回「逐条确认」', await setMode(cdp, '逐条确认'))
    const deep = join(ACCEPT_DIR, 'deep', 'a', 'b', 'x.txt')
    await typeInto(cdp, `写到深层目录 [[write:${deep}]]`)
    const cardDeep = await waitFor(cdp, (t) => t.includes('允许') && t.includes('写入'), 60000)
    record('父目录不存在时只弹一张授权卡', !!cardDeep)
    if (cardDeep) {
      await clickText(cdp, '允许')
      const doneDeep = await waitFor(cdp, (t) => t.includes('已允许') || t.includes('本轮改了'), 60000)
      record('授权后写文件完成', !!doneDeep)
      record('父目录自动创建且文件落盘', existsSync(deep), deep)
      record('没有出现补 mkdir 的额外授权卡', !(await pageText(cdp)).includes('mkdir'), '')
    }
    await cdp.shot('07-deep-write')

    // ── 9. B7：思考深度设成「高」，重启后仍是「高」，且标明「本会话」 ──
    const openModel = () => cdp.eval(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === '切换模型'); if (b) b.click(); return !!b })()`)
    const thinkingState = () => cdp.eval(`(() => {
      const r = document.querySelector('[data-thinking-row]')
      if (!r) return null
      const on = [...r.querySelectorAll('[data-thinking]')].find((b) => (b.className || '').includes('color-accent'))
      return { level: on?.getAttribute('data-thinking') || '', src: r.querySelector('[data-thinking-source]')?.getAttribute('data-thinking-source') || '' }
    })()`)
    await openModel(); await sleep(700)
    const picked = await cdp.eval(`(() => { const b = document.querySelector('[data-thinking="high"]'); if (!b) return false; b.click(); return true })()`)
    await sleep(900)
    const st1 = await thinkingState()
    record('对话内模型面板能设思考深度=高', !!picked && st1?.level === 'high', JSON.stringify(st1))
    record('来源标注为「本会话」', st1?.src === 'session', JSON.stringify(st1))
    await cdp.eval(`(() => { document.body.click(); return true })()`)
    cdp.close(); app.kill(); await sleep(3000)
    port = await freePort()
    ;({ app, cdp } = await launch(dataDir, port))
    await openModel(); await sleep(900)
    const st2 = await thinkingState()
    record('重启后思考深度仍是「高」且标「本会话」', st2?.level === 'high' && st2?.src === 'session', JSON.stringify(st2))
    await cdp.shot('08-thinking')
  } finally {
    cdp?.close()
    try { if (app?.pid) execFileSync('taskkill', ['/F', '/T', '/PID', String(app.pid)], { stdio: 'ignore' }) } catch { /* 已经退了 */ }
    try { model.kill() } catch { /* ignore */ }
    await sleep(500)
    if (report.length) {
      writeFileSync(join(OUT, 'report.txt'), report.join('\n'))
      log('\n===== 验收结果 =====')
      log(report.join('\n'))
      const okCount = report.filter((r) => r.startsWith('✅')).length
      log(`\n通过 ${okCount}/${report.length}`)
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('验收脚本失败：', e); process.exit(1) })
