// 目录备份：把远端的一个「文件系统目录」打包到统一备份目录（~/lingshell-backups/<目录名>-时间.tar.gz）。
// 只生成命令字符串（纯函数，可单测），真正执行在主进程 explorerIpc 里走独立 exec channel。
// 与资源管理器「压缩为 tar.gz」的区别：输出到固定备份目录、带时间戳、有默认排除项、记执行记录（dir_backup）。
import { shq, shScript, NO_TOOL } from './explorer.js'
import { tr } from '../i18n/i18n.js'

const ZERO = String.fromCharCode(0)

/** 默认备份目录（远端主机上） */
export const DIR_BACKUP_DIR = '~/lingshell-backups'
/** 默认排除项：版本库、依赖包、日志、临时文件 */
export const DIR_BACKUP_EXCLUDES = ['.git', 'node_modules', '*.log', '*.tmp', '.DS_Store']

export interface DirBackupOpts {
  /** 备份文件存到哪（缺省 ~/lingshell-backups） */
  dir?: string
  /** 额外排除项（相对目录的 glob） */
  exclude?: string[]
}

export interface DirBackupPlan {
  /** 源目录（按传入的去尾斜杠） */
  src: string
  /** 备份文件完整路径 */
  out: string
  excludes: string[]
}

/** 源目录校验：必须是 / 或 ~ 开头的路径，且不能是根。返回错误文案，undefined = 通过 */
export function checkBackupSource(p: string): string | undefined {
  const s = (p ?? '').trim()
  if (!s) return tr('请填写要备份的目录')
  if (!s.startsWith('/') && !s.startsWith('~')) return tr('目录要以 / 或 ~ 开头')
  // 控制字符（含 NUL）会让 shell 命令截断或行为异常；用 charCode 判断，避免正则里出现控制字符（no-control-regex）
  const hasControl = [...s].some((ch) => { const c = ch.charCodeAt(0); return c > 0 && c < 32 })
  if (s.includes(ZERO) || hasControl) return tr('目录名里有不可见字符')
  const trimmed = s.replace(/\/+$/, '')
  if (trimmed === '' || trimmed === '~' || trimmed === '/') return tr('不能备份根目录')
  return undefined
}

/** 备份文件名：<目录名>-YYYYMMDD-HHMMSS.tar.gz（本地时间）。名字带 dir 前缀，避免和数据库备份的 backupFileName 冲突 */
export function dirBackupFileName(src: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const name = src.replace(/\/+$/, '').slice(src.replace(/\/+$/, '').lastIndexOf('/') + 1)
  const slug = name.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^[._-]+/, '').slice(0, 40) || 'backup'
  return `${slug}-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.tar.gz`
}

/** 生成备份计划：源目录 → 目标文件 + 生效的排除项 */
export function planDirBackup(src: string, opts: DirBackupOpts = {}, now = new Date()): DirBackupPlan {
  const clean = src.trim().replace(/\/+$/, '')
  const dir = (opts.dir ?? DIR_BACKUP_DIR).trim().replace(/\/+$/, '')
  const extra = (opts.exclude ?? []).map((x) => String(x).trim()).filter(Boolean)
  return {
    src: clean,
    out: `${dir}/${dirBackupFileName(clean, now)}`,
    excludes: [...new Set([...DIR_BACKUP_EXCLUDES, ...extra])],
  }
}

/** 单引号转义；~ 路径用双引号让 shell 展开 $HOME */
const qPath = (p: string): string =>
  p.startsWith('~/') ? `"$HOME/${p.slice(2).replace(/(["\\$`])/g, '\\$1')}"` : shq(p)

/** 打包命令：先建备份目录，再 tar（-C 到父目录，只打包目录本身） */
export function dirBackupCommand(plan: DirBackupPlan): string {
  const parent = plan.src.slice(0, plan.src.lastIndexOf('/')) || '/'
  const name = plan.src.slice(plan.src.lastIndexOf('/') + 1)
  const backDir = plan.out.slice(0, plan.out.lastIndexOf('/'))
  const ex = plan.excludes.map((e) => `--exclude=${shq(e)}`).join(' ')
  return shScript(
    `mkdir -p ${qPath(backDir)}; command -v tar >/dev/null 2>&1 || { echo ${NO_TOOL}tar; exit 127; }; ` +
    `tar -czf ${qPath(plan.out)} -C ${shq(parent)} ${ex} ${shq(`./${name}`)}`,
  )
}
