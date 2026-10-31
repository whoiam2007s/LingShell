import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'

// 各 store 共用的 JSON 文件读写。
// 读：文件不存在 → undefined；存在但解析失败 → 改名为 .corrupt-<时间戳> 备份后返回 undefined，
// 避免下一次 save 用空值静默覆盖掉原数据（API key、主机凭据等可从备份人工恢复）。
export function readJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined
  const raw = readFileSync(file, 'utf8')
  try { return JSON.parse(raw) as T }
  catch {
    try { renameSync(file, `${file}.corrupt-${Date.now()}`) } catch { /* 备份失败也不阻断读取 */ }
    return undefined
  }
}

// JSONL：一行一条。解析失败的行（崩溃留下的半行）跳过，不影响其余记录。
export function readJsonLines<T>(file: string): T[] {
  if (!existsSync(file)) return []
  const out: T[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line) as T) } catch { /* 半行 */ }
  }
  return out
}

export function writeJsonLines(file: string, rows: unknown[]): void {
  atomicWrite(file, rows.map((r) => JSON.stringify(r) + '\n').join(''))
}

// 原子写：先写 .tmp 再 rename 覆盖，进程中途崩溃不会留下半截 JSON。
export function writeJson(file: string, data: unknown): void {
  atomicWrite(file, JSON.stringify(data, null, 2))
}

// Windows 上目标文件被短暂占用（杀软/索引扫描、同时有句柄在读）时 rename 会报 EPERM/EBUSY/EACCES，
// 实测发消息时更新 sessions.json 撞上过。按 graceful-fs 的做法短暂退避重试；仍失败就退回直接覆盖写
// （失去原子性，但比让用户操作整个失败好）。
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
export function atomicWrite(file: string, content: string, rename: (a: string, b: string) => void = renameSync): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  // 0600：配置里有加密凭据 / 设备令牌哈希 / 保险箱密文；多用户机器上其他本地用户不该能读（Windows 忽略 mode）
  writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 })
  for (let i = 0; i < 8; i++) {
    try { rename(tmp, file); return } catch (e) {
      if (!RETRY_CODES.has((e as NodeJS.ErrnoException).code ?? '')) throw e
      sleepSync(15 * (i + 1))   // 15ms, 30ms … 共约 0.5 秒
    }
  }
  writeFileSync(file, content, 'utf8')
  try { unlinkSync(tmp) } catch { /* 留着也无害，下次写会覆盖 */ }
}

function sleepSync(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }
