import { describe, it, expect } from 'vitest'
import { JOB_DIR, buildStopBackgroundCommand } from './terminalTools.js'

// 停止命令的形态锁死：手测发现只 kill 记录的 pid 会留下真正在跑的进程
// （nohup 那层死了，子进程被 init 接管继续跑），所以必须是「按 PPID 递归杀整棵树」。
describe('停止后台任务的命令', () => {
  const job = 'a1b2c3d4e5f60718'
  const cmd = buildStopBackgroundCommand(job)

  it('读该任务的 pid 文件，并在任务已消失时报 gone', () => {
    expect(cmd).toContain(`${JOB_DIR}/${job}.pid`)
    expect(cmd).toContain(`${job} gone`)
    expect(cmd).toContain(`${job} cancelled`)
  })

  it('按 ps -ef 的父进程关系递归杀子进程（先 TERM，超时再 KILL）', () => {
    expect(cmd).toContain('ps -ef')
    expect(cmd).toContain('$3==pp')        // PPID 匹配（前三列是 UID PID PPID，MSYS 与 Linux 一致）
    expect(cmd).toContain('kt TERM')
    expect(cmd).toContain('kt KILL')
  })

  it('非法 job_id 直接拒绝，不拼进命令', () => {
    expect(() => buildStopBackgroundCommand('../../etc/passwd')).toThrow()
  })
})
