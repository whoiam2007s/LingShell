// 资源管理器的 sudo 模式：远程的列目录 / 读写 / 新建 / 改名 / 删除 / 改权限都改成在服务器上经 sudo 跑命令（走该终端的独立 exec channel）。
// 密码：先试 sudo -n（免密 / 已有凭据缓存）；要密码就让界面问一次，经 sudo -S 从 stdin 传（不进命令行、不进 ps），只存在主进程内存里。
import type { SFTPWrapper } from 'ssh2'
import { SUDO_NEED_PW, shq, shScript, baseName, tr, type DirEntry } from '@lingshell/shared'
import { MAX_FILE_BYTES, tooBig, type ExecResult, type FileAccess, type RunCmd, type TreeOps } from './fileOps.js'

export type ExecIn = (command: string, timeoutMs: number, stdin?: string) => Promise<ExecResult>

/** sudo 输出里的常见失败 → 分类（不按说明文字判断：文字随界面语言变） */
function sudoKind(out: string): 'need_pw' | 'wrong_pw' | 'denied' | 'missing' | undefined {
  if (/a password is required|a terminal is required|no tty present|askpass/i.test(out)) return 'need_pw'
  if (/incorrect password|Sorry, try again/i.test(out)) return 'wrong_pw'
  if (/is not in the sudoers|not allowed to (run|execute)|may not run sudo/i.test(out)) return 'denied'
  if (/sudo: (command )?not found|sudo: not found/.test(out)) return 'missing'
  return undefined
}
/** sudo 输出里的常见失败 → 说明；需要密码的带 SUDO_NEED_PW 前缀 */
export function sudoError(out: string): string | undefined {
  switch (sudoKind(out)) {
    case 'need_pw': return `${SUDO_NEED_PW}${tr('需要输入 sudo 密码')}`
    case 'wrong_pw': return `${SUDO_NEED_PW}${tr('sudo 密码不对，请重新输入')}`
    case 'denied': return tr('当前登录用户没有 sudo 权限')
    case 'missing': return tr('服务器上没有 sudo')
  }
  return undefined
}
/** sudo 本身没过（要密码 / 密码不对 / 没权限 / 没装）：命令没有执行 */
export class SudoError extends Error {}

/** 把命令包上 sudo：有密码走 -S（stdin 第一行是密码），没有走 -n。命令一律先包成 sh -c，保证管道 / 重定向整段都以 root 跑 */
export function sudoRunner(exec: ExecIn, password: () => string | undefined, forget: () => void): RunCmd {
  return async (cmd, ms) => {
    const inner = cmd.startsWith('sh -c ') ? cmd : shScript(cmd)
    const pw = password()
    const r = await exec(pw !== undefined ? `sudo -S -p '' ${inner}` : `sudo -n ${inner}`, ms, pw !== undefined ? `${pw}\n` : undefined)
    const e = sudoError(r.output)
    if (e) { if (sudoKind(r.output) === 'wrong_pw') forget(); throw new SudoError(e) }
    return r
  }
}

/** 验证密码：sudo -S -v（只刷新凭据，不跑命令） */
export async function sudoCheck(exec: ExecIn, password: string): Promise<void> {
  const r = await exec(`sudo -S -p '' -v`, 15_000, `${password}\n`)
  const e = sudoError(r.output)
  if (e) throw new SudoError(e)
  if (r.code !== 0) throw new Error(tr('sudo 验证失败：{err}', { err: r.output.trim().slice(0, 200) }))
}

// what：已翻译的操作名
const fail = (r: ExecResult, what: string) => { if (r.code !== 0) throw new Error(tr('{what}失败：{err}', { what, err: r.output.trim().split('\n').slice(-3).join(' ') || tr('退出码 {code}', { code: String(r.code) }) })) }

// find -printf 一项一段（\0 结尾）：类型 / 大小 / 修改时间 / 权限 / 属主 / 属组 / 链接指向 / 跟随链接后的类型 / 名称
const LIST_FMT = '%y\\t%s\\t%T@\\t%m\\t%u\\t%g\\t%l\\t%Y\\t%f\\0'
export function parseSudoList(dir: string, out: string): DirEntry[] {
  const base = dir.endsWith('/') ? dir : `${dir}/`
  return out.split('\0').filter(Boolean).map((rec) => {
    const [y, size, t, mode, owner, group, link, Y, ...rest] = rec.replace(/^\n/, '').split('\t')
    const name = rest.join('\t')
    const isLink = y === 'l'
    return {
      name, path: base + name, isDir: y === 'd' || (isLink && Y === 'd'),
      size: Number(size), mtime: Math.floor(Number(t)), mode: parseInt(mode, 8), owner, group,
      ...(isLink ? { isLink: true, linkTarget: link, ...(Y === 'N' || Y === 'L' ? { linkBroken: true } : {}) } : {}),
    }
  }).filter((e) => e.name)
}
export async function sudoListDir(run: RunCmd, dir: string): Promise<DirEntry[]> {
  const r = await run(shScript(`[ -d ${shq(dir)} ] || { echo "No such file or directory" >&2; exit 2; }; find ${shq(dir)} -mindepth 1 -maxdepth 1 -printf '${LIST_FMT}'`), 30_000)
  if (r.code !== 0) throw new Error(/No such file/.test(r.output) ? 'ENOENT: No such file' : r.output.trim() || tr('列目录失败（退出码 {code}）', { code: String(r.code) }))
  return parseSudoList(dir, r.output)
}

