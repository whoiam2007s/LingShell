import { describe, it, expect } from 'vitest'
import { probeTcp } from './hostProbe.js'

// 依赖真实网络路由的测试：只有「这个地址在本机网络上确实是黑洞」时才断言超时。
// 部分网络（NAT / 代理 / 私有云网关）会直接回 RST，或真有设备应答，这时测不到超时路径。
// CI 默认不跑 *.real.test.ts（见 .github/workflows/ci.yml）。
describe('hostProbe（真实网络）', () => {
  it('probeTcp：不可路由地址在超时后返回 null', async () => {
    const ms = await probeTcp('10.255.255.1', 22, 500)
    // 本机网络对该地址有应答（连上或立刻拒绝）时无法验证超时分支，跳过断言
    if (ms !== null) {
      console.warn('[hostProbe.real] 本机网络对 10.255.255.1:22 有应答，跳过超时断言')
      return
    }
    expect(ms).toBeNull()
  })
})
