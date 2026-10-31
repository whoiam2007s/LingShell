import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { KnownHost } from '@lingshell/shared'
import { readJson, writeJson } from './jsonFile.js'

// SSH 主机指纹（TOFU，同 OpenSSH known_hosts）：<dir>/known_hosts.json，以 hostPort 为键。原子写。
export const hostPortOf = (host: string, port: number) => `${host.trim().toLowerCase()}:${port}`

// OpenSSH 风格指纹：SHA256 + base64 去掉尾部 '='
export const sshFingerprint = (keyBlob: Buffer) => 'SHA256:' + createHash('sha256').update(keyBlob).digest('base64').replace(/=+$/, '')

// 导入时同一主机多把钥匙取优先级最高的（与 ssh2 默认协商顺序一致）；不在表里的类型不导入
const TYPE_RANK = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'ssh-rsa']

export class KnownHostsStore {
  private file: string
  constructor(dir: string) { this.file = join(dir, 'known_hosts.json') }

  list(): KnownHost[] { return readJson<KnownHost[]>(this.file) ?? [] }
  get(hostPort: string): KnownHost | undefined { return this.list().find((k) => k.hostPort === hostPort) }

  // 记住 / 替换（换钥后）。firstSeen 记本次时间
  put(hostPort: string, keyType: string, fingerprint: string): KnownHost {
    const k: KnownHost = { hostPort, keyType, fingerprint, firstSeen: new Date().toISOString() }
    writeJson(this.file, [...this.list().filter((x) => x.hostPort !== hostPort), k])
    return k
  }

  remove(hostPort: string): void { writeJson(this.file, this.list().filter((x) => x.hostPort !== hostPort)) }

  // 从 OpenSSH known_hosts 文本导入明文条目：跳过哈希(|1|)、@cert-authority/@revoked、通配符/否定模式；已有记录的不覆盖。返回新增条数
  importOpenSsh(text: string): number {
    const found = new Map<string, { keyType: string; fingerprint: string }>()
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith('#') || line.startsWith('@') || line.startsWith('|')) continue
      const [hosts, keyType, b64] = line.split(/\s+/)
      if (!b64 || !TYPE_RANK.includes(keyType)) continue
      const fingerprint = sshFingerprint(Buffer.from(b64, 'base64'))
      for (const h of hosts.split(',')) {
        if (/[*?!]/.test(h)) continue
        const m = /^\[(.+)\]:(\d+)$/.exec(h)
        const hp = m ? hostPortOf(m[1], Number(m[2])) : hostPortOf(h, 22)
        const prev = found.get(hp)
        if (!prev || TYPE_RANK.indexOf(keyType) < TYPE_RANK.indexOf(prev.keyType)) found.set(hp, { keyType, fingerprint })
      }
    }
    const all = this.list()
    const now = new Date().toISOString()
    let n = 0
    for (const [hostPort, v] of found) {
      if (all.some((x) => x.hostPort === hostPort)) continue
      all.push({ hostPort, ...v, firstSeen: now }); n++
    }
    if (n) writeJson(this.file, all)
    return n
  }
}
