import { describe, expect, it } from 'vitest'
import { TerminalManager } from './TerminalManager.js'

// 真实 pty 上的端到端验证：输出净化 + 「卡在等输入」识别（这两条只在真终端里能验）
// 默认跳过：每条要等 ~18s 才判定，跑两遍叠加会拖慢全量测试，也让 ConPTY 负载更高（会加剧已知 flaky 用例）。
// 需要时手动跑：LINGSHELL_REAL_SLOW=1 pnpm --filter @lingshell/terminal-core test
const REAL_SLOW = !!process.env.LINGSHELL_REAL_SLOW

describe.skipIf(!REAL_SLOW)('execCapture（真实终端）', () => {
  const withTerm = async (fn: (m: TerminalManager, id: string) => Promise<void>) => {
    const m = new TerminalManager()
    const info = m.createLocal()
    try {
      await m.ready(info.id)
      await fn(m, info.id)
    } finally {
      await m.close(info.id).catch(() => {})
    }
  }

  it('\\r 原地刷新的进度条只保留最终帧', async () => {
    await withTerm(async (m, id) => {
      const r = await m.execCapture(id, `printf 'step1\\rstep2\\rstep3\\n'`, undefined, 20000)
      expect(r.needsInput).toBeUndefined()
      expect(r.output.trim()).toBe('step3')
    })
  }, 60000)

  it('停在 (y/n) 等输入：几秒内就返回 needsInput，而不是等满超时', async () => {
    await withTerm(async (m, id) => {
      const t0 = Date.now()
      const r = await m.execCapture(id, `read -p "continue? (y/n) " answer`, undefined, 60000)
      const cost = Date.now() - t0
      expect(r.needsInput, `应识别为等输入，实际 output=${JSON.stringify(r.output)}`).toBeTruthy()
      expect(r.needsInput).toContain('y/n')
      // 判据是「跑超 10s + 静默 8s」，留足余量但要小于 60s 超时
      expect(cost).toBeLessThan(45000)
    })
  }, 60000)

  it('中文提示同样能识别', async () => {
    await withTerm(async (m, id) => {
      const t0 = Date.now()
      const r = await m.execCapture(id, `read -p "是否继续？[是/否] " answer`, undefined, 60000)
      expect(r.needsInput).toBeTruthy()
      expect(Date.now() - t0).toBeLessThan(45000)
    })
  }, 60000)

  it('handoff 模式：判定等输入时不中止，命令留在终端里', async () => {
    await withTerm(async (m, id) => {
      const r = await m.execCapture(id, `read -p "continue? (y/n) " answer`, undefined, 60000, { handoff: true })
      expect(r.needsInput).toBeTruthy()
      expect(r.handedOff).toBe(true)   // 标记由「没发 Ctrl-C」那条分支设置
    })
  }, 60000)

  it('auto 模式：answerFor 给出答案后命令继续跑完（不中止、不交回）', async () => {
    await withTerm(async (m, id) => {
      const asked: string[] = []
      const r = await m.execCapture(id, `read -p "continue? (y/n) " answer; echo "ANSWER=$answer"`, undefined, 60000, {
        answerFor: async (prompt) => { asked.push(prompt); return 'y' },
      })
      expect(asked.length, '应该问过一次「怎么答」').toBeGreaterThan(0)
      expect(asked[0]).toContain('y/n')
      // 答案被写进终端 → read 读到 y → 后面的 echo 照常执行 → 命令正常结束
      expect(r.handedOff).toBeUndefined()
      expect(r.exitCode, `实际输出=${JSON.stringify(r.output)}`).toBe(0)
      expect(r.output).toContain('ANSWER=y')
      // 替用户答过什么要随结果带上去（界面上显示「AI 替你答了 y」，模型也看得到）
      expect(r.autoAnswered).toEqual(['y'])
    })
  }, 90000)

  it('auto 模式：answerFor 返回 undefined 时保留现场交回', async () => {
    await withTerm(async (m, id) => {
      const r = await m.execCapture(id, `read -p "password: " pw`, undefined, 60000, {
        answerFor: async () => undefined,
      })
      expect(r.needsInput).toBeTruthy()
      expect(r.handedOff).toBe(true)
    })
  }, 90000)
})
