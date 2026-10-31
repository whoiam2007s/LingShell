import { describe, it, expect } from 'vitest'
import { deflateSync } from 'node:zlib'
import { imageInfo } from './attachments.js'
import { deepseekModels, withRoute } from './providers.js'
import { userMessageView } from './relay.js'

const u8 = (a: number[]) => new Uint8Array(a)

describe('imageInfo', () => {
  it('PNG', () => {
    const b = Buffer.alloc(33)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
    b.writeUInt32BE(640, 16); b.writeUInt32BE(480, 20)
    expect(imageInfo(b)).toEqual({ mediaType: 'image/png', width: 640, height: 480 })
  })
  it('GIF / JPEG / WebP', () => {
    expect(imageInfo(u8([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x10, 0x00, 0x08, 0x00]))).toEqual({ mediaType: 'image/gif', width: 16, height: 8 })
    // SOI + APP0(长度 4) + SOF0：高 0x0100、宽 0x0200
    const jpg = u8([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x00, 0x02, 0x00, 0x03, 0, 0, 0, 0])
    expect(imageInfo(jpg)).toEqual({ mediaType: 'image/jpeg', width: 512, height: 256 })
    const webp = Buffer.alloc(30)
    webp.write('RIFF', 0); webp.write('WEBP', 8); webp.write('VP8X', 12)
    webp.writeUIntLE(99, 24, 3); webp.writeUIntLE(49, 27, 3)
    expect(imageInfo(webp)).toEqual({ mediaType: 'image/webp', width: 100, height: 50 })
  })
  it('认不出的返回 undefined', () => {
    expect(imageInfo(deflateSync('hello'))).toBeUndefined()
  })
})

describe('支持图片 → 路由的模型输入模态', () => {
  it('pi-ai 路由：开了声明 text+image，关了只有 text', () => {
    const base = { profileId: 'p', provider: 'openai-compatible', model: 'm', baseUrl: 'http://x/v1' }
    expect(withRoute({}, { ...base, multimodal: true })['lingshell-p-p'].models[0].input).toEqual(['text', 'image'])
    expect(withRoute({}, base)['lingshell-p-p'].models[0].input).toEqual(['text'])
  })
  it('DeepSeek 目录：没有的模型补一条，有的改模态；关掉去掉图片专属字段', () => {
    const cat = [{ id: 'deepseek-flash', inputModalities: ['text', 'image'], imageMaxBytes: 100 }, { id: 'deepseek-v4-pro', contextWindow: 9 }]
    expect(deepseekModels(cat, 'deepseek-v4-pro', true)[1]).toEqual({ id: 'deepseek-v4-pro', contextWindow: 9, inputModalities: ['text', 'image'], imageMaxBytes: 2097152 })
    expect(deepseekModels(cat, 'deepseek-flash', false)[0]).toEqual({ id: 'deepseek-flash', inputModalities: ['text'] })
    expect(deepseekModels(cat, 'my-model', true).at(-1)).toMatchObject({ id: 'my-model', inputModalities: ['text', 'image'] })
    expect(cat[1]).toEqual({ id: 'deepseek-v4-pro', contextWindow: 9 })   // 不改入参
  })
})

describe('userMessageView', () => {
  it('拆出原话、路径附件与图片附件', () => {
    const v = userMessageView([
      { type: 'text', text: '看看\n\n[附带的本地路径]\n- 文件：/tmp/a.log\n（以上…）' },
      { type: 'image', attachment: { attachmentId: 'abc', name: 'shot.png' } },
    ])
    expect(v).toEqual({ text: '看看', attachments: [{ kind: 'file', name: 'a.log', path: '/tmp/a.log' }, { kind: 'image', name: 'shot.png', imageId: 'abc' }] })
  })
})
