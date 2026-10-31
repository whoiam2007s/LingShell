// AppClient 的文件：资源管理器、上传下载、目录同步、预览、报错定位。主进程注册见 apps/desktop/src/main/files/register.ts，渲染层实现见 apps/ui/src/client/transports/ipc/files.ts
import type { FsScope, DirEntry } from '../types.js'
import type { TransferProgressEvent, TransferMove } from '../events.js'
import type { DeletePlan, CompareTarget, CompareOpts, CompareResult, SearchHit, ContentHit, PasteMode, ConflictPolicy, HashAlgo, DirSyncCompareReq, DirSyncCompareResult, SyncDirection, DirSyncRunResult, DirSyncProgress } from '../../files/index.js'

export interface FilesApi {
  // 资源管理器目录树：scope='local'（本地 FS）或 { terminalId }（该终端所在主机）
  fs: {
    listDir(scope: FsScope, path: string): Promise<DirEntry[]>
    listDirByHost(hostId: string, path: string): Promise<DirEntry[]>   // 上传 dialog 浏览远程目录（临时连接）
    // 常用位置：主目录 / 根 / 临时目录 / 盘符；windows = 远程是 Windows 自带的 OpenSSH（没有 sh，部分功能不可用）
    places(scope: FsScope): Promise<{ home?: string; items: { label: string; path: string }[]; windows?: boolean }>
    // 删文件/目录（二次确认在 UI）：本地移到回收站；远程 SFTP 递归删（超 TREE_CAP 项拒绝），记执行记录
    remove(scope: FsScope, path: string): Promise<void>
    deletePlan(scope: FsScope, paths: string[]): Promise<DeletePlan>     // 删除确认前计数
    create(scope: FsScope, dir: string, name: string, kind: 'file' | 'dir'): Promise<string>   // 返回新路径；同名已存在报错
    rename(scope: FsScope, path: string, name: string): Promise<string>  // 同目录改名，目标已存在拒绝；远程记执行记录
    openLocal(path: string): Promise<void>                   // shell.openPath（仅本地）
    // 用户手动编辑文本文件：二进制/非 UTF-8/超 2MB 拒绝。base = 打开时的原文，磁盘内容已变则拒绝（需重新打开）
    readText(scope: FsScope, path: string): Promise<string>
    diffText(scope: FsScope, path: string, base: string, next: string): Promise<string>   // unified diff，无变化返回 ''
    writeText(scope: FsScope, path: string, base: string, next: string): Promise<void>    // 先备份原文件，记执行记录（可还原）
    // 多台主机比对同一路径的文件（只读）：结果与 targets 一一对应，单台失败只标该台
    compare(targets: CompareTarget[], path: string, opts: CompareOpts): Promise<CompareResult[]>
    // 以下仅远程：服务器命令走独立 exec channel，记执行记录 file_chmod / file_archive / file_extract（搜索只读不记）
    chmod(scope: FsScope, paths: string[], mode: number, recursive: boolean): Promise<void>
    pack(scope: FsScope, paths: string[]): Promise<string>     // 同目录下的项 → tar.gz，返回压缩包路径
    unpack(scope: FsScope, path: string): Promise<string>      // 解压到所在目录（不覆盖同名），返回该目录
    // 按名称搜索（本地也支持）；按内容搜索返回每个文件第一处匹配的行
    search(scope: FsScope, root: string, query: string): Promise<{ hits: SearchHit[]; truncated: boolean; timedOut: boolean }>
    searchContent(scope: FsScope, root: string, query: string): Promise<{ hits: ContentHit[]; truncated: boolean; timedOut: boolean }>
    // 复制 / 剪切 / 粘贴（同一台主机内）：先 pastePlan 看冲突，再 paste 按冲突策略执行；远程在服务器上 cp / mv，记执行记录 file_copy / file_move
    pastePlan(scope: FsScope, srcs: string[], dir: string): Promise<{ items: { src: string; name: string; isDir: boolean; conflict: boolean; same: boolean }[] }>
    paste(scope: FsScope, srcs: string[], dir: string, mode: PasteMode, policy: ConflictPolicy): Promise<{ done: { src: string; to: string }[]; skipped: string[] }>
    // 属性：合计文件夹数 / 文件数 / 字节（超时或超上限返回部分，partial）；校验和
    stats(scope: FsScope, paths: string[]): Promise<{ dirs: number; files: number; bytes: number; partial?: boolean }>
    checksum(scope: FsScope, path: string, algo: HashAlgo): Promise<string>
    // sudo 模式：验证密码（sudo -S -v）后只存在主进程内存里（按终端）；forget 清掉
    sudoAuth(terminalId: string, password: string): Promise<void>
    sudoForget(terminalId: string): Promise<void>
    // 远程改属主：候选用户 / 组；chown 记执行记录 file_chown
    owners(scope: FsScope): Promise<{ users: string[]; groups: string[] }>
    chown(scope: FsScope, paths: string[], owner: string, group: string, recursive: boolean): Promise<void>
    // 用本地编辑器打开远程文件：下载到临时目录，保存后自动回传（先备份，记执行记录 file_edit_external）
    editExternal(scope: FsScope, path: string): Promise<void>
  }
  // 加密上传/下载（后台执行，进度经 transfer:progress 事件）
  transfer: {
    upload(hostId: string, localPath: string, targetDir: string, encrypt: boolean): Promise<void>
    download(terminalId: string, remotePath: string, localDir: string): Promise<void>
    // 资源管理器下载多个文件/目录（保留结构，同名自动改名）：启动即返回，进度/失败经事件；cancel 中止
    downloadMany(scope: FsScope, remotePaths: string[], localDir: string): Promise<void>
    cancel(taskId: string): Promise<void>
    // 传输队列：全部任务快照 / 失败或取消的按原参数重跑 / 清除已结束的 / 本地落点在文件夹中显示
    list(): Promise<TransferProgressEvent[]>
    retry(taskId: string): Promise<void>
    clearFinished(): Promise<void>
    revealLocal(taskId: string): Promise<void>
    // 排队中的任务调整顺序：top = 优先传输（移到队首），up / down 移一位；进行中的不受影响
    reorder(taskId: string, to: TransferMove): Promise<void>
    // 直传上传（不加密）：目标 = 终端（复用其 SFTP，临时连接的主机也行）或已保存主机。先查同名，再按冲突策略传；可暂停 / 断点续传
    uploadConflicts(target: { terminalId: string } | { hostId: string }, localPaths: string[], dir: string): Promise<string[]>
    uploadDirect(target: { terminalId: string } | { hostId: string }, localPaths: string[], dir: string, policy: ConflictPolicy): Promise<void>
    pause(taskId: string): Promise<void>      // 暂停（只对可续传的）；继续 = retry
    discard(taskId: string): Promise<void>    // 放弃已暂停 / 失败的：删掉半截文件并移出列表
  }
  // 本地 ↔ 远程目录比较与同步（见 dirSync.ts）：id 由界面生成，比较结果留在主进程，run 只传勾选的相对路径；
  // progress 轮询进度（比较 / 执行都有），cancel 中止。执行后比较结果作废，需重新比较
  dirSync: {
    compare(id: string, req: DirSyncCompareReq): Promise<DirSyncCompareResult>
    run(id: string, selected: string[], direction: SyncDirection, mirrorDelete: boolean): Promise<DirSyncRunResult>
    progress(id: string): Promise<DirSyncProgress | null>
    cancel(id: string): Promise<void>
  }
  // 资源管理器预览：读图片 / Markdown / CSV / PDF（≤ 20MB）；openExternal 下载到临时目录用系统程序打开（PDF 应用内看不了时的降级）
  preview: {
    read(scope: import('../types.js').FsScope, path: string): Promise<import('../../files/index.js').PreviewData>
    openExternal(scope: import('../types.js').FsScope, path: string): Promise<void>
  }
  // 报错定位一键打开（见 desktop/main/files/fileLinksIpc.ts）：open 按终端目录解析「文件:行号」并用编辑器跳到该行（SSH：下载回传 / VS Code Remote）；
  // vscodePlan 看要不要往 ~/.ssh/config 写托管 Host 块（UI 先确认）；vscodeOpen 写入（需要时）并用 VS Code Remote 打开目录 / 文件
  fileLinks: {
    open(terminalId: string, link: import('../../files/index.js').FileLinkReq): Promise<{ path: string }>
    vscodePlan(terminalId: string): Promise<{ alias: string; configPath: string; needWrite: boolean; block: string; note: string }>
    vscodeOpen(terminalId: string, path: string, o?: { dir?: boolean; line?: number; col?: number }): Promise<void>
  }
}
