import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { tr, tk, type PromptTemplate, type TemplateInput } from '@lingshell/shared'
import { readJson, writeJson } from './jsonFile.js'

// 内置模板：仅在文件不存在（首次）时写入，之后与用户模板一样可改可删
export const BUILTIN_TEMPLATES: PromptTemplate[] = [
  { id: 'builtin-disk-mem', name: tk('检查磁盘与内存'), prompt: '检查 {{主机}} 的磁盘与内存：df -h 看各分区使用率（超过 85% 标出），free -h 看内存与 swap，再列出占用内存最多的 5 个进程。最后给出简短结论。' },   // i18n-ignore 发给模型的提示词；变量名 {{主机}} 巡检按名字自动填
  { id: 'builtin-nginx-5xx', name: tk('查看 nginx 5xx'), prompt: '在 {{主机}} 上统计 nginx 访问日志（默认 /var/log/nginx/access.log）最近 1000 行里的 5xx 响应：按状态码和 URL 分组计数，列出最多的 10 条，并看 error.log 末尾有无相关报错。只读，不要修改配置或重启。' },   // i18n-ignore 发给模型的提示词；变量名 {{主机}} 巡检按名字自动填
  { id: 'builtin-service', name: tk('检查服务状态'), prompt: '检查 {{主机}} 上 {{服务名}} 服务的状态：systemctl status 看是否 active、最近重启时间，journalctl -u 看最近 50 行日志里的错误。只读，不要重启服务。' },   // i18n-ignore 发给模型的提示词；变量名 {{主机}} 巡检按名字自动填
  { id: 'builtin-cert', name: tk('检查证书到期'), prompt: '在 {{主机}} 上用 openssl s_client 连接 {{域名}}:443，读取证书的颁发者与到期时间，算出还剩多少天（少于 30 天需提醒）。' },   // i18n-ignore 发给模型的提示词；变量名 {{主机}} 巡检按名字自动填
  { id: 'builtin-port', name: tk('排查端口占用'), prompt: '排查 {{主机}} 上端口 {{端口}} 被哪个进程占用：用 ss -lntp（或 lsof -i）找出进程名、PID、启动命令和运行用户。只排查，不要结束进程。' },   // i18n-ignore 发给模型的提示词；变量名 {{主机}} 巡检按名字自动填
]

const BUILTIN = new Map(BUILTIN_TEMPLATES.map((t) => [t.id, t]))
const shown = (t: PromptTemplate): PromptTemplate => {
  const b = BUILTIN.get(t.id)
  return b && t.name === b.name ? { ...t, name: tr(b.name) } : t
}

// 常用任务模板：<dir>/templates.json。原子写。
export class TemplateStore {
  private file: string
  constructor(dir: string) { this.file = join(dir, 'templates.json') }

  // 显示用：没改过名字的内置模板按界面语言显示名字（存盘的仍是原文；提示词不译）
  list(): PromptTemplate[] { return this.raw().map(shown) }

  private raw(): PromptTemplate[] { return readJson<PromptTemplate[]>(this.file) ?? BUILTIN_TEMPLATES.map((t) => ({ ...t })) }

  save(input: TemplateInput): PromptTemplate {
    const name = input.name.trim(), prompt = input.prompt.trim()
    if (!name || !prompt) throw new Error(tr('模板名称和内容不能为空'))
    const all = this.raw()
    const t: PromptTemplate = { id: input.id ?? `tpl_${randomUUID().slice(0, 8)}`, name, prompt }
    const i = all.findIndex((x) => x.id === t.id)
    if (i >= 0) all[i] = t; else all.push(t)
    writeJson(this.file, all)
    return t
  }

  delete(id: string): void { writeJson(this.file, this.raw().filter((t) => t.id !== id)) }
}
