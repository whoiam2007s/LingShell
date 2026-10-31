import { it, expect } from 'vitest'
import ssh2 from 'ssh2'
import type { AddressInfo } from 'node:net'
import { connectSsh, setHostKeyPolicy, sshFingerprint } from './sshConnect.js'

// 用真 ssh2 Server（本机回环、随机端口）验证 hostVerifier/算法偏好真的生效，不依赖外部 sshd
const { Server, utils } = ssh2 as unknown as { Server: typeof import('ssh2').Server; utils: typeof import('ssh2').utils }

function server(keys: string[]) {
  const s = new Server({ hostKeys: keys }, (c) => {
    c.on('authentication', (ctx) => ctx.accept())
    c.on('error', () => {})
  })
  return new Promise<{ port: number; close(): void }>((r) => s.listen(0, '127.0.0.1', () => r({ port: (s.address() as AddressInfo).port, close: () => s.close() })))
}

it('真 ssh2：TOFU 全流程 + 多钥服务器按记录类型协商', async () => {
  const ed = utils.generateKeyPairSync('ed25519')
  const rsa = utils.generateKeyPairSync('rsa', { bits: 2048 })
  const srv = await server([ed.private, rsa.private])
  const db = new Map<string, { keyType: string; fingerprint: string }>()
  let asked = 0
  setHostKeyPolicy({ lookup: (hp) => db.get(hp), remember: (hp, keyType, fingerprint) => { db.set(hp, { keyType, fingerprint }) }, prompt: async () => { asked++; return true } })
  const o = { host: '127.0.0.1', port: srv.port, username: 'u', password: 'p' }
  ;(await connectSsh(o)).close()
  expect(asked).toBe(1)
  const rec = db.get(`127.0.0.1:${srv.port}`)!
  expect(rec.keyType).toBe('ssh-ed25519')
  const edBlob = Buffer.from(ed.public.split(' ')[1], 'base64')
  expect(rec.fingerprint).toBe(sshFingerprint(edBlob))
  // 记录成 rsa → 应协商 rsa 而不是误报不符
  const rsaBlob = Buffer.from(rsa.public.split(' ')[1], 'base64')
  db.set(`127.0.0.1:${srv.port}`, { keyType: 'ssh-rsa', fingerprint: sshFingerprint(rsaBlob) })
  ;(await connectSsh(o)).close()
  // 篡改记录 → 不符
  db.set(`127.0.0.1:${srv.port}`, { keyType: 'ssh-ed25519', fingerprint: 'SHA256:xxx' })
  await expect(connectSsh(o)).rejects.toThrow(/^host_key_mismatch/)
  srv.close()
}, 20000)
