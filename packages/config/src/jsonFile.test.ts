import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, renameSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicWrite } from './jsonFile.js'

const eperm = () => Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })

describe('atomicWrite', () => {
  it('rename 偶发 EPERM（Windows 文件被占用）：重试成功', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'jf-')), 'a.json')
    let n = 0
    atomicWrite(f, '{"v":1}', (a, b) => { if (n++ < 2) throw eperm(); renameSync(a, b) })
    expect(readFileSync(f, 'utf8')).toBe('{"v":1}')
    expect(n).toBe(3)
  })

  it('一直 EPERM：退回直接写，不抛错，也不留 .tmp', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'jf-')), 'a.json')
    atomicWrite(f, '{"v":2}', () => { throw eperm() })
    expect(readFileSync(f, 'utf8')).toBe('{"v":2}')
    expect(existsSync(`${f}.tmp`)).toBe(false)
  })

  it('其它错误照常抛出', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'jf-')), 'a.json')
    expect(() => atomicWrite(f, 'x', () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }) })).toThrow('ENOSPC')
  })
})
