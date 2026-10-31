import { useEffect, useState } from 'react'
import type { SystemSettings as Sys, TerminalCursorStyle, TerminalThemeId } from '@lingshell/shared'
import { REPLAY_DEFAULT_MB, REPLAY_MAX_MB, tr } from '@lingshell/shared'
import { trx } from '../../../lib/trx.js'
import { client } from '../../../client/index.js'
import { Sel } from '../../../components/ui/form.js'
import { Combobox } from '../../../components/ui/Combobox.js'
import { FONT_MAX, FONT_MIN, LINE_HEIGHTS, SCROLLBACK_MAX, SCROLLBACK_MIN, THEME_OPTIONS, fontFamilyOf, setTermPrefs, termPrefsOf, themeOf } from '../../../lib/termPrefs.js'
import { HighlightRules, badRegex } from './HighlightRules.js'
import { Switch } from '../../../components/ui/Switch.js'
import { NumberInput } from '../../../components/ui/NumberInput.js'
import { BTN2, INPUT, Page, Row, Section } from '../ui.js'
import { Loading, Sub, useSystemSettings } from '../SystemSettings.js'

const FONT_SUGGEST = ['JetBrains Mono', 'Cascadia Code', 'Cascadia Mono', 'Consolas', 'Fira Code', 'Source Code Pro', 'Sarasa Mono SC', 'Menlo', 'monospace']

// 高亮规则里有不合法的正则：不保存（就地标红），改对了再自动保存。高亮关着时规则不显示也不生效，不拦
const highlightError =(s: Sys) => (s.terminalHighlight && (s.highlightRules ?? []).some(badRegex) ? tr('关键字高亮里有不合法的正则') : null)

