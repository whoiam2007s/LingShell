// 从 Xshell / PuTTY / MobaXterm / SecureCRT 导入会话（解析见 config/sessionImport）。
// 预览时解析结果留在主进程，导入按勾选的 alias 取；文件路径只来自原生选择框或默认位置，渲染层不能指定任意路径
import { loadSessions, previewSessions, importSessions, type HostStore, type SessionLoad } from '@lingshell/config'
import { tr, tk, type SessionImportSource } from '@lingshell/shared'

export interface SessionImportDeps {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  hosts: HostStore
  /** 弹原生选择框：dir=选文件夹，否则按 filters 选文件；取消 undefined */
  pick(dir: boolean, filters: { name: string; extensions: string[] }[]): Promise<string | undefined>
}

const SOURCES: SessionImportSource[] = ['xshell', 'putty', 'mobaxterm', 'securecrt']
const FILTERS: Record<SessionImportSource, { name: string; extensions: string[] }[]> = {
  xshell: [], securecrt: [],   // 选会话文件夹
  putty: [{ name: tk('PuTTY 注册表导出'), extensions: ['reg'] }],
  mobaxterm: [{ name: tk('MobaXterm 配置'), extensions: ['ini', 'mxtsessions'] }],
}

export function registerSessionImport(d: SessionImportDeps): void {
  let last: SessionLoad | undefined
  d.handle('hosts:sessionImportPreview', async (_e, s, pick) => {
    const source = SOURCES.find((x) => x === s)
    if (!source) throw new Error(tr('非法的导入来源'))
    let path: string | undefined
    if (pick === true) {
      path = await d.pick(source === 'xshell' || source === 'securecrt', FILTERS[source].map((f) => ({ ...f, name: tr(f.name) })))
      if (!path) return undefined
    }
    last = loadSessions(source, path)
    return previewSessions(last, d.hosts.list())
  })
  d.handle('hosts:importSessions', (_e, aliases) => {
    if (!last) throw new Error(tr('请先预览'))
    if (!Array.isArray(aliases)) throw new Error(tr('非法的勾选列表'))
    return importSessions(d.hosts, last, aliases.filter((a): a is string => typeof a === 'string'))
  })
}
