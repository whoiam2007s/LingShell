import { describe, it, expect, afterAll } from 'vitest'
import { existsSync } from 'node:fs'
import { LocalTerminal } from './LocalTerminal.js'
import { OscSentinelParser, OSC_MARK } from './sentinel.js'

// 去掉隐藏属性（SGR 8）下的文字：剩下的才是屏幕上看得见的。ConPTY 可能把 8 和别的属性合并成一个序列（如 ESC[0;8m）
function stripConceal(s: string): string {
  let hidden = false, r = ''
  // eslint-disable-next-line no-control-regex -- 逐段扫 SGR 序列
  for (const part of s.split(/(\x1b\[[0-9;]*m)/)) {
    const m = /^\x1b\[([0-9;]*)m$/.exec(part)   // eslint-disable-line no-control-regex
    if (m) { const ps = m[1].split(';'); if (ps.includes('8')) hidden = true; if (ps.includes('28') || ps.includes('0') || m[1] === '') hidden = ps.includes('8') && !ps.includes('28'); continue }
    if (!hidden) r += part
  }
  return r
}

describe('不可见标记解析（OscSentinelParser）', () => {
  const S = (id: string) => `\x1b]${OSC_MARK};S;${id}\x07`, E = (id: string, c: number) => `\x1b[8m__CW_END_${id}_${c}__\x1b[28m\r\n`
  it('跨 chunk、回显行在前、提示符在后；结束标记被光标序列打断也认', () => {
    const p = new OscSentinelParser('ab12')
    for (const c of ['$  AI \'echo hi\'\r\n', `\x1b]${OSC_MARK};S;ab1`, '2', '\x07hi\r\n', 'line2\r\n\x1b[8m__CW_END_ab', '\x1b[5;9H12_3__\x1b[28m\r\n', '$ ']) p.feed(c)
    expect(p.result()).toEqual({ output: 'hi\nline2', exitCode: 3 })
  })
  it('开始标记前的回显不算输出；别的 id 的结束标记不算', () => {
    const p = new OscSentinelParser('good')
    p.feed(`echo __CW_END_good_9__ typed\r\n${S('good')}out ${E('bad', 0)}still\r\n${E('good', 1)}`)
    expect(p.result()).toEqual({ output: 'out __CW_END_bad_0__\r\nstill'.replace(/\r\n/g, '\n'), exitCode: 1 })
  })
})

// 真起 Git Bash（Windows 本地）：屏幕上是青色的命令文字（敲进去的只是 ` AI`），没有 __CW_ 文字标记；命令在当前 shell 里执行；
// 保险箱明文只在临时文件里、不上屏；多行 / 带 # / 后台 & / 中断 / 超时 / 缩放重画都正常
const bash = process.platform === 'win32' && existsSync('C:\\Program Files\\Git\\bin\\bash.exe')
describe.skipIf(!bash)('Windows Git Bash：AI 命令不露包装', () => {
  const t = bash ? new LocalTerminal('t_oscexec') : (null as unknown as LocalTerminal)
  let out = ''
  if (bash) t.onData((d) => { out += d })
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  // eslint-disable-next-line no-control-regex -- 去掉 OSC / CSI 控制序列
  const plain = (s: string) => s.replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '')
  afterAll(() => { if (bash) t.kill() })

  it('输出 / 退出码 / 当前 shell 生效 / 屏幕干净', async () => {
    await sleep(2500)
    out = ''
    const r = await t.execCapture('echo 紫色标记测试; cd /tmp', 20000)
    expect(r).toMatchObject({ exitCode: 0, output: '紫色标记测试' })
    expect((await t.execCapture('pwd', 20000)).output).toBe('/tmp')
    const p = plain(out)
    // 青色写回提示符那一行（ConPTY 会把「上移一行 + 右移」翻成绝对定位，颜色和文字之间可能夹着定位序列）
    expect(out).toMatch(/\x1b\[36m(?:\x1b\[[0-9;]*[HC])?echo 紫色标记测试; cd \/tmp/)   // eslint-disable-line no-control-regex
    expect(p).not.toMatch(/__CW_START|printf|PAGER=cat|eval/)
    expect(stripConceal(out)).not.toContain('__CW_END_')   // 结束标记只以隐藏属性出现
    out = ''
    expect((await t.execCapture('false', 20000)).exitCode).toBe(1)
    await sleep(500)
    expect(out).toContain('\x1b]133;D;1')   // 提示符钩子拿到的是命令自己的退出码（行首标红点），不是打标记的 printf 的 0
  }, 60000)

  it('多行、# 注释、后台 & 都能收尾', async () => {
    expect((await t.execCapture('echo a\necho b # 注释', 20000)).output).toBe('a\nb')
    const r = await t.execCapture('sleep 0 &', 20000)
    expect(r.exitCode).toBe(0)
  }, 60000)

  it('保险箱明文只走临时文件：屏幕上是占位符', async () => {
    out = ''
    const r = await t.execCapture('echo {{secret:demo}}', 20000, undefined, { wire: 'echo PLAIN_S3CRET_VALUE >/dev/null; echo ok' })
    expect(r.output).toBe('ok')
    expect(plain(out)).toContain('echo {{secret:demo}}')
    expect(plain(out)).not.toContain('PLAIN_S3CRET_VALUE')
  }, 60000)

  it('超时：Ctrl-C 收尾，返回已有输出；之后还能正常执行', async () => {
    const r = await t.execCapture('echo started; sleep 30', 2500)
    expect(r).toMatchObject({ exitCode: -1, truncated: true })
    expect(r.output).toContain('started')
    await sleep(800)
    expect((await t.execCapture('echo again', 20000)).output).toBe('again')
  }, 60000)

  it('缩放触发 ConPTY 重画后，屏幕上也没有包装命令和标记', async () => {
    out = ''
    await t.execCapture('echo resize-check', 20000)
    for (const [c, r] of [[70, 20], [100, 30], [80, 24]] as const) { t.resize(c, r); await sleep(600) }
    expect(plain(out)).not.toMatch(/__CW_START|printf|PAGER=cat|eval/)
    // 结束标记只以隐藏属性出现（每次出现前面都紧跟 ESC[8m）
    expect(stripConceal(out)).not.toContain('__CW_END_')   // 结束标记只以隐藏属性出现（重画后也是）
  }, 60000)
})
