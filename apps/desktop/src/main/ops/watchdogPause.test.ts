import { it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WatchdogScheduler, WatchdogStore } from './watchdog.js'

// 全局暂停：到点不检查、落盘重启后保持、变化有通知；「立即检查」照常；报警数统计
it('看门狗全局暂停 / 恢复', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wdp-'))
  try {
    const store = new WatchdogStore(dir)
    const w = store.save({ name: 'x', condition: 'c', script: 'echo ok', targets: ['local'], intervalMin: 1, threshold: 1, autoSession: false, enabled: true })
    const run = vi.fn(async () => ({ status: 'fail' as const, exitCode: 1, output: '触发\n', ms: 1 }))
    const onPaused = vi.fn()
    const mk = () => new WatchdogScheduler({
      list: () => store.list(), hosts: () => [], run, loadStates: () => store.loadStates(), saveStates: (s) => store.saveStates(s),
      emit: () => {}, notify: () => {}, openSession: async () => 's', unitMs: 1000,
      loadPaused: () => store.loadPaused(), savePaused: (p) => store.savePaused(p), onPaused,
    })
    const sch = mk()
    expect(sch.paused).toBe(false)
    sch.setPaused(true)
    expect(onPaused).toHaveBeenCalledWith(true)
    sch.tick(1_000_000)
    expect(run).not.toHaveBeenCalled()
    expect(mk().paused).toBe(true)                 // 落盘：重启后仍暂停
    await sch.checkNow(w.id)                        // 手动检查照常
    expect(run).toHaveBeenCalledTimes(1)
    expect(sch.firingCount()).toBe(1)
    sch.setPaused(true)                             // 没变不重复通知
    expect(onPaused).toHaveBeenCalledTimes(1)
    sch.setPaused(false)
    sch.tick(Date.now() + 10_000)                   // 「立即检查」记了上次时间，过一个间隔后到点检查
    await new Promise((r) => setTimeout(r, 20))
    expect(run).toHaveBeenCalledTimes(2)
    store.delete(w.id)
    expect(sch.firingCount()).toBe(0)               // 删了的不算
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
