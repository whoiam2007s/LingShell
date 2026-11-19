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
})
