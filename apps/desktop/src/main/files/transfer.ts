import { spawn } from 'node:child_process'
import { randomBytes, pbkdf2Sync, createCipheriv } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename, dirname, relative, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import type { Client, SFTPWrapper } from 'ssh2'
import { connectSsh, type SshConn } from '@lingshell/terminal-core'
import type { SshConnectOpts } from '@lingshell/shared'
import { type TransferMove, type TransferProgressEvent, type TransferReveal, type ConflictPolicy, baseName } from '@lingshell/shared'
import { tr } from '@lingshell/shared'
import { log } from '../core/index.js'
import type { TreeOps } from './fileOps.js'
import { TransferQueue, type TaskCtx, type TransferPatch, type HistoryStore } from './transferQueue.js'
import { planUpload, runUpload, cleanupUpload, planDownload, runDownload, cleanupDownload, type UploadPlan } from './transferTree.js'

type Stage = TransferProgressEvent['stage']
export type TransferEmit = (ev: TransferProgressEvent) => void

// shell 单引号安全包裹：' → '\'' 。用于把随机密码嵌进远程命令。
function sq(s: string): string { return "'" + s.replace(/'/g, "'\\''") + "'" }

// 路径转换在 ./paths.ts（fileOps 也要用；放在这里会和 fileOps 形成循环依赖）
import { toNativePath } from './paths.js'
export { toNativePath }

// 盯住子进程：spawn 失败或退出码非 0 都变成带 stderr 的异常，成功则永远 pending
//（调用方拿它跟 pipeline 做 race，不能让它抢在文件 flush 前 resolve）。
// 这是上传的头号坑：tar 失败时 stdout 是空的，加密后仍得到 32 字节"看着合法"的文件，
// 一路传到远端才炸成 gzip: unexpected end of file —— 本地必须先炸。
function watch(p: import('node:child_process').ChildProcess, label: string): Promise<void> {
  let err = ''
  p.stderr?.on('data', (d: Buffer) => { err += d.toString() })
  return new Promise((resolve, reject) => {
    p.on('error', reject)
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${label} exit ${code}: ${err.trim()}`)))
  })
}

// 管道写完 **且** 子进程都正常退出才算成功（race 会把"管道先完、tar 随后非0退出"的残包当成功）。
// 失败时关掉目标文件流，否则 Windows 上文件仍被占用，finally 里的 unlink 静默失败留下临时包。
async function allOrClose(ws: import('node:fs').WriteStream, steps: Promise<unknown>[]): Promise<void> {
  try { await Promise.all(steps) } catch (e) { ws.destroy(); throw e }
}

// openssl 是否在系统 PATH 可用（探测一次缓存）。Electron 主进程用系统 PATH，Git Bash 的 /mingw64/bin 不在其中，故 Windows 常缺。
let opensslOk: boolean | undefined
export function hasOpenssl(): Promise<boolean> {
  if (opensslOk !== undefined) return Promise.resolve(opensslOk)
  return new Promise((resolve) => {
    const p = spawn('openssl', ['version'])
    p.on('error', () => { opensslOk = false; resolve(false) })
    p.on('close', (code) => { opensslOk = code === 0; resolve(opensslOk) })
  })
}

// Node crypto 复刻 `openssl enc -aes-256-cbc -pbkdf2 -pass pass:xxx` 的输出格式，
// 远端 `openssl enc -d -pbkdf2` 可原样解密：8字节魔术头 "Salted__" + 8字节 salt + AES-256-CBC 密文。
// openssl -pbkdf2 默认 SHA256 / 10000 轮，派生 48 字节 = 32 key + 16 iv。
function opensslCryptTransform(password: string): { salt: Buffer; cipher: import('node:crypto').Cipher } {
  const salt = randomBytes(8)
  const keyIv = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, 10000, 48, 'sha256')
  const key = keyIv.subarray(0, 32)
  const iv = keyIv.subarray(32, 48)
  return { salt, cipher: createCipheriv('aes-256-cbc', key, iv) }
}

// 测试用：把明文按 openssl 兼容格式加密成整块 Buffer（Salted__ + salt + 密文）。等价于 cryptoPack 的加密逻辑。
export function opensslCompatibleEncrypt(plaintext: Buffer, password: string): Buffer {
  const { salt, cipher } = opensslCryptTransform(password)
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([Buffer.from('Salted__', 'ascii'), salt, body])
}

// 构造远程解密解压命令。行首一个空格 + HISTCONTROL=ignorespace → 不进 shell history。
// mkdir -p 目标目录(不存在则建) → openssl -d 解密 | tar 解压到目标目录 → rm 删临时包。路径单引号安全包裹。
// 口令走 stdin（-pass stdin）：写进命令串会出现在远端 `ps` 里，同机其他用户可见。
// set -eo pipefail：管道任一环节(openssl 解密 / tar 解压)失败即整条非0退出，前端收到真实"失败"而非被末尾 rm 掩盖成功。
// rm 用 `&&` 接在解压后：解压失败则不删临时包(便于排查)，且 rm 不会掩盖前面的失败退出码。
export function buildDecryptCommand(remoteEnc: string, targetDir: string): string {
  return ` HISTCONTROL=ignorespace; set -eo pipefail; mkdir -p ${sq(targetDir)} && openssl enc -d -aes-256-cbc -pbkdf2 -pass stdin` +
    ` -in ${sq(remoteEnc)} | tar xzf - -C ${sq(targetDir)} && rm -f ${sq(remoteEnc)}`
}

// 三段进度映射：pack[0-33] transfer[33-66] extract/done[66-100]。stagePercent 0-100。
export function overallPercent(stage: Stage, stagePercent: number): number {
  const p = Math.max(0, Math.min(100, stagePercent)) / 100
  if (stage === 'pack') return Math.round(p * 33)
  if (stage === 'transfer') return Math.round(33 + p * 33)
  if (stage === 'extract') return Math.round(66 + p * 34)
  if (stage === 'done') return 100
  return 0   // error
}

function sftpOf(c: Client): Promise<SFTPWrapper> {
  return new Promise((res, rej) => c.sftp((e, s) => e ? rej(e) : res(s)))
}
// 删远端临时文件（不存在也算删掉了）
function dropRemote(s: SFTPWrapper, p: string): Promise<boolean> {
  return new Promise((r) => s.unlink(p, (e) => r(!e || /no such file/i.test(e.message))))
}
function exec(c: Client, cmd: string, stdin?: string, timeoutMs = 10 * 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    c.exec(cmd, (err, ch) => {
      if (err) return reject(err)
      let stderr = ''
      // 远端解压 / 解密卡住（NFS、超大包）时不能永远等：超时断开通道并报错（远端进程可能还在跑）
      const timer = setTimeout(() => { ch.close(); reject(new Error(tr('远端解密解压超时（命令可能仍在服务器上运行）'))) }, timeoutMs)
      ch.on('close', (code: number) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`remote exit ${code}: ${stderr}`)) })
      ch.on('error', (e: Error) => { clearTimeout(timer); reject(e) })
      ch.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
      ch.on('data', () => {})
      if (stdin !== undefined) ch.end(stdin)
    })
  })
}

export class TransferService {
  private queue: TransferQueue
  // concurrency：同时进行的任务数；limit：每个任务的限速（字节/秒，0 = 不限）。都是设置项，每次用时读取，改了即时生效
  constructor(emit: TransferEmit, concurrency?: () => number, private limit: () => number = () => 0, history?: HistoryStore) {
    this.queue = new TransferQueue(emit, concurrency, Date.now, history)
  }

  // ── 队列操作（面板用）──
  list(): TransferProgressEvent[] { return this.queue.list() }
  activeCount(): number { return this.queue.activeCount() }
  pause(taskId: string): void { this.queue.pause(taskId) }
  discard(taskId: string): Promise<void> { return this.queue.discard(taskId) }
  cancel(taskId: string): void { this.queue.cancel(taskId) }
  cancelAll(): void { this.queue.cancelAll(true) }
  retry(taskId: string): void { this.queue.retry(taskId) }
  clearFinished(): void { this.queue.clearFinished() }
  reorder(taskId: string, to: TransferMove): void { this.queue.reorder(taskId, to) }

  // 上传：本地 localPath（文件或目录）→ 加密 → sftp → 远程 targetDir 解密解压。排队执行，Promise 在任务结束时才落定。
  // hostId：已保存主机 id，有则完成后可「在资源管理器中定位」
  upload(opts: SshConnectOpts, localPath0: string, targetDir: string, encrypt: boolean, hostId?: string): Promise<void> {
    const localPath = toNativePath(localPath0)          // 模型常给 /d/... ，tar 只认 D:\...
    // 目标目录兜底：空/异常时用 '/'，绝不让 tar 无 -C 落到 SSH 登录 home(/root)。必须是绝对路径。
    const dir = (targetDir && targetDir.trim()) || '/'
    if (!dir.startsWith('/')) return Promise.reject(new Error(`invalid_target_dir: ${targetDir}`))
    // 压缩文件名：纯随机 hex，无扩展名、无前缀（不暴露"这是加密上传的临时包"，也不含 taskId）
    const archiveName = randomBytes(16).toString('hex')
    const remoteEnc = `/tmp/${archiveName}`
    const leftover = { maybe: true }   // 远端还有临时包？成功后置 false；失败时「放弃 / 清除」能连上去删
    return this.queue.enqueue({
      kind: 'upload', files: [basename(localPath)], target: `${opts.username}@${opts.host}:${dir}`,
      reveal: hostId ? { hostId, path: dir } : undefined,
      cleanup: async () => {
        if (!leftover.maybe) return
        try {
          const c = await connectSsh(opts)
          try { const s = await sftpOf(c.client); if (await dropRemote(s, remoteEnc)) leftover.maybe = false } finally { c.close() }
        } catch { /* 连不上：临时包留着，下次手动清理 */ }
      },
      run: (ctx) => this.runUpload(ctx, opts, localPath, dir, encrypt, archiveName, leftover),
    })
  }

  private async runUpload(ctx: TaskCtx, opts: SshConnectOpts, localPath: string, dir: string, encrypt: boolean, archiveName: string, leftover: { maybe: boolean }): Promise<void> {
    const { signal } = ctx
    const report = (stage: Stage, stagePercent: number, extra?: TransferPatch) =>
      ctx.progress({ stage, stagePercent, overallPercent: overallPercent(stage, stagePercent), ...extra })
    const cancelled = () => { if (signal.aborted) throw new Error(tr('已取消')) }
    // ponytail: 一次性随机密码仅进程内存、独立于文件名(不可从文件名反推)，传完即弃；走 SSH channel 不落盘，命令行首空格 + HISTCONTROL 抑制 history
    const password = randomBytes(24).toString('base64')
    const tmpEnc = join(tmpdir(), archiveName)
    const remoteEnc = `/tmp/${archiveName}`
    // i18n-ignore-next
    log('info', 'main', 'transfer', `upload 开始 文件=${basename(localPath)} → ${opts.username}@${opts.host}:${dir} 加密=${encrypt}`)
    let conn: SshConn | undefined   // 专用连接（与 UI 终端隔离，含跳板），用完 close()
    let sftp: SFTPWrapper | undefined
    try {
      report('pack', -1, { cancellable: true })
      await this.packEncrypt(localPath, tmpEnc, password, encrypt, signal)
      cancelled()
      report('pack', 100)
      conn = await connectSsh(opts)
      cancelled()
      sftp = await sftpOf(conn.client)
      const size = (await stat(tmpEnc)).size
      await this.sftpUpload(sftp, tmpEnc, remoteEnc, signal, (sent) => report('transfer', size ? Math.min(100, (sent / size) * 100) : 100, { bytesDone: sent, bytesTotal: size }))
      cancelled()
      // 解压中途停下会留半截目录：这一段不让取消
      report('extract', -1, { cancellable: false })
      const decrypt = encrypt
        ? buildDecryptCommand(remoteEnc, dir)
        : ` set -e; mkdir -p ${sq(dir)} && tar xzf ${sq(remoteEnc)} -C ${sq(dir)} && rm -f ${sq(remoteEnc)}`
      log('info', 'main', 'transfer', `upload 解压 目标目录=${dir} 临时包=${remoteEnc}`)   // i18n-ignore 日志
      await exec(conn.client, decrypt, encrypt ? password + '\n' : undefined)
      leftover.maybe = false   // tar 成功时命令自己删了临时包
      log('info', 'main', 'transfer', `upload 完成 → ${dir}/${basename(localPath)}`)   // i18n-ignore 日志
    } catch (e) {
      // 失败 / 取消：删掉远端的临时包（尽力而为；删不掉就留着「放弃」时再删）
      if (sftp && await dropRemote(sftp, remoteEnc)) leftover.maybe = false
      log(signal.aborted ? 'info' : 'error', 'main', 'transfer', `upload ${signal.aborted ? '已取消' : '失败'}: ${e instanceof Error ? e.message : String(e)}`)   // i18n-ignore 日志
      throw signal.aborted ? new Error(tr('已取消')) : e
    } finally {
      try { await unlink(tmpEnc) } catch { /* 临时文件可能未创建 */ }
      conn?.close()
    }
  }

  // 下载：远程 remotePath 文件 → 本地 localDir（AI 的单文件下载）。排队执行，返回落地的本地路径。
  // ponytail: 下载走 sftp 明文传输(读操作，无落地 .enc 需求)；要端到端加密下载再复用 upload 的 tar+openssl 反向流程
  // localName 缺省取远程文件名（同名覆盖）
  download(opts: SshConnectOpts, remotePath: string, localDir: string, localName?: string): Promise<string> {
    const localPath = join(localDir, localName ?? basename(remotePath))
    return this.queue.enqueue({
      kind: 'download', files: [basename(remotePath)], target: localDir, reveal: { local: localPath },
      run: async ({ signal, progress }) => {
        let conn: SshConn | undefined   // 专用连接（与 UI 终端隔离，含跳板），用完 close()
        try {
          progress({ stage: 'transfer', stagePercent: 0, overallPercent: 0 })
          conn = await connectSsh(opts)
          if (signal.aborted) throw new Error(tr('已取消'))
          const sftp = await sftpOf(conn.client)
          const size = await new Promise<number>((res, rej) => sftp.stat(remotePath, (e, st) => e ? rej(e) : res(st.size)))
          await this.sftpDownload(sftp, remotePath, localPath, signal, (got) => {
            const p = size ? Math.min(100, (got / size) * 100) : 100
            progress({ stagePercent: p, overallPercent: Math.round(p), bytesDone: got, bytesTotal: size })
          })
          return localPath
        } finally {
          conn?.close()
        }
      },
    })
  }

  // 直传上传（不加密、不打包）：逐个文件经 SFTP 写到远程 dir，保留修改时间；可暂停，「继续」从断点接着传。
  // ops：排到了才取（重试时重新取，终端重连后旧 SFTP 会话已失效）；done：任务结束后释放临时连接
  uploadDirect(ops: () => Promise<{ ops: TreeOps; done?: () => void }>, localPaths0: string[], dir: string, policy: ConflictPolicy, label: string, reveal?: TransferReveal): Promise<void> {
    const localPaths = localPaths0.map(toNativePath)
    let plan: UploadPlan | undefined
    const withOps = async <T>(f: (o: TreeOps) => Promise<T>): Promise<T> => { const c = await ops(); try { return await f(c.ops) } finally { c.done?.() } }
    return this.queue.enqueue({
      kind: 'upload', files: localPaths.map((p) => basename(p)), target: label, reveal, resumable: true,
      cleanup: async () => { if (plan) await withOps((o) => cleanupUpload(o, plan!)) },
      run: (ctx) => {
        ctx.progress({ stage: 'pack', stagePercent: -1, cancellable: true })   // 连服务器 / 扫描目录前就先进入「扫描」状态
        return withOps(async (o) => {
        log('info', 'main', 'transfer', `uploadDirect 开始 ${localPaths.length} 项 → ${label}${plan ? '（续传）' : ''}`)   // i18n-ignore 日志
        try {
          if (ctx.signal.aborted) throw new Error(tr('已取消'))
          plan ??= await planUpload(o, localPaths, dir, policy)
          await runUpload({ ctx, limit: this.limit }, o, plan)
          log('info', 'main', 'transfer', `uploadDirect 完成 ${plan.items.filter((i) => !i.isDir).length} 个文件`)   // i18n-ignore 日志
        } catch (e) {
          log(ctx.signal.aborted ? 'info' : 'error', 'main', 'transfer', `uploadDirect ${ctx.signal.aborted ? (ctx.paused() ? '已暂停' : '已取消') : '失败'}: ${e instanceof Error ? e.message : String(e)}`)   // i18n-ignore 日志
          if (ctx.signal.aborted && !ctx.paused() && plan) await cleanupUpload(o, plan)   // 取消：服务器上的半截文件删掉
          throw e
        }
        })
      },
    })
  }

  // 资源管理器下载多个文件/目录：先完整遍历（超上限不开始），保留目录结构落到 localDir，顶层同名自动改名，绝不覆盖本地文件。
  // 走终端已有的 SFTP 会话（ops）：临时连接的主机也能下，不用再认证一次。可暂停 / 断点续传（本地 .lingshell-part），保留修改时间。
  // ops 可传取值函数：排到了才取（并且重试时重新取，终端重连后旧 SFTP 会话已失效）。
  downloadTree(ops: TreeOps | (() => Promise<TreeOps>), roots: string[], localDir: string): Promise<void> {
    let plan: Awaited<ReturnType<typeof planDownload>> | undefined
    return this.queue.enqueue({
      kind: 'download', files: roots.map(baseName), target: localDir, resumable: true,
      cleanup: async () => { if (plan) await cleanupDownload(plan) },
      run: async (ctx) => {
        ctx.progress({ stage: 'pack', stagePercent: -1, cancellable: true })   // 取 SFTP 会话前就显示「扫描目录」
        const o = typeof ops === 'function' ? await ops() : ops
        try {
          if (ctx.signal.aborted) throw new Error(tr('已取消'))
          plan ??= await planDownload(o, roots, localDir)
          // 完成后「打开所在文件夹」选中第一个顶层项
          if (plan.items.length) ctx.progress({ reveal: { local: join(localDir, relative(localDir, plan.items[0].local).split(sep)[0]) } })
          await runDownload({ ctx, limit: this.limit }, o, plan)
        } catch (e) {
          log(ctx.signal.aborted ? 'info' : 'error', 'main', 'transfer', `downloadTree ${ctx.signal.aborted ? (ctx.paused() ? '已暂停' : '已取消') : '失败'}: ${e instanceof Error ? e.message : String(e)}`)   // i18n-ignore 日志
          // 取消（不是暂停）：半截文件删掉；暂停 / 失败的留着续传
          if (ctx.signal.aborted && !ctx.paused() && plan) await cleanupDownload(plan)
          throw e
        }
      },
    })
  }

  private async packEncrypt(localPath: string, out: string, password: string, encrypt: boolean, signal?: AbortSignal): Promise<void> {
    // dirname 正确处理 Windows 反斜杠路径（D:\a\b.md → D:\a）。
    // 之前手写 slice(0,lastIndexOf('/')) 在 Windows 路径找不到 '/'，返回 slice(0,-1) 砍掉末字符 → tar -C 到不存在目录 → 空包 → 远端 gzip 报错。
    const dir = dirname(localPath)
    const name = basename(localPath)
    // 不加密：tar 直接写文件（tar Win10+/Mac/Linux 系统自带，已验证可用）
    if (!encrypt) return this.spawnPack(dir, name, out, undefined, password, signal)
    // 加密：优先系统 openssl（保留原行为），缺失则回退 Node crypto（生成 openssl 兼容密文，远端仍用 openssl 解密）
    if (await hasOpenssl()) return this.spawnPack(dir, name, out, 'openssl', password, signal)
    return this.cryptoPack(dir, name, out, password, signal)
  }

  // tar[ → openssl] → 文件。mode='openssl' 时经系统 openssl 加密；undefined 时明文。
  // 用 pipeline 串接：保证所有环节（含目标文件 WriteStream）完整 flush 后才 resolve。
  // 之前用 .pipe()+enc.on('close') 会在文件写完前就 resolve，产出截断的 .enc → 远端 gzip: unexpected end of file。
  // signal：取消时杀掉 tar / openssl 子进程
  private async spawnPack(dir: string, name: string, out: string, mode: 'openssl' | undefined, password: string, signal?: AbortSignal): Promise<void> {
    const tar = spawn('tar', ['czf', '-', '-C', dir, name], { signal })   // c 必须在最前：'-C dir czf' 会被 tar 报错(无操作模式)，产出空 tar
    const tarErr = watch(tar, 'tar')
    const ws = createWriteStream(out)
    if (mode === 'openssl') {
      // 口令走环境变量：命令行参数对本机所有用户可见，进程 env 只有本用户能读
      const enc = spawn('openssl', ['enc', '-aes-256-cbc', '-pbkdf2', '-pass', 'env:LINGSHELL_PACK_PASS'], { env: { ...process.env, LINGSHELL_PACK_PASS: password }, signal })
      const encErr = watch(enc, 'openssl')
      // tar.stdout → openssl.stdin，openssl.stdout → 文件。两段 pipeline 都要等完；任一子进程失败即 reject。
      await allOrClose(ws, [tarErr, encErr, pipeline(tar.stdout, enc.stdin), pipeline(enc.stdout, ws)])
    } else {
      await allOrClose(ws, [tarErr, pipeline(tar.stdout, ws)])
    }
  }

  // Node crypto 加密回退：tar → [Salted__+salt 头] + AES-256-CBC(PBKDF2) → 文件。远端 openssl enc -d -pbkdf2 可解。
  private cryptoPack(dir: string, name: string, out: string, password: string, signal?: AbortSignal): Promise<void> {
    const tar = spawn('tar', ['czf', '-', '-C', dir, name], { signal })   // c 必须在最前：'-C dir czf' 会被 tar 报错(无操作模式)，产出空 tar
    const tarErr = watch(tar, 'tar')
    const { salt, cipher } = opensslCryptTransform(password)
    let headerWritten = false
    // 在密文流最前面注入 openssl 魔术头 "Salted__" + salt（只注一次）
    const prependHeader = new Transform({
      transform(chunk, _enc, cb) {
        if (!headerWritten) { headerWritten = true; this.push(Buffer.concat([Buffer.from('Salted__', 'ascii'), salt])) }
        this.push(chunk); cb()
      },
    })
    const ws = createWriteStream(out)
    // tar.stdout → cipher(加密) → prependHeader(注头) → 文件。任一环节出错 pipeline 会 reject。
    return allOrClose(ws, [tarErr, pipeline(tar.stdout, cipher, prependHeader, ws)])
  }

  // onBytes：累计已发送字节
  private sftpUpload(sftp: SFTPWrapper, local: string, remote: string, signal: AbortSignal, onBytes: (n: number) => void): Promise<void> {
    return pipeStreams(createReadStream(local), sftp.createWriteStream(remote, { mode: 0o600 }), signal, onBytes)   // /tmp 下默认 0644，同机其他用户可读
  }

  // 取消 / 失败删掉本地半截文件
  private async sftpDownload(sftp: SFTPWrapper, remote: string, local: string, signal: AbortSignal, onBytes: (n: number) => void): Promise<void> {
    try { await pipeStreams(sftp.createReadStream(remote), createWriteStream(local), signal, onBytes) }
    catch (e) { await unlink(local).catch(() => {}); throw e }
  }
}

// rs → ws，写端 close 才算完；signal 中止时两端都销毁并以「已取消」失败
function pipeStreams(rs: NodeJS.ReadableStream & { destroy(): void }, ws: NodeJS.WritableStream & { destroy(): void; on(ev: string, f: (...a: unknown[]) => void): unknown }, signal: AbortSignal, onBytes: (n: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let n = 0
    const abort = () => { rs.destroy(); ws.destroy(); reject(new Error(tr('已取消'))) }
    if (signal.aborted) return abort()
    signal.addEventListener('abort', abort, { once: true })
    const done = (f: () => void) => { signal.removeEventListener('abort', abort); f() }
    rs.on('data', (chunk: Buffer) => { n += chunk.length; onBytes(n) })
    ws.on('close', () => done(resolve))
    ws.on('error', (e) => done(() => reject(e)))
    rs.on('error', (e: Error) => done(() => reject(e)))
    rs.pipe(ws)
  })
}
