import { Switch } from '../../../components/ui/Switch.js'
import { NumberInput } from '../../../components/ui/NumberInput.js'
import { BTN2, INPUT, Page, Row, Section } from '../ui.js'
import { useEffect, useState } from 'react'
import type { AppClient, GitBashStatus } from '@lingshell/shared'
import { EDITOR_GOTO_PRESETS, tr, tk } from '@lingshell/shared'
import { Select } from '../../../components/ui/Select.js'
import { client } from '../../../client/index.js'
import { Loading, Sub, useSystemSettings } from '../SystemSettings.js'
import { AppearanceSection } from './AppearanceSection.js'
import { BackgroundSection } from './BackgroundSection.js'

// 设置 → 通用：外观（主题 / 界面缩放 / 图标大小）/ 启动与后台（开机自启 / 托盘 / 悬浮球）/ 文件传输 / 连接 / 主机状态采集 / 历史 / 本地终端（Git Bash 路径，仅 Windows）
export function GeneralSettings() {
  const [hk, setHk] = useState<HotkeyStatus | null>(null)   // 全局热键在主进程的注册结果（保存后刷新）
  const loadHk = () => { client.globalHotkey.status().then(setHk).catch(() => {}) }   // 注册是异步的：稍后再查一次
  const reloadHk = () => { loadHk(); setTimeout(loadHk, 300) }
  useEffect(loadHk, [])
  const { loaded, sys, set, onBlur } = useSystemSettings({ onSaved: reloadHk })
  if (!loaded) return <Loading />
  const hkHint = !sys.globalHotkey ? tr('快速连按两下 Alt 显示 / 最小化窗口')
    : !hk?.enabled ? tr('正在开启…')
    : hk.registered ? <span className="text-[var(--color-success)]">{tr('已开启，应用在后台也能呼出')}</span>
    : <span className="text-[var(--color-danger)]">{hk.error ?? tr('注册失败')}</span>
  return (
    <Page onBlur={onBlur}>
      <AppearanceSection />
      <BackgroundSection />
      <Section title={tr('文件传输')}>
        <Row label={tr('上传默认加密')} tip={tr('上传对话框里默认选「加密上传」还是「不加密」，每次上传时仍可改。')}>
          <Switch checked={sys.uploadEncrypt} onCheckedChange={(v) => set({ uploadEncrypt: v })} />
        </Row>
        <Row label={tr('同时传输数')} hint={tr('1–5，其余排队等候')} tip={tr('上传、下载（含 AI 发起的）共用一个队列，超出的排队。')}>
          <NumberInput className="w-28" value={sys.transferConcurrency} min={1} max={5} onChange={(n) => set({ transferConcurrency: n })} />
        </Row>
        <Row label={tr('传输限速')} hint={tr('KB/s，0 = 不限')} tip={tr('每个传输任务的速度上限（上传、下载都算），避免占满带宽影响线上业务。改了对进行中的任务立即生效。')}>
          <NumberInput className="w-28" value={sys.transferLimitKBps ?? 0} min={0} max={1_000_000} onChange={(n) => set({ transferLimitKBps: n })} />
        </Row>
        <Row label={tr('外部编辑器')} hint={tr('留空 = 系统默认程序')} tip={tr('资源管理器里「用本地编辑器打开」远程文件时用它。可填命令（如 code）或程序完整路径。')}>
          <input value={sys.externalEditor ?? ''} onChange={(e) => set({ externalEditor: e.target.value })} spellCheck={false}
            placeholder={tr('如 code，或 notepad++.exe 的路径')} className={`${INPUT} w-64`} />
        </Row>
        <Row label={tr('跳到行的参数')} hint={tr('终端里 Ctrl+点击「文件:行号」时用')}
          tip={tr('按住 Ctrl 点击终端里的 src/a.ts:42:7、Python / Java / Go 等堆栈行时，用上面的外部编辑器打开并跳到这一行。「自动」按编辑器认：code / cursor 用 -g 文件:行:列，JetBrains 用 --line，Notepad++ 用 -n，Sublime 用 文件:行:列；外部编辑器留空时先试 VS Code（code -g），没装再用系统默认程序打开（不跳行）。自定义时用 {file} {line} {col} 占位。')}>
          {(() => {
            const v = sys.editorGotoArgs ?? '', preset = EDITOR_GOTO_PRESETS.some((p) => p.args === v)
            return <>
              <Select className="w-56" value={!v ? '' : preset ? v : '__custom'} onValueChange={(x) => set({ editorGotoArgs: x === '__custom' ? (preset || !v ? '"{file}" +{line}' : v) : x })}
                options={[{ value: '', label: tr('自动（按编辑器识别）') }, ...EDITOR_GOTO_PRESETS.map((p) => ({ value: p.args, label: tr(p.label) })), { value: '__custom', label: tr('自定义…') }]} />
              {v && !preset && <input value={v} onChange={(e) => set({ editorGotoArgs: e.target.value })} spellCheck={false} placeholder={'"{file}" +{line}'} className={`${INPUT} w-44 font-mono`} />}
            </>
          })()}
        </Row>
      </Section>

      <Section title={tr('连接')}>
        <Row label={tr('SSH 断线自动重连')} hint={tr('退避重连，最多 8 次')}
          tip={tr('意外断线后按 2s / 5s / 10s / 30s… 退避重连，最多 8 次；远端 exit 退出或关闭标签不重连。默认关，免得网络抖动后悄悄连回生产机。')}>
          <Switch checked={sys.sshAutoReconnect} onCheckedChange={(v) => set({ sshAutoReconnect: v })} />
        </Row>
        <Row label={tr('打开 ssh:// 链接')} hint={tr('网页里点 ssh:// 链接直接连接')}
          tip={tr('网页 / CMDB 里点 ssh://user@host:port：已保存的主机确认后连接，否则预填新建连接；只取地址、端口、用户名。安装版注册为系统打开方式（会替换原来的 ssh:// 打开程序，如 PuTTY），开发版不注册。')}>
          <Switch checked={sys.sshUrlHandler === true} onCheckedChange={(v) => set({ sshUrlHandler: v })} />
        </Row>
      </Section>

      <Section title={tr('窗口')}>
        <Row label={tr('连按两下 Alt 呼出')} hint={hkHint}
          tip={tr('同 Windows Terminal 的 Quake 模式：应用在后台（最小化、被别的窗口挡住）时快速连按两下 Alt，窗口立即显示并把光标交给当前终端；已在前台时再连按两下最小化。按住 Alt 配别的键（Alt+Tab 等）不会触发。应用锁定时呼出后停在锁屏。目前只支持 Windows。')}>
          <Switch checked={sys.globalHotkey === true} onCheckedChange={(v) => set({ globalHotkey: v })} />
        </Row>
      </Section>

      <Section title={tr('主机状态采集')}>
        <Row label={tr('主机状态采集')} hint={tr('终端工具栏显示 CPU / 内存 / 磁盘 / 负载')}
          tip={tr('只采当前看得到的终端。SSH 终端会在服务器上经独立通道定时执行固定的只读命令（读 /proc/stat、/proc/meminfo、df 等；macOS 用 top、vm_stat、sysctl），不经过你的终端，不进命令历史、会话日志和录像；但服务器侧的审计（如 auditd）仍可能记下这些命令。仅支持 Linux / macOS。')}>
          <Switch checked={sys.hostStats} onCheckedChange={(v) => set({ hostStats: v })} />
        </Row>
        {sys.hostStats && (
          <Sub>
            <Row label={tr('采集间隔')} hint={tr('秒，5–300')}>
              <NumberInput className="w-28" value={sys.hostStatsIntervalSec} min={5} max={300} onChange={(n) => set({ hostStatsIntervalSec: n })} />
            </Row>
            <Row label={tr('生产主机也采集')} hint={tr('间隔自动 ×3')}>
              <Switch checked={sys.hostStatsProd} onCheckedChange={(v) => set({ hostStatsProd: v })} />
            </Row>
          </Sub>
        )}
      </Section>

      <Section title={tr('历史')}>
        <Row label={tr('每主机历史命令上限')} hint="10–1000">
          <NumberInput className="w-28" value={sys.historyLimit} min={10} max={1000} onChange={(n) => set({ historyLimit: n })} />
        </Row>
      </Section>
      <GitBashSection />
    </Page>
  )
}

