import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { forwardSlot, type PortForwardInput, type SavedPortForward } from '@lingshell/shared'
import { readJson, writeJson } from './jsonFile.js'

// 已保存的端口转发 <dir>/port-forwards.json（明文，无凭据：连接时按 hostId 现取主机配置）。
// 同主机同占用端口（-L/-D 本地端口，-R 服务器端口）视为同一条，再次保存覆盖规则、保留 autoStart。
export class PortForwardStore {
  private file: string
  constructor(dir: string) { this.file = join(dir, 'port-forwards.json') }

  list(): SavedPortForward[] { return readJson<SavedPortForward[]>(this.file) ?? [] }

  save(raw: PortForwardInput): SavedPortForward {
    // 只留规则字段（UI 可能直接传运行中的 PortForwardInfo，带 id/status）
    const input: PortForwardInput = raw.kind === 'dynamic'
      ? { hostId: raw.hostId, kind: 'dynamic', localPort: raw.localPort, ...(raw.bindHost ? { bindHost: raw.bindHost } : {}) }
      : raw.kind === 'remote'
        ? { hostId: raw.hostId, kind: 'remote', remotePort: raw.remotePort, ...(raw.remoteBind ? { remoteBind: raw.remoteBind } : {}), localHost: raw.localHost, localPort: raw.localPort }
        : { hostId: raw.hostId, localPort: raw.localPort, remoteHost: raw.remoteHost, remotePort: raw.remotePort }
    const all = this.list()
    const slot = forwardSlot(input)
    const i = all.findIndex((s) => s.hostId === input.hostId && forwardSlot(s.input) === slot)
    const s: SavedPortForward = { id: all[i]?.id ?? `pf_${randomUUID().slice(0, 8)}`, hostId: input.hostId, input, autoStart: all[i]?.autoStart ?? false }
    if (i >= 0) all[i] = s; else all.push(s)
    writeJson(this.file, all)
    return s
  }

  setAutoStart(id: string, on: boolean): void {
    writeJson(this.file, this.list().map((s) => (s.id === id ? { ...s, autoStart: on } : s)))
  }

  delete(id: string): void { writeJson(this.file, this.list().filter((s) => s.id !== id)) }
  deleteByHost(hostId: string): void {
    const all = this.list(), left = all.filter((s) => s.hostId !== hostId)
    if (left.length !== all.length) writeJson(this.file, left)
  }

  // 应用启动时要自动开启的：autoStart 且主机仍存在
  autoStartList(hostIds: string[]): SavedPortForward[] {
    const ok = new Set(hostIds)
    return this.list().filter((s) => s.autoStart && ok.has(s.hostId))
  }
}
