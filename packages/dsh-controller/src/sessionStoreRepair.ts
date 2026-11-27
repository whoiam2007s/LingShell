// 会话存档根目录自愈：把会触发 dsh「扁平布局」拒绝的残留挪进隔离区。
//
// dsh 的 JSONL 存档只认 <root>/<项目目录>/<会话id>/ 这一种布局：根目录下任意一个目录里直接躺着
// *.jsonl，listSessionDirs 就会抛「session artifact … uses the unsupported flat-file layout」，
// 而这个异常会顺着列表 / findLog / resume / 新建会话一起去 —— 表现就是「所有历史会话和新建会话
// 都不能用」，界面上连一条会话都点不开。
//
// 0.1.20 的子代理 live.jsonl 踩过这个坑（现已改到会话存档之外，见 subagentStore.liveLogDir），
// 但已经写坏的机器不会自己好，所以开机先把这类残留搬走（只搬不删，全留在隔离区），再启动持久化。
import { mkdir, readdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** dsh 的会话存档文件名：明文 .jsonl / 压缩 .jsonl.zstd */
const isArtifact = (name: string) => name.endsWith('.jsonl') || name.endsWith('.jsonl.zstd')

/**
 * dsh 的 projectKey 形状：`--C-Users-Administrator--`；没有 cwd 的会话落在 `_no-cwd`。
 * 形状不像项目目录的（比如我们踩坑写出来的 `sess_xxx`）才整个搬走。
 */
const isProjectDirName = (name: string) => name === '_no-cwd' || (name.length > 4 && name.startsWith('--') && name.endsWith('--'))

/** 一次搬家：从哪挪到哪（调用方拿去记日志） */
export interface QuarantinedArtifact { from: string; to: string }

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch { return false }
}

/** 隔离区里已有同名东西就加序号，任何情况下都不覆盖已有文件 */
async function uniquePath(dir: string, name: string): Promise<string> {
  let path = join(dir, name)
  for (let i = 1; await exists(path); i++) path = join(dir, `${name}-${i}`)
  return path
}

/**
 * 扫一遍会话存档根目录，把「根下某目录里直接有 *.jsonl」的东西挪到 `quarantineRoot`。
 *
 * - 形状不像项目目录的（`sess_xxx` 这类）：整个目录搬走，里面的东西原样留档；
 * - 形状像项目目录的（`--…--` / `_no-cwd`）：只搬那几个文件，项目目录和会话存档一个字节不动；
 * - 干净的目录、根目录本身不存在：什么都不做（返回空数组），开机零成本。
 *
 * @param root - dsh JSONL 存档根目录（`<数据目录>/dsh-sessions`）
 * @param quarantineRoot - 隔离区目录（按启动时间分目录，避免覆盖上一次的留存）
 * @returns 实际搬走的条目；空数组表示根目录本来就是干净的
 */
export async function quarantineFlatSessionArtifacts(root: string, quarantineRoot: string): Promise<QuarantinedArtifact[]> {
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch { return [] }   // 读不了就交给后面的正常流程报错
  const moved: QuarantinedArtifact[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    let inner
    try { inner = await readdir(dir, { withFileTypes: true }) } catch { continue }
    const stray = inner.filter((e) => e.isFile() && isArtifact(e.name))
    if (!stray.length) continue   // 干净目录（会话目录里本来就有 session.v4.jsonl.zstd，但那是二层，不在这里）
    if (isProjectDirName(entry.name)) {
      const target = join(quarantineRoot, entry.name)
      await mkdir(target, { recursive: true })
      for (const f of stray) {
        const from = join(dir, f.name)
        const to = await uniquePath(target, f.name)
        await rename(from, to)
        moved.push({ from, to })
      }
    } else {
      await mkdir(quarantineRoot, { recursive: true })
      const to = await uniquePath(quarantineRoot, entry.name)
      await rename(dir, to)
      moved.push({ from: dir, to })
    }
  }
  return moved
}