// 设置 → 终端：外观 / 输入 / 提醒 / 记录。改了自动保存，已打开的终端即时换上新外观
export function TerminalSettings() {
  const { loaded, sys, set, onBlur } = useSystemSettings({ onSaved: (s) => setTermPrefs(termPrefsOf(s)), validate: highlightError })
  if (!loaded) return <Loading />
  return (
    <Page onBlur={onBlur}>
      <Section title={tr('外观')} tip={tr('改了自动保存，已打开的终端立即换上新外观。')}>
        <Row label={tr('配色')} tip={tr('「跟随界面主题」：深色界面用深色配色，浅色界面用浅色配色（界面主题在 设置 → 通用 → 外观）。选了具体配色就固定用它，不随界面变。')}>
          <div className="w-48"><Sel value={sys.terminalTheme} onChange={(v) => set({ terminalTheme: v as TerminalThemeId })}>
            {THEME_OPTIONS.map((t) => <option key={t.id} value={t.id}>{tr(t.label)}</option>)}
          </Sel></div>
        </Row>
        <Row label={tr('字号')} hint={`${FONT_MIN}–${FONT_MAX}`} tip={tr('终端里也可以用 Ctrl+= / Ctrl+- / Ctrl+0 临时调整。')}>
          <NumberInput className="w-28" value={sys.terminalFontSize} min={FONT_MIN} max={FONT_MAX} onChange={(n) => set({ terminalFontSize: n })} />
        </Row>
        <Row label={tr('字体')} hint={tr('留空 = 内置等宽字体')} tip={tr('填系统里装了的等宽字体名；没装的字体会自动退回内置字体。')}>
          <Combobox className="w-56" value={sys.terminalFontFamily} onChange={(v) => set({ terminalFontFamily: v.slice(0, 200) })} placeholder={tr('如：Fira Code')} options={FONT_SUGGEST} />
        </Row>
        <Row label={tr('行距')}>
          <div className="w-28"><Sel value={String(sys.terminalLineHeight)} onChange={(v) => set({ terminalLineHeight: Number(v) })}>
            {LINE_HEIGHTS.map((h) => <option key={h} value={String(h)}>{h.toFixed(1)}</option>)}
          </Sel></div>
        </Row>
        <Row label={tr('光标样式')}>
          <div className="w-28"><Sel value={sys.terminalCursorStyle} onChange={(v) => set({ terminalCursorStyle: v as TerminalCursorStyle })}>
            <option value="block">{tr('方块')}</option><option value="underline">{tr('下划线')}</option><option value="bar">{tr('竖线')}</option>
          </Sel></div>
        </Row>
        <Row label={tr('光标闪烁')}>
          <Switch checked={sys.terminalCursorBlink} onCheckedChange={(v) => set({ terminalCursorBlink: v })} />
        </Row>
        <Row label={tr('回滚行数')} hint={`${SCROLLBACK_MIN}–${SCROLLBACK_MAX}`} tip={tr('终端能往回翻的行数。越大越占内存。')}>
          <NumberInput className="w-32" value={sys.terminalScrollback} min={SCROLLBACK_MIN} max={SCROLLBACK_MAX} step={1000} onChange={(n) => set({ terminalScrollback: n })} />
        </Row>
        <Row label={tr('预览')} wide><TermPreview sys={sys} /></Row>
      </Section>

      <Section title={tr('输入')}>
        <Row label={tr('粘贴安全检查')} hint={tr('含危险命令或隐藏字符时先确认')}
          tip={tr('任何终端粘贴的内容含危险命令、或含隐藏 / 控制字符时先弹确认。生产终端粘贴多行内容总会先确认，不受这个开关影响。')}>
          <Switch checked={sys.terminalPasteCheck ?? true} onCheckedChange={(v) => set({ terminalPasteCheck: v })} />
        </Row>
        <Row label={tr('命令自动补全')} hint={tr('在提示符键入时弹出候选')}
          tip={tr('候选来自本主机命令历史、快速命令和常用命令。Tab / → 接受，Esc 关闭。')}>
          <Switch checked={!!sys.terminalAutoComplete} onCheckedChange={(v) => set({ terminalAutoComplete: v })} />
        </Row>
        <Row label={tr('AI 预测下一条命令')} hint={tr('提示符后灰色显示，→ 接受')}
          tip={tr('停在空提示符 0.8 秒后，按这个终端最近 5 条命令和最后一条输出的末尾（按「发给 AI 前脱敏」处理；生产主机只发命令、不发输出）问一次当前模型，把预测的命令用灰色显示在光标后。按 → 写进提示符（不回车），按其它键消失。同一个提示符只问一次，每分钟最多 6 次；没配 API Key 时不显示。补全浮层开着时不显示。会消耗少量 tokens。')}>
          <Switch checked={!!sys.terminalPredict} onCheckedChange={(v) => set({ terminalPredict: v })} />
        </Row>
      </Section>

      <Section title={tr('提醒')}>
        <Row label={tr('长命令完成通知')} hint={tr('秒，0 = 关')}
          tip={tr('你自己敲的命令（需要命令成败标记，见使用帮助）跑得比这个秒数久，且窗口不在前台或该标签没显示时，弹系统通知；后台标签上同时出现绿 / 红小圆点，切过去就消失。AI 执行的命令不提醒。')}>
          <NumberInput className="w-28" value={sys.terminalNotifySec} min={0} max={86400} step={10} onChange={(n) => set({ terminalNotifySec: n })} />
        </Row>
        <Row label={tr('命令失败时提示让 AI 排查')} hint={tr('终端底部出现一条横幅')}
          tip={tr('你自己敲的命令失败（成败标记为红点）时，终端底部出现「让 AI 排查」，点一下把命令、退出码、目录和输出尾部（按「发给 AI 前脱敏」处理）直接发到当前对话。AI 执行的命令、Ctrl+C 中断的不提示；按 × 关掉的同一条命令之后不再提示。')}>
          <Switch checked={sys.terminalFailHint ?? true} onCheckedChange={(v) => set({ terminalFailHint: v })} />
        </Row>
        <Row label={tr('响铃提示')} tip={trx('终端收到响铃 \\a 时提示，例如远端执行 {code}。「角标 + 通知」：后台标签显示铃铛，窗口不在前台时弹系统通知。', { code: <code>{tr("长任务; printf '\\a'")}</code> })}>
          <div className="w-36"><Sel value={sys.terminalBell ?? 'notify'} onChange={(v) => set({ terminalBell: v as Sys['terminalBell'] })}>
            <option value="notify">{tr('角标 + 通知')}</option>
            <option value="badge">{tr('仅角标')}</option>
            <option value="off">{tr('关')}</option>
          </Sel></div>
        </Row>
        <Row label={tr('关键字高亮')} hint={tr('规则点亮铃铛 = 命中时告警')}
          tip={tr('只改变显示颜色，不影响录屏和 AI 读取的输出；vim / top 等全屏程序内不生效。规则点亮铃铛后，命中时标签角标 / 系统通知（每 30 秒最多一次）。')}>
          <Switch checked={sys.terminalHighlight} onCheckedChange={(v) => set({ terminalHighlight: v })} />
        </Row>
        {sys.terminalHighlight && (
          <Sub><Row label={tr('高亮规则')} wide>
            <HighlightRules rules={sys.highlightRules} theme={sys.terminalTheme} onChange={(r) => set({ highlightRules: r })} />
          </Row></Sub>
        )}
      </Section>

      <Section title={tr('记录')}>
        <Row label={tr('即时回放缓冲')} hint={tr('MB，0 = 关，最大 {max}', { max: REPLAY_MAX_MB })}
          tip={tr('每个终端在内存里保留最近这么多输出（含时间），按 Ctrl+Alt+R 或右侧活动栏「即时回放」拖时间轴回看任意时刻的屏幕，包括被 clear、top、vim 刷掉的画面。只在内存里、不落盘，关掉终端或应用就没了；超出上限时最早的部分先丢。每个终端各占这么多内存。')}>
          <NumberInput className="w-28" value={sys.terminalReplayMB ?? REPLAY_DEFAULT_MB} min={0} max={REPLAY_MAX_MB} onChange={(n) => set({ terminalReplayMB: n })} />
        </Row>
        <Row label={tr('自动记录会话日志')} hint={tr('每个终端的输出存为纯文本 .log')}
          tip={tr('记的是终端上显示的输出（含命令回显），去掉颜色等控制字符；AI 执行命令时的内部包装不会进日志。不记键入：密码提示下不回显，所以密码不会出现在日志里（但命令输出里本身显示的敏感信息会被记下）。日志不进诊断包。')}>
          <Switch checked={sys.sessionLog} onCheckedChange={(v) => set({ sessionLog: v })} />
        </Row>
        {sys.sessionLog && (
          <Sub>
            <Row label={tr('日志目录')} hint={tr('留空 = 数据目录下 logs/sessions')} tip={tr('按日期分子目录存放。')} wide>
              <div className="flex gap-2">
                <LogDirInput value={sys.sessionLogDir} onCommit={(d) => set({ sessionLogDir: d })} />
                <button onClick={() => client.system.pickDirectory().then((d) => { if (d) set({ sessionLogDir: d }) })} className={BTN2}>{tr('选择…')}</button>
                <button onClick={() => client.sessionLogs.openFolder(sys.sessionLogDir || undefined).catch(() => {})} className={BTN2}>{tr('打开目录')}</button>
              </div>
            </Row>
            <Row label={tr('日志保留天数')} hint={tr('0 = 永久保留')} tip={tr('启动时及每天删除更早的日期目录。')}>
              <NumberInput className="w-28" value={sys.sessionLogRetentionDays} min={0} max={3650} onChange={(n) => set({ sessionLogRetentionDays: n })} />
            </Row>
            <Row label={tr('每行加时间戳')}>
              <Switch checked={sys.sessionLogTimestamps} onCheckedChange={(v) => set({ sessionLogTimestamps: v })} />
            </Row>
          </Sub>
        )}
        <Row label={tr('允许终端录屏')} hint={sys.terminalRecording ? <span className="text-[var(--color-danger)]">{tr('录制会记下键入的一切，包括密码')}</span> : tr('审计用，终端标签栏出现录制按钮')}
          tip={tr('开启后终端标签栏出现录制按钮，点一下开始录当前终端、再点停止。录制期间会录下屏幕输出和键入的一切——包括在 sudo、ssh、mysql 等密码提示下敲的密码，以明文存在 ~/.lingshell/recordings。录像可在「终端录像」里回放，不会进入诊断包。关闭此开关会停止所有正在进行的录制。')}>
          <Switch checked={sys.terminalRecording} onCheckedChange={(v) => set({ terminalRecording: v })} />
        </Row>
        <Row label={tr('录像保留天数')} hint={tr('0 = 永久保留')} tip={tr('启动时删除更早的录像。')}>
          <NumberInput className="w-28" value={sys.recordingRetentionDays} min={0} max={3650} onChange={(n) => set({ recordingRetentionDays: n })} />
        </Row>
      </Section>
    </Page>
  )
}

