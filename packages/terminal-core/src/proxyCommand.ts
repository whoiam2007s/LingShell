import { spawn, type ChildProcess } from 'node:child_process'
import { Duplex } from 'node:stream'

// ProxyCommand（同 OpenSSH）：本机起一个命令，它的 stdin/stdout 就是到目标 sshd 的连接
// （cloudflared access ssh / aws ssm start-session / tsh proxy ssh / ssh -W %h:%p jump / nc %h %p ……）。
// 命令只来自用户自己的主机配置；连接结束（成功后断开 / 握手失败）都要把子进程连同其子孙一起结束。

/** 替换 %h 主机、%p 端口、%r 用户名、%% 字面 %（其它 %x 原样保留） */
export function expandProxyCommand(cmd: string, host: string, port: number, user: string): string {
  return cmd.replace(/%([hpr%])/g, (_m, k: string) => (k === 'h' ? host : k === 'p' ? String(port) : k === 'r' ? user : '%'))
}

export interface ProxyCommandSock {
  sock: Duplex
  stderr(): string     // 最近的错误输出（报错时附上）
  kill(): void         // 结束子进程树（幂等）
  exited(): boolean
}

const STDERR_MAX = 4000

/** 启动代理命令（Windows 用 cmd /d /s /c，其它用 /bin/sh -c），返回给 ssh2 作 sock 的双工流 */
export function spawnProxyCommand(command: string): ProxyCommandSock {
  const win = process.platform === 'win32'
  // Windows：/s + 整体加引号，命令原样交给 cmd 解析（引号/管道都照用户写的）。其它：独立进程组，结束时整组 kill
  const cp: ChildProcess = win
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], { windowsVerbatimArguments: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    : spawn('/bin/sh', ['-c', command], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let err = '', done = false, killed = false
  cp.stderr!.on('data', (b: Buffer) => { err = (err + b.toString('utf8')).slice(-STDERR_MAX) })
  cp.on('exit', () => { done = true })
  const sock = Duplex.from({ readable: cp.stdout!, writable: cp.stdin! })
  cp.on('error', (e) => { done = true; err += `\n${e.message}`; sock.destroy(e) })
  sock.on('error', () => { /* 子进程退出后的 EPIPE 等：由 ssh2 的 close/错误路径处理 */ })
  const kill = () => {
    if (killed) return
    killed = true
    try { cp.stdin?.end() } catch { /* 已关 */ }
    if (done || cp.pid === undefined) return
    if (win) spawn('taskkill', ['/pid', String(cp.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => { try { cp.kill() } catch { /* 已退 */ } })
    else { try { process.kill(-cp.pid, 'SIGTERM') } catch { try { cp.kill('SIGTERM') } catch { /* 已退 */ } } }
  }
  return { sock, stderr: () => err.trim(), kill, exited: () => done }
}
