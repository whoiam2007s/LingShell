import { describe, it, expect } from 'vitest'
import { detectSshAgent, requireSshAgent, type AgentProbe } from './sshAgent.js'

const OPENSSH = '\\\\.\\pipe\\openssh-ssh-agent'
const probe = (p: Partial<AgentProbe> & { files?: string[] }): AgentProbe => ({
  platform: 'win32', env: {}, listPipes: () => [], ...p,
  exists: (f) => (p.files ?? []).includes(f),
})

describe('detectSshAgent', () => {
  it('Windows：OpenSSH agent 管道优先于 Pageant', () => {
    expect(detectSshAgent(probe({ files: [OPENSSH], listPipes: () => ['pageant.me.abc'] })))
      .toEqual({ kind: 'openssh', path: OPENSSH, label: 'Windows OpenSSH agent' })
  })
  it('Windows：无 OpenSSH 服务 → Pageant 的 OpenSSH 兼容管道', () => {
    expect(detectSshAgent(probe({ listPipes: () => ['foo', 'pageant.me.0123abcd'] })))
      .toMatchObject({ kind: 'pageant', path: '\\\\.\\pipe\\pageant.me.0123abcd', label: 'Pageant' })
  })
  it('Windows：管道式 SSH_AUTH_SOCK 可用；cygwin unix socket 不认', () => {
    const sock = '\\\\.\\pipe\\my-agent'
    expect(detectSshAgent(probe({ env: { SSH_AUTH_SOCK: sock }, files: [sock] }))).toMatchObject({ kind: 'sock', path: sock })
    expect(detectSshAgent(probe({ env: { SSH_AUTH_SOCK: '/tmp/ssh-x/agent.1' }, files: ['/tmp/ssh-x/agent.1'] }))).toBeUndefined()
  })
  it('unix：SSH_AUTH_SOCK 存在才算', () => {
    const sock = '/tmp/ssh-x/agent.1'
    expect(detectSshAgent(probe({ platform: 'linux', env: { SSH_AUTH_SOCK: sock }, files: [sock] }))).toMatchObject({ kind: 'sock', path: sock })
    expect(detectSshAgent(probe({ platform: 'darwin', env: { SSH_AUTH_SOCK: sock } }))).toBeUndefined()
    expect(detectSshAgent(probe({ platform: 'linux' }))).toBeUndefined()
  })
  it('requireSshAgent：无 agent → ssh_agent_unavailable', () => {
    expect(() => requireSshAgent(() => undefined)).toThrow(/^ssh_agent_unavailable: 未检测到 ssh-agent\/Pageant/)
    expect(requireSshAgent(() => ({ kind: 'sock', path: '/s', label: 'x' }))).toBe('/s')
  })
})