// 日志目录：失焦 / 回车才提交。换目录会让主进程结束现有日志、在新目录开新文件，输入到一半就存会建出半截路径的目录
function LogDirInput({ value, onCommit }: { value: string; onCommit: (d: string) => void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = () => { if (draft !== value) onCommit(draft) }
  return <input value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit() }}
    placeholder={tr('默认目录')} spellCheck={false} className={`${INPUT} min-w-0 flex-1`} />
}

// 外观预览：按当前表单的字体 / 字号 / 行距 / 配色画几行示例（含中文和颜色），保存前就能看到效果
function TermPreview({ sys }: { sys: Sys }) {
  const t = themeOf(sys.terminalTheme)
  const c = (k: keyof typeof t) => ({ color: t[k] as string })
  const cursor: React.CSSProperties = sys.terminalCursorStyle === 'block' ? { background: t.cursor as string, color: t.background as string }
    : sys.terminalCursorStyle === 'underline' ? { borderBottom: `2px solid ${t.cursor as string}` } : { borderLeft: `2px solid ${t.cursor as string}` }
  return (
    <div data-testid="term-preview" className="overflow-hidden rounded-md border border-[var(--color-border-subtle)] px-3 py-2"
      style={{ background: t.background as string, color: t.foreground as string, fontFamily: fontFamilyOf(sys.terminalFontFamily), fontSize: sys.terminalFontSize, lineHeight: sys.terminalLineHeight, whiteSpace: 'pre' }}>
      <div><span style={c('green')}>user@web-01</span>:<span style={c('blue')}>~/app</span>$ ls -l</div>
      <div><span style={c('blue')}>logs</span>  <span style={c('green')}>start.sh</span>  配置.yml  <span style={c('red')}>ERROR</span> <span style={c('yellow')}>WARN</span> <span style={c('cyan')}>10.0.0.1</span></div>{/* i18n-ignore 示例文件名，演示中文字形 */}
      <div><span style={c('green')}>user@web-01</span>:<span style={c('blue')}>~/app</span>$ <span style={cursor}> </span></div>
    </div>
  )
}
