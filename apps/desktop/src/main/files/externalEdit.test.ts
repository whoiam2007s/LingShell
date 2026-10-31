import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExternalEditService, editorLaunch, safeLocalName, sessionDirName, EXT_EDIT_WARN_BYTES, type ExternalEditDeps, type ConflictChoice } from './externalEdit.js'
import type { FileAccess } from './fileOps.js'

// 内存里的「远程主机」：路径 → 内容 + 修改时间
function fakeRemote() {
  const files = new Map<string, { data: Buffer; mtime: number }>()
  let clock = 1000
  const put = (p: string, s: string | Buffer) => files.set(p, { data: Buffer.from(s), mtime: ++clock })
  const fa: FileAccess = {
    resolve: async (p) => p,
    read: async (p) => files.get(p)?.data,
    write: async (p, data) => { put(p, data) },
    mkdirp: async () => {},
    backupDir: async () => '/home/u/.lingshell/backups',
  }
  return { files, put, fa, text: (p: string) => files.get(p)?.data.toString() }
}

const services: ExternalEditService[] = []
afterEach(() => { services.splice(0).forEach((s) => s.stopAll()) })

function setup(o: { prod?: boolean; conflict?: ConflictChoice; prodAnswer?: 'yes' | 'always' | 'no'; large?: boolean } = {}) {
  const r = fakeRemote()
  const tempRoot = mkdtempSync(join(tmpdir(), 'lingshell-extedit-'))
  const log = { opened: [] as string[], audits: [] as { command: string; decision: string; filePath: string; backupPath?: string }[], notes: [] as string[], prodAsked: 0, conflicts: 0 }
  const deps: ExternalEditDeps = {
    tempRoot,
    access: async () => r.fa,
    stat: async (_t, p) => { const f = r.files.get(p); return f && { size: f.data.length, mtime: f.mtime } },
    open: async (p) => { log.opened.push(p) },
    confirmLarge: async () => o.large ?? true,
    confirmProd: async () => { log.prodAsked++; return o.prodAnswer ?? 'yes' },
    conflict: async () => { log.conflicts++; return o.conflict ?? 'overwrite' },
    prod: () => !!o.prod,
    hostKey: () => 'h1',
    audit: (_t, e) => log.audits.push(e),
    notify: (t, b) => log.notes.push(`${t}:${b}`),
    debounceMs: 30,
  }
  const svc = new ExternalEditService(deps)
  services.push(svc)
  return { ...r, svc, log, tempRoot }
}

// 等 fs.watch 事件 + 防抖 + 回传跑完
const settle = async (svc: ExternalEditService) => { await new Promise((res) => setTimeout(res, 400)); await svc.idle() }