/** 增删改用的 TreeOps：每个操作一条 sudo 命令。读写文件流不支持（下载 / 上传请关掉 sudo） */
export function sudoTreeOps(run: RunCmd): TreeOps {
  const sh = async (script: string, what: string, ms = 60_000) => { const r = await run(shScript(script), ms); fail(r, what); return r.output }
  const nope = () => { throw new Error(tr('sudo 模式下不能直接上传 / 下载，请关掉 sudo 后再传（或先复制到自己有权限的目录）')) }
  return {
    win: false,
    lstat: async (p) => {
      const out = await sh(`if [ -e ${shq(p)} ] || [ -L ${shq(p)} ]; then stat -c '%F|%s|%Y' -- ${shq(p)}; else echo __NOENT__; fi`, tr('读取属性'))
      if (out.includes('__NOENT__')) return undefined
      const [type, size, mtime] = out.trim().split('|')
      return { isDir: type === 'directory', isLink: type === 'symbolic link', size: Number(size), mtime: Number(mtime) }
    },
    readdir: async (p) => (await sudoListDir(run, p)).map((e) => ({ name: e.name, isDir: e.isDir && !e.isLink, isLink: !!e.isLink, size: e.size ?? 0, mtime: e.mtime })),
    mkdir: async (p) => { await sh(`mkdir -- ${shq(p)}`, tr('新建文件夹')) },
    createFile: async (p) => { await sh(`set -C; : > ${shq(p)}`, tr('新建文件')) },
    // i18n-ignore-next 服务器上执行的脚本
    rename: async (a, b) => { await sh(`[ -e ${shq(b)} ] && { echo "已存在同名项" >&2; exit 17; }; mv -- ${shq(a)} ${shq(b)}`, tr('改名')) },
    replace: async (a, b) => { await sh(`mv -f -- ${shq(a)} ${shq(b)}`, tr('改名')) },
    unlink: async (p) => { await sh(`rm -f -- ${shq(p)}`, tr('删除')) },
    rmdir: async (p) => { await sh(`rmdir -- ${shq(p)}`, tr('删除')) },
    createReadStream: nope,
    createWriteStream: nope,
    setMtime: async (p, sec) => { await sh(`touch -d @${Math.floor(sec)} -- ${shq(p)}`, tr('设置修改时间')) },
    chmod: async (p, mode) => { await sh(`chmod ${(mode & 0o7777).toString(8)} -- ${shq(p)}`, tr('修改权限')) },
  }
}

/**
 * 编辑器 / 预览读写：读 = sudo base64（二进制安全）；写 = 先用自己的 SFTP 写到 /tmp 的临时文件，再 sudo cat 进目标（保留目标的属主和权限）。
 * 备份照旧写到自己家目录（plain：不经 sudo 的那个 FileAccess）
 */
export function sudoAccess(run: RunCmd, plain: FileAccess, sftp: SFTPWrapper): FileAccess {
  return {
    encoding: plain.encoding,
    resolve: (p) => plain.resolve(p),
    async read(p, max = MAX_FILE_BYTES) {
      const r = await run(shScript(`[ -e ${shq(p)} ] || { echo __NOENT__; exit 0; }; s=$(stat -c %s -- ${shq(p)}); [ "$s" -gt ${max} ] && { echo "__BIG__ $s"; exit 0; }; base64 -- ${shq(p)}`), 60_000)
      if (r.output.includes('__NOENT__')) return undefined
      const big = /__BIG__ (\d+)/.exec(r.output)
      if (big) throw tooBig(p, Number(big[1]), max)
      fail(r, tr('读取'))
      return Buffer.from(r.output.replace(/\s+/g, ''), 'base64')
    },
    async write(p, data, mode) {
      if (p.startsWith(await plain.backupDir())) return plain.write(p, data, mode)   // 备份：自己家目录，不用 sudo
      const tmp = `/tmp/.lingshell-sudo-${Date.now().toString(36)}-${baseName(p).replace(/[^\w.-]/g, '_')}`
      await new Promise<void>((res, rej) => sftp.writeFile(tmp, data, { mode: 0o600 }, (e) => (e ? rej(e) : res())))
      try {
        const r = await run(shScript(`cat -- ${shq(tmp)} > ${shq(p)}${mode !== undefined ? ` && chmod ${mode.toString(8)} -- ${shq(p)}` : ''}`), 60_000)
        fail(r, tr('保存'))
      } finally { await new Promise<void>((res) => sftp.unlink(tmp, () => res())) }
    },
    mkdirp: (dir) => plain.mkdirp(dir),
    backupDir: () => plain.backupDir(),
    async remove(p) { const r = await run(shScript(`rm -f -- ${shq(p)}`), 30_000); fail(r, tr('删除')) },
  }
}
