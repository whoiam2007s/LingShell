import { describe, expect, it } from 'vitest'
import { classifyDockerError, dockerActionCommand, dockerAuditLabel, dockerDecision, dockerExecLine, dockerFollowLine, dockerLogsCommand, dockerPsCommand, dockerSupported, isDockerRef, parseDockerPs, parseDockerStats, splitRc, statFor } from './docker.js'

const PS = [
  'Welcome to Ubuntu 22.04',   // 登录横幅
  '{"Command":"\\"nginx -g\\"","CreatedAt":"2026-10-01 10:00:00 +0800 CST","ID":"a1b2c3d4e5f6","Image":"nginx:1.27","Names":"web","Ports":"0.0.0.0:80->80/tcp","RunningFor":"2 weeks ago","State":"running","Status":"Up 3 days"}',
  '{"ID":"0123456789ab","Image":"redis","Names":"cache,alias","Status":"Exited (0) 2 hours ago","RunningFor":"3 days ago"}',
  '{"ID":"ffff00001111","Image":"x","Names":"bad;rm -rf /","Status":"Up 1 second"}',   // 名称不合规 → 跳过
  '{"ID":"broken json',
  '[1,2]',
].join('\n')

describe('parseDockerPs', () => {
  it('解析 JSON 行，跳过横幅 / 坏行 / 不合规标识', () => {
    const cs = parseDockerPs(PS)
    expect(cs).toHaveLength(2)
    expect(cs[0]).toEqual({ id: 'a1b2c3d4e5f6', name: 'web', image: 'nginx:1.27', status: 'Up 3 days', state: 'running', ports: '0.0.0.0:80->80/tcp', created: '2026-10-01 10:00:00 +0800 CST' })
    expect(cs[1]).toMatchObject({ name: 'cache', state: 'exited', created: '3 days ago' })   // 无 State 字段从 Status 推；多名取第一个
  })
  it('从 Status 推 paused / created', () => {
    expect(parseDockerPs('{"ID":"abc","Names":"p","Status":"Up 1 hour (Paused)"}\n{"ID":"abd","Names":"q","Status":"Created"}').map((c) => c.state)).toEqual(['paused', 'created'])
  })
})

describe('parseDockerStats', () => {
  it('按短 id / 名称匹配', () => {
    const m = parseDockerStats('{"BlockIO":"0B / 0B","CPUPerc":"1.25%","Container":"a1b2c3d4e5f6","ID":"a1b2c3d4e5f6","MemPerc":"0.50%","MemUsage":"10MiB / 2GiB","Name":"web"}\nnot json\n{"ID":"x"}')
    const web = parseDockerPs(PS)[0]
    expect(statFor(m, web)).toEqual({ cpu: '1.25%', mem: '10MiB / 2GiB', memPct: '0.50%' })
    expect(statFor(m, { ...web, name: 'other', id: 'a1b2c3d4e5f6deadbeef' })?.cpu).toBe('1.25%')   // 长 id 按前缀
    expect(statFor(m, { ...web, name: 'other', id: 'zzz' })).toBeUndefined()
  })
})

describe('splitRc', () => {
  it('取最后一个退出码标记', () => {
    expect(splitRc('hello\n@@rc:0 fake\nreal\n@@rc:127\n')).toEqual({ rc: 127, text: 'hello\n@@rc:0 fake\nreal' })
    expect(splitRc('truncated...')).toEqual({ rc: undefined, text: 'truncated...' })
  })
})

describe('classifyDockerError', () => {
  it('未安装', () => {
    expect(classifyDockerError(127, 'sh: 1: docker: not found', 'docker')).toBe('missing')
    expect(classifyDockerError(127, 'sh: docker: command not found', 'docker')).toBe('missing')
  })
  it('无权限（不在 docker 组）', () => {
    expect(classifyDockerError(1, 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.24/containers/json": dial unix /var/run/docker.sock: connect: permission denied', 'docker')).toBe('permission')
    expect(classifyDockerError(1, 'Got permission denied while trying to connect to the Docker daemon socket', 'docker')).toBe('permission')
  })
  it('daemon 未运行', () => {
    expect(classifyDockerError(1, 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?', 'docker')).toBe('daemon')
  })
  it('sudo -n 要密码 / 不在 sudoers', () => {
    expect(classifyDockerError(1, 'sudo: a password is required', 'sudo')).toBe('sudo_denied')
    expect(classifyDockerError(1, 'alice is not in the sudoers file.  This incident will be reported.', 'sudo')).toBe('sudo_denied')
    expect(classifyDockerError(127, 'sh: 1: sudo: not found', 'sudo')).toBe('sudo_denied')
    expect(classifyDockerError(127, 'sudo: docker: command not found', 'sudo')).toBe('missing')
  })
  it('其它', () => { expect(classifyDockerError(1, 'Error: No such container: x', 'docker')).toBe('error') })
})

describe('命令构造 + 标识校验', () => {
  it('isDockerRef', () => {
    for (const ok of ['web', 'a1b2c3', 'my_app.v2-1']) expect(isDockerRef(ok)).toBe(true)
    for (const bad of ['', '-rm', '.x', 'a b', 'a;b', 'a$(id)', "a'b", 'a`b', 'a|b', 'x'.repeat(129), 42]) expect(isDockerRef(bad)).toBe(false)
  })
  it('sh -c 包装 + 退出码标记 + sudo -n', () => {
    expect(dockerPsCommand('docker')).toBe(`sh -c 'export LC_ALL=C; docker ps -a --format '\\''{{json .}}'\\'' 2>&1; echo "@@rc:$?"'`)
    expect(dockerLogsCommand('sudo', 'web')).toContain('sudo -n docker logs --tail 200 web 2>&1')
    expect(dockerActionCommand('docker', 'restart', 'web')).toContain('docker restart web 2>&1')
  })
  it('非法标识拒绝构造', () => {
    expect(() => dockerLogsCommand('docker', 'a;reboot')).toThrow()
    expect(() => dockerActionCommand('docker', 'stop', '$(id)')).toThrow()
    expect(() => dockerExecLine('docker', "x' ; rm -rf / '")).toThrow()
    expect(() => dockerFollowLine('docker', '-f')).toThrow()
  })
  it('终端命令', () => {
    expect(dockerFollowLine('docker', 'web')).toBe('docker logs -f --tail 100 web')
    expect(dockerExecLine('sudo', 'web')).toBe(`sudo -n docker exec -it web sh -c 'command -v bash >/dev/null && exec bash || exec sh'`)
  })
  it('只支持 SSH Linux / macOS', () => {
    expect(dockerSupported('ssh', 'linux')).toBe(true)
    expect(dockerSupported('ssh', 'windows')).toBe(false)
    expect(dockerSupported('local', 'linux')).toBe(false)
  })
})

describe('执行记录标签', () => {
  it('docker_* → 中文', () => {
    expect(dockerDecision('stop')).toBe('docker_stop')
    expect(dockerAuditLabel('docker_start')).toBe('容器启动')
    expect(dockerAuditLabel('docker_restart')).toBe('容器重启')
    expect(dockerAuditLabel('docker_rm')).toBeUndefined()
    expect(dockerAuditLabel('exec_allowed')).toBeUndefined()
  })
})
