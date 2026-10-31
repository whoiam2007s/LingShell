import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeText } from '@lingshell/shared'
import { compareFiles, compareTexts, readForCompare } from './fileCompare.js'
import { localAccess, type FileAccess } from './fileOps.js'

// 内存里的一台主机：files 里没有的路径 = 不存在；err 有值时读取抛该错误
function fakeHost(files: Record<string, string | Buffer>, opts: { encoding?: string; err?: unknown } = {}): () => Promise<FileAccess> {
  const fa: FileAccess = {
    encoding: opts.encoding,
    resolve: async (p) => p,
    read: async (p, max = Infinity) => {
      if (opts.err) throw opts.err
      const v = files[p]
      if (v === undefined) return undefined
      const buf = typeof v === 'string' ? Buffer.from(v) : v
      if (buf.length > max) throw new Error(`文件过大（${buf.length} > ${max}）`)
      return buf
    },
    write: async () => { throw new Error('比对不该写文件') },
    mkdirp: async () => { throw new Error('比对不该建目录') },
    backupDir: async () => '/tmp',
  }
  return async () => fa
}

const P = '/etc/nginx/nginx.conf'

describe('compareFiles', () => {
  it('多台对基准：相同 / 不同（+N −M）/ 基准自身', async () => {
    const r = await compareFiles([
      fakeHost({ [P]: 'a\nb\nc\n' }),
      fakeHost({ [P]: 'a\nb\nc\n' }),
      fakeHost({ [P]: 'a\nB\nc\nd\n' }),
    ], P, 0)
    expect(r[0]).toEqual({ status: 'baseline' })
    expect(r[1]).toEqual({ status: 'same' })
    expect(r[2]).toMatchObject({ status: 'diff', added: 2, removed: 1 })
    expect((r[2] as { diff: string }).diff).toContain('-b\n+B')
  })

  it('单台失败只标这一台：不存在 / 无权限 / 连不上，其余照常比', async () => {
    const r = await compareFiles([
      fakeHost({ [P]: 'x\n' }),
      fakeHost({}),
      fakeHost({}, { err: Object.assign(new Error('Permission denied'), { code: 3 }) }),
      async () => { throw new Error('连接超时') },
      fakeHost({ [P]: 'x\n' }),
    ], P, 0)
    expect(r.map((x) => x.status)).toEqual(['baseline', 'error', 'error', 'error', 'same'])
    expect(r[1]).toEqual({ status: 'error', error: '文件不存在' })
    expect(r[2]).toEqual({ status: 'error', error: '没有读取权限' })
    expect(r[3]).toEqual({ status: 'error', error: '连接超时' })
  })

  it('基准读取失败：其它读成功的标 skipped，不误报相同/不同', async () => {
    const r = await compareFiles([fakeHost({ [P]: 'x' }), fakeHost({})], P, 1)
    expect(r).toEqual([{ status: 'skipped' }, { status: 'error', error: '文件不存在' }])
  })

  it('换基准下标：diff 方向跟着变（基准是旧、目标是新）', async () => {
    const hosts = [fakeHost({ [P]: 'old\n' }), fakeHost({ [P]: 'new\n' })]
    const r = await compareFiles(hosts, P, 1)
    expect(r[1]).toEqual({ status: 'baseline' })
    expect((r[0] as { diff: string }).diff).toContain('-new\n+old')
  })

  it('忽略空白和注释行：只差这些时判相同；有实际差异仍报不同', async () => {
    const hosts = [
      fakeHost({ [P]: 'worker_processes 4;\n' }),
      fakeHost({ [P]: '# 调优\n  worker_processes   4;\n\n' }),
      fakeHost({ [P]: '; x\nworker_processes 8;' }),
    ]
    expect((await compareFiles(hosts, P, 0)).map((x) => x.status)).toEqual(['baseline', 'diff', 'diff'])
    const r = await compareFiles(hosts, P, 0, true)
    expect(r.map((x) => x.status)).toEqual(['baseline', 'same', 'diff'])
    expect(r[2]).toMatchObject({ added: 1, removed: 1 })
  })

  it('读取卡住按超时计失败，不拖住其它台', async () => {
    const r = await compareFiles([fakeHost({ [P]: 'x' }), () => new Promise<FileAccess>(() => {})], P, 0, false, 20)
    expect(r[1]).toEqual({ status: 'error', error: '读取超时（0.02s）' })
  })
})

describe('readForCompare', () => {
  it('按主机编码解码（GBK）', async () => {
    const r = await readForCompare(fakeHost({ [P]: Buffer.from(encodeText('服务器名=测试\n', 'gbk')) }, { encoding: 'gbk' }), P)
    expect(r).toEqual({ ok: true, text: '服务器名=测试\n' })
  })

  it('二进制文件拒绝', async () => {
    expect(await readForCompare(fakeHost({ [P]: Buffer.from([1, 0, 2]) }), P)).toEqual({ ok: false, error: '二进制文件，不比对' })
  })

  it('大小上限：真实本地 fs 超过上限报错、未超过正常读', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingshell-cmp-'))
    const f = join(dir, 'big.conf')
    writeFileSync(f, 'x'.repeat(2048))
    const r = await readForCompare(async () => localAccess(), f, 1024)
    expect(r.ok).toBe(false)
    expect((r as { error: string }).error).toMatch(/文件过大.*1KB/)
    expect(await readForCompare(async () => localAccess(), f, 4096)).toEqual({ ok: true, text: 'x'.repeat(2048) })
  })
})

describe('compareTexts', () => {
  it('只差末尾换行：不忽略时报不同，忽略时相同', () => {
    const reads = [{ ok: true as const, text: 'a\n' }, { ok: true as const, text: 'a' }]
    expect(compareTexts(reads, 0, P)[1]).toMatchObject({ status: 'diff', added: 0, removed: 0 })
    expect(compareTexts(reads, 0, P, true)[1]).toEqual({ status: 'same' })
  })
})
