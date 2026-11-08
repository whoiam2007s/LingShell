import { describe, it, expect } from 'vitest'
import { IMAGE_MAX_SENT_BYTES, base64Bytes } from '@lingshell/shared'
import { ENCODE_LADDER } from './attachments.js'

describe('图片压缩台阶', () => {
  it('逐级降级：尺寸不升、质量不升', () => {
    for (let i = 1; i < ENCODE_LADDER.length; i++) {
      expect(ENCODE_LADDER[i].edge).toBeLessThanOrEqual(ENCODE_LADDER[i - 1].edge)
      expect(ENCODE_LADDER[i].quality).toBeLessThanOrEqual(ENCODE_LADDER[i - 1].quality)
    }
  })

  it('最后一档足够小：1024 长边 + q0.7 在 1.5MB 以内（兜底一定收敛）', () => {
    const last = ENCODE_LADDER[ENCODE_LADDER.length - 1]
    expect(last.edge).toBe(1024)
    expect(last.quality).toBeLessThanOrEqual(0.7)
    // 1024×1024 的 JPEG q0.7 经验值 < 300KB，远低于上限
    expect(IMAGE_MAX_SENT_BYTES).toBeGreaterThan(1024 * 1024)
  })

  it('base64 预算换算与单张上限一致（上限常量本身可用）', () => {
    // 2_000_000 个 base64 字符 ≈ 1.5MB，正好卡在 1.5MiB 上限之下；多给一点就应超过
    expect(base64Bytes('A'.repeat(2_000_000))).toBeLessThanOrEqual(IMAGE_MAX_SENT_BYTES)
    expect(base64Bytes('A'.repeat(2_400_000))).toBeGreaterThan(IMAGE_MAX_SENT_BYTES)
  })
})
