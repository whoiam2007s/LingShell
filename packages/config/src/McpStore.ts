import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { tr, type McpServerConfig, type McpServerInput, type McpServerSummary } from '@lingshell/shared'
import type { Encryptor } from './SettingsStore.js'
import { readJson, writeJson } from './jsonFile.js'

// 磁盘结构：env/headers 的值字段级加密（常放 token），其余明文
interface Persisted extends Omit<McpServerConfig, 'env' | 'headers'> {
  envCipher?: Record<string, string>
  headersCipher?: Record<string, string>
}

// MCP 服务配置：mcp-servers.json。明文 env/headers 只在主进程 resolve() 里出现，不经 IPC 回渲染层。
export class McpStore {
  private filePath: string
  constructor(dir: string, private enc: Encryptor) {
    this.filePath = join(dir, 'mcp-servers.json')
  }

  list(): McpServerSummary[] { return this.read().map(summaryOf) }

  /** 全部配置（解密）。某个值解不开（系统密钥变了）就当空值，连接失败时用户重填即可 */
  resolve(): McpServerConfig[] {
    return this.read().map(({ envCipher, headersCipher, ...p }) => ({
      ...p,
      ...(envCipher ? { env: this.decMap(envCipher) } : {}),
      ...(headersCipher ? { headers: this.decMap(headersCipher) } : {}),
    }))
  }

  /** 表单 → 完整配置：值为 null 的键沿用已存明文（测试连接与保存共用） */
  merge(input: McpServerInput): McpServerConfig {
    const prev = input.id ? this.resolve().find((s) => s.id === input.id) : undefined
    const fill = (m: Record<string, string | null> | undefined, old: Record<string, string> | undefined) =>
      m && Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v ?? old?.[k] ?? '']))
    const { env, headers, ...rest } = input
    return {
      ...rest, id: input.id ?? randomUUID(), name: input.name.trim(),
      autoApprove: input.autoApprove ?? prev?.autoApprove ?? [],   // 编辑表单不带免确认列表，沿用
      // 没传 env/headers（如列表上只切启停）= 整体沿用
      ...(env ? { env: fill(env, prev?.env) } : prev?.env ? { env: prev.env } : {}),
      ...(headers ? { headers: fill(headers, prev?.headers) } : prev?.headers ? { headers: prev.headers } : {}),
    }
  }

  save(input: McpServerInput): McpServerSummary {
    if (!input.name.trim()) throw new Error(tr('MCP 服务名称不能为空'))
    if (input.transport === 'stdio' ? !input.command?.trim() : !input.url?.trim()) {
      throw new Error(input.transport === 'stdio' ? tr('stdio 方式需要填写启动命令') : tr('http 方式需要填写 URL'))
    }
    const { env, headers, ...cfg } = this.merge(input)
    const p: Persisted = {
      ...cfg,
      ...(env && Object.keys(env).length ? { envCipher: this.encMap(env) } : {}),
      ...(headers && Object.keys(headers).length ? { headersCipher: this.encMap(headers) } : {}),
    }
    const all = this.read()
    this.write(all.some((s) => s.id === p.id) ? all.map((s) => (s.id === p.id ? p : s)) : [...all, p])
    return summaryOf(p)
  }

  delete(id: string): void { this.write(this.read().filter((s) => s.id !== id)) }

  setAutoApprove(id: string, tools: string[]): void {
    const all = this.read()
    const s = all.find((x) => x.id === id)
    if (!s) throw new Error('mcp_server_not_found')
    s.autoApprove = [...new Set(tools)]
    this.write(all)
  }

  private encMap(m: Record<string, string>): Record<string, string> {
    const on = this.enc.available()   // 加密不可用（部分 Linux）时降级明文，同 HostStore
    return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, on ? this.enc.encrypt(v) : v]))
  }
  private decMap(m: Record<string, string>): Record<string, string> {
    if (!this.enc.available()) return { ...m }
    return Object.fromEntries(Object.entries(m).map(([k, v]) => {
      try { return [k, this.enc.decrypt(v)] } catch { return [k, ''] }
    }))
  }

  private read(): Persisted[] { return readJson<Persisted[]>(this.filePath) ?? [] }
  private write(all: Persisted[]): void { writeJson(this.filePath, all) }
}

function summaryOf({ envCipher, headersCipher, ...p }: Persisted): McpServerSummary {
  return { ...p, envKeys: Object.keys(envCipher ?? {}), headerKeys: Object.keys(headersCipher ?? {}) }
}
