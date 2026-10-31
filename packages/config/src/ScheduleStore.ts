import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { tr, type InspectionSchedule, type ScheduleInput, type InspectionRun } from '@lingshell/shared'
import { readJson, writeJson } from './jsonFile.js'

// 定时巡检计划 <dir>/schedules.json + 运行记录 <dir>/inspection-runs.json（新在前，保留 maxRuns 条）。原子写。
export class ScheduleStore {
  private file: string
  private runsFile: string
  constructor(dir: string, private maxRuns = 200) {
    this.file = join(dir, 'schedules.json')
    this.runsFile = join(dir, 'inspection-runs.json')
  }

  list(): InspectionSchedule[] { return readJson<InspectionSchedule[]>(this.file) ?? [] }

  save(input: ScheduleInput): InspectionSchedule {
    const name = input.name.trim(), prompt = input.prompt.trim()
    if (!name || !prompt) throw new Error(tr('名称和巡检内容不能为空'))
    if (!input.targets.length) throw new Error(tr('至少选一个目标'))
    const w = input.when
    if (w.kind === 'interval' && !(w.hours >= 1 && w.hours <= 168)) throw new Error(tr('间隔需在 1–168 小时'))
    if (w.kind === 'daily' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(w.time)) throw new Error(tr('时间格式应为 HH:mm'))
    const all = this.list()
    const i = input.id ? all.findIndex((s) => s.id === input.id) : -1
    const prev = i >= 0 ? all[i] : undefined
    const s: InspectionSchedule = {
      id: prev?.id ?? `sch_${randomUUID().slice(0, 8)}`,
      name, prompt, targets: [...input.targets], when: w, enabled: input.enabled,
      notifyWebhooks: input.notifyWebhooks ? [...input.notifyWebhooks] : undefined, notifyOn: input.notifyOn,
      createdAt: prev?.createdAt ?? new Date().toISOString(), lastRunAt: prev?.lastRunAt,
    }
    if (i >= 0) all[i] = s; else all.push(s)
    writeJson(this.file, all)
    return s
  }

  delete(id: string): void { writeJson(this.file, this.list().filter((s) => s.id !== id)) }

  markRun(id: string, at: string): void {
    const all = this.list()
    const s = all.find((x) => x.id === id)
    if (s) { s.lastRunAt = at; writeJson(this.file, all) }
  }

  listRuns(): InspectionRun[] { return readJson<InspectionRun[]>(this.runsFile) ?? [] }

  /** 新增或按 id 覆盖一条运行记录 */
  putRun(run: InspectionRun): void {
    const all = this.listRuns()
    const i = all.findIndex((r) => r.id === run.id)
    if (i >= 0) all[i] = run; else all.unshift(run)
    writeJson(this.runsFile, all.slice(0, this.maxRuns))
  }
}
