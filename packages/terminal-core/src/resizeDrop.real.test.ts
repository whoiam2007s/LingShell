import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { LocalTerminal, promptStateAfter } from './LocalTerminal.js'

describe('OSC 133 提示符状态', () => {
  it('A/B 在提示符，C/D 不在；跨多个标记取最后一个', () => {
    expect(promptStateAfter(false, 'x\x1b]133;A\x07$ \x1b]133;B\x07')).toBe(true)
    expect(promptStateAfter(true, '\x1b]133;C\x07output')).toBe(false)
    expect(promptStateAfter(true, '\x1b]133;C\x07out\x1b]133;D;0\x07\x1b]133;A\x07')).toBe(true)
    expect(promptStateAfter(true, 'no marks')).toBe(true)
  })
})

// 回归：Git Bash 缩放后吞用户下一个字符（`clear` → `lear`）。真起 Git Bash，反复缩放后逐字敲命令，命令都得完整执行
const bash = process.platform === 'win32' && existsSync('C:\\Program Files\\Git\\bin\\bash.exe')
describe.skipIf(!bash)('Git Bash 缩放后不吞首字符', () => {
  it('每次缩放后逐字敲的 echo 都完整执行', async () => {
    const t = new LocalTerminal('t_drop')
    let out = ''
    t.onData((d) => { out += d })
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    await sleep(2500)
    // eslint-disable-next-line no-control-regex -- 去掉 OSC / CSI 控制序列
    const plain = () => out.replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '')
    let lost = 0
    for (let i = 0; i < 12; i++) {
      t.resize(i % 2 ? 100 : 57, 30); await sleep(150)
      out = ''
      for (const ch of `echo M_${i}_OK\r`) { t.write(ch); await sleep(15) }
      // 输出回来的快慢受机器负载影响（8 个包并行时可能超过 400ms），轮询等标记出现；
      // 真丢字符时命令会报错，标记永远不出现，判定依然有效。
      const hit = () => plain().split('\n').some((l) => l.trim() === `M_${i}_OK`)
      const deadline = Date.now() + 2000
      while (!hit() && Date.now() < deadline) await sleep(50)
      if (!hit()) lost++
    }
    t.kill()
    expect(lost).toBe(0)   // 不加 NUL 规避时实测约 1/3 的轮次丢字
  }, 120000)
})
