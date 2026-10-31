import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KnownHostsStore, sshFingerprint } from './KnownHostsStore.js'

let dir: string
afterEach(() => { if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true }) })

const ED = 'AAAAC3NzaC1lZDI1NTE5AAAAIPuPPNR4cf2RJdo1h5OY6qMJ6JOXz9Qm3mcaC4ceTGlV'
const ED_FP = 'SHA256:UiG9tQ7lJVMbwewNM1yjoID5j9DG3/na8u+4OskMpDo'   // ssh-keygen -lf 结果

describe('KnownHostsStore', () => {
  it('记住/替换/删除，跨实例持久化', () => {
    dir = mkdtempSync(join(tmpdir(), 'kh-'))
    const s = new KnownHostsStore(dir)
    s.put('a:22', 'ssh-ed25519', 'SHA256:x')
    s.put('b:22', 'ssh-rsa', 'SHA256:y')
    s.put('a:22', 'ssh-ed25519', 'SHA256:z')   // 换钥后替换
    const r = new KnownHostsStore(dir)
    expect(r.list().map((k) => [k.hostPort, k.fingerprint])).toEqual([['b:22', 'SHA256:y'], ['a:22', 'SHA256:z']])
    expect(r.get('a:22')?.firstSeen).toMatch(/^\d{4}-/)
    r.remove('b:22')
    expect(new KnownHostsStore(dir).get('b:22')).toBeUndefined()
  })

  it('指纹与 ssh-keygen 一致', () => {
    expect(sshFingerprint(Buffer.from(ED, 'base64'))).toBe(ED_FP)
  })

  it('导入 OpenSSH known_hosts：明文条目、[host]:port、多钥取 ed25519；跳过哈希/标记/通配；不覆盖已有', () => {
    dir = mkdtempSync(join(tmpdir(), 'kh-'))
    const s = new KnownHostsStore(dir)
    s.put('keep.example:22', 'ssh-rsa', 'SHA256:old')
    const text = [
      '# comment',
      `Web.Example,10.0.0.1 ssh-rsa ${Buffer.from('rsa').toString('base64')}`,
      `web.example ssh-ed25519 ${ED}`,
      `[jump.example]:2222 ssh-ed25519 ${ED} c`,
      `|1|abc=|def= ssh-ed25519 ${ED}`,
      `@cert-authority *.example ssh-ed25519 ${ED}`,
      `*.wild ssh-ed25519 ${ED}`,
      `keep.example ssh-ed25519 ${ED}`,
      `x.example sk-ssh-ed25519@openssh.com ${ED}`,
    ].join('\r\n')
    expect(s.importOpenSsh(text)).toBe(3)
    const m = Object.fromEntries(s.list().map((k) => [k.hostPort, `${k.keyType} ${k.fingerprint}`]))
    expect(m).toEqual({
      'keep.example:22': 'ssh-rsa SHA256:old',
      'web.example:22': `ssh-ed25519 ${ED_FP}`,
      '10.0.0.1:22': `ssh-rsa ${sshFingerprint(Buffer.from('rsa'))}`,
      'jump.example:2222': `ssh-ed25519 ${ED_FP}`,
    })
  })
})
