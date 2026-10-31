import { useEffect, useState } from 'react'
import { BALL_OPACITIES, tr, type BackgroundPatch, type BackgroundStatus } from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { Switch } from '../../../components/ui/Switch.js'
import { Select } from '../../../components/ui/Select.js'
import { Row, Section } from '../ui.js'
import { Sub } from '../SystemSettings.js'

const errMsg = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': Error:\s*/, '')

// 设置 → 通用 →「启动与后台」：开机自启 / 关窗进托盘 / 悬浮球。改动即时生效（存 background.json，登录项写进系统），不走页面的自动保存
export function BackgroundSection() {
  const [st, setSt] = useState<BackgroundStatus>()
  const [err, setErr] = useState('')
  useEffect(() => {
    client.background.status().then(setSt).catch(() => {})
    // 托盘 / 悬浮球菜单里也能开关悬浮球、调透明度：设置页开着时同步过来，别显示旧状态
    return client.on((ev) => { if (ev.type === 'background:changed') setSt(ev.status) })
  }, [])
  if (!st) return null
  const set = (p: BackgroundPatch) => client.background.configure(p).then((s) => { setSt(s); setErr('') }).catch((e) => setErr(errMsg(e)))
  return (
    <Section title={tr('启动与后台')} tip={tr('开机自启、关闭窗口后留在系统托盘、桌面悬浮球。这里的改动立即生效。')}>
      <Row label={tr('开机自启')} hint={st.loginSupported ? tr('登录系统后自动启动灵壳') : st.dev ? tr('开发版不支持，请在安装版里设置') : tr('当前系统不支持')}
        tip={<>{tr('写入系统的登录启动项（Windows：当前用户的「启动」项；macOS：登录项），关掉即删除。')}{!st.startHiddenSupported && st.loginSupported && <><br />{tr('macOS 13+ 的登录项不支持隐藏启动，所以没有「启动时只进托盘」。')}</>}{st.dev && <><br />{tr('开发版不能设置：它注册的是 electron.exe + 源码目录，开机时没有界面服务器只会卡在启动页，还会覆盖安装版的设置。')}</>}</>}>
        <Switch data-bg-login checked={st.openAtLogin} disabled={!st.loginSupported} onCheckedChange={(v) => void set({ openAtLogin: v })} />
      </Row>
      {st.openAtLogin && st.startHiddenSupported && (
        <Sub>
          <Row label={tr('启动时只进托盘')} hint={tr('不弹主窗口，从托盘图标打开')} tip={tr('开机自启时带 --hidden 参数启动：不显示启动画面和主窗口，只在托盘里待命（AI 会话、巡检、看门狗照常）。手动启动不受影响。')}>
            <Switch data-bg-hidden checked={st.startHidden} onCheckedChange={(v) => void set({ startHidden: v })} />
          </Row>
        </Sub>
      )}
      <Row label={tr('关闭主窗口时最小化到托盘')} hint={tr('点 × 不退出，从托盘图标再打开')}
        tip={tr('开着时点窗口右上角 × 只是把窗口藏到系统托盘，AI 会话、巡检、看门狗、传输都继续跑；第一次会弹一条通知提醒。要真正退出：托盘图标右键 →「退出」（悬浮球右键菜单也有）。退出时还有传输未完成会先确认。关掉则点 × 直接退出。')}>
        <Switch data-bg-tray checked={st.closeToTray} onCheckedChange={(v) => void set({ closeToTray: v })} />
      </Row>
      <Row label={tr('显示悬浮球')} hint={tr('桌面上的小球：悬停看状态，右键快捷操作')}
        tip={tr('一个始终在最前的小球：灰色 = 空闲，蓝色转圈 = AI 运行中，橙色闪烁 + 数字 = 有待授权，红色 = 看门狗报警或 AI 最近出错。鼠标悬停展开状态卡（进行中的会话、待授权、看门狗、传输、当前主机 CPU / 内存），左键显示 / 隐藏主窗口，右键快速提问、处理待授权、调透明度等。可拖到任意位置，位置会记住。应用锁定时只显示锁。')}>
        <Switch data-bg-ball checked={st.ball} onCheckedChange={(v) => void set({ ball: v })} />
      </Row>
      {st.ball && (
        <Sub>
          <Row label={tr('透明度')} hint={tr('鼠标移上去时总是不透明')}>
            <Select className="w-[110px]" value={String(st.ballOpacity)} onValueChange={(v) => void set({ ballOpacity: Number(v) })}
              options={BALL_OPACITIES.map((o) => ({ value: String(o), label: `${o}%` }))} />
          </Row>
          <Row label={tr('贴边自动半隐藏')} hint={tr('拖到屏幕左右边缘时只露一半')} tip={tr('拖到屏幕左右边缘会自动吸附；开着时鼠标离开后缩进去只露半个球，鼠标移上去完整滑出。多显示器之间相邻的边不吸附。')}>
            <Switch data-bg-autohide checked={st.ballAutoHide} onCheckedChange={(v) => void set({ ballAutoHide: v })} />
          </Row>
        </Sub>
      )}
      {err && <div className="px-3.5 py-2 text-[11.5px] text-[var(--color-danger)]">{err}</div>}
    </Section>
  )
}