describe('externalEdit', () => {
  it('打开：下载到按主机+路径隔离的临时目录并唤起编辑器；再开同一文件只重新唤起', async () => {
    const { put, svc, log, tempRoot } = setup()
    put('/etc/app.conf', 'a=1\n')
    const { local } = await svc.open('t1', '/etc/app.conf')
    expect(local).toBe(join(tempRoot, sessionDirName('h1', '/etc/app.conf'), 'app.conf'))
    expect(readFileSync(local, 'utf8')).toBe('a=1\n')
    expect(log.opened).toEqual([local])
    expect((await svc.open('t1', '/etc/app.conf')).reused).toBe(true)
    expect(log.opened).toHaveLength(2)
  })

  it('保存后自动回传：先备份原文件、记 file_edit_external；内容没变的事件不回传', async () => {
    const { put, text, files, svc, log } = setup()
    put('/etc/app.conf', 'a=1\n')
    const { local } = await svc.open('t1', '/etc/app.conf')
    writeFileSync(local, 'a=2\n')
    await settle(svc)
    expect(text('/etc/app.conf')).toBe('a=2\n')
    const bak = [...files.keys()].find((k) => k.startsWith('/home/u/.lingshell/backups/'))
    expect(bak && text(bak)).toBe('a=1\n')
    expect(log.audits).toEqual([expect.objectContaining({ decision: 'file_edit_external', filePath: '/etc/app.conf', backupPath: bak })])
    // 原样再写一次（touch）：不回传
    writeFileSync(local, 'a=2\n')
    await settle(svc)
    expect(log.audits).toHaveLength(1)
    // 第二次真改：远端状态已随上次回传更新，不报冲突
    writeFileSync(local, 'a=3\n')
    await settle(svc)
    expect(text('/etc/app.conf')).toBe('a=3\n')
    expect(log.conflicts).toBe(0)
  })

  it('远端在打开后被别人改过：放弃 → 不传；另存 → 写到同目录副本，原文件不动', async () => {
    const a = setup({ conflict: 'discard' })
    a.put('/srv/x.txt', 'v1')
    const la = (await a.svc.open('t1', '/srv/x.txt')).local
    a.put('/srv/x.txt', 'v1-other')
    writeFileSync(la, 'mine')
    await settle(a.svc)
    expect(a.text('/srv/x.txt')).toBe('v1-other')
    expect(a.log.conflicts).toBe(1)
    expect(a.log.audits).toHaveLength(0)

    const b = setup({ conflict: 'saveAs' })
    b.put('/srv/x.txt', 'v1')
    const lb = (await b.svc.open('t1', '/srv/x.txt')).local
    b.put('/srv/x.txt', 'v1-other')
    b.put('/srv/x (本地编辑).txt', 'taken')
    writeFileSync(lb, 'mine')
    await settle(b.svc)
    expect(b.text('/srv/x.txt')).toBe('v1-other')
    expect(b.text('/srv/x (本地编辑 2).txt')).toBe('mine')
    expect(b.log.audits[0].filePath).toBe('/srv/x (本地编辑 2).txt')
  })

  it('冲突选覆盖：照常备份后覆盖', async () => {
    const { put, text, svc, log } = setup({ conflict: 'overwrite' })
    put('/srv/x.txt', 'v1')
    const { local } = await svc.open('t1', '/srv/x.txt')
    put('/srv/x.txt', 'v1-other')
    writeFileSync(local, 'mine')
    await settle(svc)
    expect(text('/srv/x.txt')).toBe('mine')
    expect(log.audits[0].backupPath).toBeTruthy()
  })

  it('生产主机：每次回传前确认，「不再询问」后本次编辑期间不再问；拒绝则不传', async () => {
    const a = setup({ prod: true, prodAnswer: 'always' })
    a.put('/etc/p.conf', '1')
    const la = (await a.svc.open('t1', '/etc/p.conf')).local
    writeFileSync(la, '2'); await settle(a.svc)
    writeFileSync(la, '3'); await settle(a.svc)
    expect(a.text('/etc/p.conf')).toBe('3')
    expect(a.log.prodAsked).toBe(1)

    const b = setup({ prod: true, prodAnswer: 'no' })
    b.put('/etc/p.conf', '1')
    const lb = (await b.svc.open('t1', '/etc/p.conf')).local
    writeFileSync(lb, '2'); await settle(b.svc)
    expect(b.text('/etc/p.conf')).toBe('1')
    expect(b.log.audits).toHaveLength(0)
  })

  it('大文件先确认，取消则不下载；终端关闭停止监视并删临时文件', async () => {
    const a = setup({ large: false })
    a.put('/big.log', Buffer.alloc(EXT_EDIT_WARN_BYTES + 1))
    await expect(a.svc.open('t1', '/big.log')).rejects.toThrow('已取消')
    expect(a.svc.list()).toHaveLength(0)

    const b = setup()
    b.put('/a.txt', 'x')
    const { local } = await b.svc.open('t1', '/a.txt')
    b.svc.stopTerminal('t2')
    expect(existsSync(local)).toBe(true)
    b.svc.stopTerminal('t1')
    expect(existsSync(local)).toBe(false)
    expect(b.svc.list()).toHaveLength(0)
  })

  it('临时文件名去掉 shell 元字符；编辑器设置解析', () => {
    expect(safeLocalName('a&calc".txt')).toBe('a_calc_.txt')
    expect(safeLocalName('...')).toBe('file')
    expect(editorLaunch('', 'f')).toEqual({ kind: 'default' })
    expect(editorLaunch('"C:\\npp\\notepad++.exe"', 'f', () => true)).toEqual({ kind: 'exec', cmd: 'C:\\npp\\notepad++.exe', args: ['f'] })
    expect(editorLaunch('C:\\VSCode\\bin\\code.cmd', 'f', () => true)).toEqual({ kind: 'shell', line: '"C:\\VSCode\\bin\\code.cmd" "f"' })
    expect(editorLaunch('code -w', 'C:\\t\\a.txt', () => false)).toEqual({ kind: 'shell', line: 'code -w "C:\\t\\a.txt"' })
  })
})