type HotkeyStatus = Awaited<ReturnType<AppClient['globalHotkey']['status']>>

const SOURCE: Record<NonNullable<GitBashStatus['source']>, string> = {
  settings: tk('手动指定'), env: tk('环境变量 LINGSHELL_BASH'), registry: tk('自动检测 · 注册表'), path: tk('自动检测 · PATH'), common: tk('自动检测 · 常见安装位置'),
}

// 本地终端 → Git Bash 路径（仅 Windows）。「选择…」「清除」立即生效（主进程直接存进设置；本页自动保存只写改过的字段，不会覆盖它）
function GitBashSection() {
  const [st, setSt] = useState<GitBashStatus | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { client.gitBash.status().then(setSt).catch(() => {}) }, [])
  if (!st?.required) return null
  const act = async (fn: () => Promise<GitBashStatus | null>) => {
    setErr(null)
    try {
      const r = await fn()
      if (r) setSt(r)
    } catch (e) { setErr(String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': Error:\s*/, '').replace(/^invalid_bash:\s*/, '')) }
  }
  const hint = err ? <span className="text-[var(--color-danger)]">{err}</span>
    : st.path ? <span className="break-all">{tr('{path}（{source}）', { path: st.path, source: tr(SOURCE[st.source!]) })}</span>
    : <span className="text-[var(--color-danger)]">{st.custom ? tr('未检测到（指定的 {path} 不可用）', { path: st.custom }) : tr('未检测到')}</span>
  return (
    <Section title={tr('本地终端')}>
      <Row label={tr('Git Bash 路径')} hint={hint}
        tip={tr('Windows 上本地终端和 AI 操作本地终端都需要 Git for Windows 里的 Git Bash（SSH 远程终端不需要）。自动检测依次查：这里手动指定的路径、环境变量 LINGSHELL_BASH、注册表里 Git for Windows 的安装位置、PATH 上的 git.exe / bash.exe、常见安装目录（Program Files、用户目录、scoop、各盘符下的 Git）。不认 C:\\Windows\\System32\\bash.exe（那是 WSL）。装在别处时点「选择…」指定 bash.exe（Git 安装目录下的 bin\\bash.exe）。')}>
        <button className={BTN2} onClick={() => act(() => client.gitBash.redetect())}>{tr('重新检测')}</button>
        <button className={BTN2} onClick={() => act(() => client.gitBash.pick())}>{tr('选择…')}</button>
        {st.custom && <button className={BTN2} title={tr('清除手动指定，改回自动检测')} onClick={() => act(() => client.gitBash.clear())}>{tr('清除')}</button>}
      </Row>
    </Section>
  )
}
