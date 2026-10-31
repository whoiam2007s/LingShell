// 本机视图（见 shared/terminal/localSys.ts）：本地终端的「进程」「监听端口」「容器」抽屉在本机取数据，不进用户终端。
// Windows：netstat -ano + tasklist（直接起程序，不经 shell）、taskkill 结束进程；macOS：lsof / ps；Linux：同 SSH 的 ss / ps 命令。
// 容器：本机 docker CLI，经 Git Bash（Windows）/ sh 跑和 SSH 一样的命令（见 docker.ts）。
import {
  PORTS_TIMEOUT_MS, PROC_TIMEOUT_MS, isKillablePid, parseLsofListen, parseNetstatAno, parsePorts, parsePs, parseSignalResult, parseTasklist, portsListCommand,
  processListCommand, processSignalCommand, taskkillArgs, tasksToProcRows,
  type PortList, type ProcList, type ProcSignal,
} from '@lingshell/shared'
import { tr } from '@lingshell/shared'
import { decodeConsole, runFile, runSh } from '../terminal/index.js'

export interface LocalViews {
  ports(): Promise<PortList>
  processes(): Promise<ProcList>
  signal(pid: number, sig: ProcSignal): Promise<{ rc?: number; error?: string }>
  /** 本机 sh 跑一条命令取输出（容器视图用，同 SSH 的 execRead） */
  exec(cmd: string, timeoutMs: number): Promise<string>
}

type Plat = NodeJS.Platform
export function createLocalViews(plat: Plat = process.platform, run = { runSh, runFile }): LocalViews {
  const win = plat === 'win32'
  const sh = async (cmd: string, timeoutMs: number) => (await run.runSh(cmd, { timeoutMs })).output
  const tasks = async () => {
    const r = await run.runFile('tasklist', ['/fo', 'csv', '/nh'], PROC_TIMEOUT_MS)
    return parseTasklist(decodeConsole(r.stdout))
  }
  return {
    async ports() {
      if (win) {
        // netstat 不带 -p 时 TCP / TCPv6 都有；进程名另取 tasklist（取不到就只显示 PID）
        const [ns, ts] = await Promise.all([run.runFile('netstat', ['-ano'], PORTS_TIMEOUT_MS), tasks().catch(() => [])])
        return { rows: parseNetstatAno(decodeConsole(ns.stdout), new Map(ts.map((t) => [t.pid, t.name]))), tool: 'netstat', local: 'windows' }
      }
      if (plat === 'darwin') {
        const r = await run.runFile('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], PORTS_TIMEOUT_MS)
        return { rows: parseLsofListen(r.stdout.toString('utf8')), tool: 'lsof', local: 'unix' }
      }
      const out = await sh(portsListCommand(), PORTS_TIMEOUT_MS)
      if (!out.includes('@@tool:')) throw new Error(tr('读不到监听端口：本机没有 ss / netstat 命令'))
      return { ...parsePorts(out), local: 'unix' }
    },
    async processes() {
      if (win) {
        const rows = tasksToProcRows(await tasks())
        if (!rows.length) throw new Error(tr('读不到进程列表：tasklist 不可用'))
        return { rows, hasCpu: false, truncated: false, local: 'windows' }
      }
      const r = parsePs(await sh(processListCommand(), PROC_TIMEOUT_MS))
      if (!r.rows.length) throw new Error(tr('读不到进程列表：ps 命令不可用'))
      return { ...r, local: 'unix' }
    },
    async signal(pid, sig) {
      if (!isKillablePid(pid)) return { error: tr('不能结束系统进程（PID 0 / 1）') }
      if (win && pid === 4) return { error: tr('不能结束系统进程（PID 4）') }
      if (pid === process.pid) return { error: tr('不能结束灵壳自己') }
      if (win) {
        if (sig === 'HUP') return { error: tr('Windows 没有 HUP 信号') }
        const r = await run.runFile('taskkill', taskkillArgs(pid, sig === 'KILL'), PROC_TIMEOUT_MS)
        if (r.code === 0) return { rc: 0 }
        const msg = decodeConsole(Buffer.concat([r.stderr, r.stdout])).trim()
        // 正则匹配 taskkill 的系统输出（中文 / 英文 Windows）
        // i18n-ignore-next
        return { rc: r.code, error: /拒绝访问|Access is denied/i.test(msg) ? tr('没有权限（该进程属于系统或其他用户，需要以管理员身份运行）')
          : /强行|强制|forcefully/i.test(msg) ? tr('该进程只能强制结束：请用「强制结束」') : msg.slice(0, 500) || tr('结束进程失败') }   // i18n-ignore 正则匹配系统输出
      }
      const { rc, message } = parseSignalResult(await sh(processSignalCommand(pid, sig), PROC_TIMEOUT_MS))
      if (rc === 0) return { rc }
      return { rc, error: /not permitted/i.test(message) ? tr('没有权限（该进程属于其他用户）') : /no such process/i.test(message) ? tr('进程已不存在') : message.slice(0, 500) || tr('发送信号失败') }
    },
    exec: sh,
  }
}
