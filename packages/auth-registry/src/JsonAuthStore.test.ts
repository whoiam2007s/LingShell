import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonAuthStore } from './JsonAuthStore.js'

let dir: string
afterEach(() => { if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true }) })

describe('JsonAuthStore', () => {
  it('save then load roundtrips', () => {
    dir = mkdtempSync(join(tmpdir(), 'authstore-'))
    const file = join(dir, 'auth.json')
    const s1 = new JsonAuthStore(file)
    s1.save({ records: [{ sessionId: 's1', terminalId: 't1', level: 'write' }], trust: { s1: 'confirm' } })
    const s2 = new JsonAuthStore(file)
    const st = s2.load()
    expect(st.records).toEqual([{ sessionId: 's1', terminalId: 't1', level: 'write' }])
    expect(st.trust).toEqual({ s1: 'confirm' })
  })
  it('load on missing file returns empty state', () => {
    dir = mkdtempSync(join(tmpdir(), 'authstore-'))
    const s = new JsonAuthStore(join(dir, 'nope.json'))
    expect(s.load()).toEqual({ records: [], trust: {} })
  })
})
