import { Switch } from '../../../components/ui/Switch.js'
import { NumberInput } from '../../../components/ui/NumberInput.js'
import { AppLockSettings } from './AppLockSettings.js'
import { CommandRules } from './CommandRules.js'
import { AiReviewSection } from './AiReviewSettings.js'
import { ruleError, tr, type SystemSettings as Sys } from '@lingshell/shared'
import { trx } from '../../../lib/trx.js'
import { Page, Row, Section } from '../ui.js'
import { Loading, TEXTAREA, useSystemSettings } from '../SystemSettings.js'
import { typingSecret } from '../useAutoSave.js'

// 命令规则里有不合法的正则：整页不保存（规则下方就地标红），改对了再自动保存。模式为空的规则本就不生效，不拦
const rulesError = (s: Sys) => (s.commandRules ?? []).some((r) => r.pattern && ruleError(r)) ? tr('命令规则里有不合法的正则') : null

// 正在命令规则的输入框里打字：等离开输入框再存，免得半截前缀（如「总是放行 sys」）先生效
const editingRule = () => typingSecret() || (document.activeElement instanceof HTMLInputElement && !!document.activeElement.closest('[data-command-rule]'))

// 设置 → AI 与安全：AI 执行 / 隐私 / 上下文 / 应用锁。改了自动保存，对新建会话及进行中会话的下一次请求生效
export function AiSecuritySettings() {
  const { loaded, sys, set, onBlur } = useSystemSettings({ validate: rulesError, defer: editingRule })
  if (!loaded) return <Loading />
  return (
    <Page onBlur={onBlur}>
      <Section title={tr('AI 执行')} tip={tr('改了自动保存并即时生效：新建的会话，以及正在进行的会话的下一次请求。')}>
        <Row label={tr('危险命令逐次确认')} hint={tr('rm -r、mkfs 等每次都问')}
          tip={trx('{rm}、{mkfs}、{curl} 这类即便已授权写入也每次问；关掉后只认授权面板里的写入权限。生产主机上的只读命令（cat / ls / grep 等）只需读取授权，不逐条确认。', { rm: <code>rm -r</code>, mkfs: <code>mkfs</code>, curl: <code>curl … | bash</code> })}>
          <Switch checked={sys.confirmDangerous} onCheckedChange={(v) => set({ confirmDangerous: v })} />
        </Row>
        <Row label={tr('命令执行超时')} hint={tr('秒，10–300')} tip={tr('AI 执行单条命令的最长等待时间，超时后中断。')}>
          <NumberInput className="w-28" value={sys.execTimeoutSec} min={10} max={300} onChange={(n) => set({ execTimeoutSec: n })} />
        </Row>
        <Row label={tr('AI 完成时通知')} hint={tr('窗口不在前台时弹系统通知')}
          tip={tr('AI 一轮跑完发「AI 已完成：会话标题」，出错发「AI 出错：错误摘要」；点通知回到窗口并切到那个会话。窗口在前台、你自己点了停止的不通知。')}>
          <Switch checked={sys.aiDoneNotify ?? true} onCheckedChange={(v) => set({ aiDoneNotify: v })} />
        </Row>
        <Row label={tr('AI 变更前后自动拍快照')} hint={tr('回合末显示「本轮主机变化」')}
          tip={tr('AI 在一轮里第一次对某台 Linux SSH 主机执行改动类命令 / 写文件前，先只读采一次端口、失败服务、容器和关键配置文件（限时 10 秒，失败不影响执行）；这一轮结束再采一次，有变化就在回复末尾显示「本轮主机变化」。只读命令（cat / ls / grep 等）不触发。快照也存进该主机的「主机体检」档案。')}>
          <Switch checked={sys.aiChangeSnapshot ?? true} onCheckedChange={(v) => set({ aiChangeSnapshot: v })} />
        </Row>
        <Row label={tr('全局自定义规则')} hint={tr('全局 → 分组 → 主机 → 工作目录 四层叠加，见「?」')} wide
          tip={trx('下一次模型请求即生效。规则分四层叠加，越具体的优先：{br}① 全局：这里写的，对所有会话生效；{br}② 分组：主机面板里右键分组 →「分组规则…」；{br}③ 主机：主机面板里右键主机 →「规则…」，或 设置 → 主机与连接 → 编辑主机 →「规则」；{br}④ 工作目录：会话绑定的工作目录里的 {agents} 或 {rules}。{br}分组 / 主机规则只在 AI 用到过该主机后才注入；总长有上限，超出时优先保留更具体的层。例：数据库组写「禁止重启 mysqld，变更前先 mysqldump」。',
            { br: <br />, agents: <code>AGENTS.md</code>, rules: <code>.lingshell/rules.md</code> })}>
          <textarea value={sys.customRules} onChange={(e) => set({ customRules: e.target.value })} rows={4}
            placeholder={tr('如：回复用中文；改配置前先备份；重启服务前先问我')} className={TEXTAREA} />
        </Row>
        <Row label={tr('本机备注')} hint={tr('同步成知识库里「本机」的一张卡')} tip={tr('AI 用到本地终端时会读到。写本机用途、常用目录、注意事项等，不要写密码等机密。分条记录请用知识库（左侧活动栏「知识库」）。')} wide>
          <textarea value={sys.localNotes} onChange={(e) => set({ localNotes: e.target.value })} rows={3}
            placeholder={tr('本机用途、常用目录、注意事项…（不要写密码等机密）')} className={TEXTAREA} />
        </Row>
      </Section>

      <AiReviewSection sys={sys} set={set} />

      <Section title={tr('命令规则')} tip={trx('AI 执行终端命令前先按这里的规则判定（从上到下，先匹配先生效）。复合命令（{semi} {and} {or} {pipe} 换行、{sub}、反引号）拆成段逐段匹配： 任一段命中「总是禁止」→ 直接拒绝；所有段都命中「总是放行」→ 不弹授权卡；有段命中「总是询问」→ 弹卡；其余照会话信任档。 「只读」信任档不会被放行规则突破；生产主机上的危险命令仍要确认。按规则放行 / 禁止的会在执行记录和授权卡里注明「按规则：…」。',
        { semi: <code>;</code>, and: <code>&amp;&amp;</code>, or: <code>||</code>, pipe: <code>|</code>, sub: <code>$( )</code> })}>
        <Row label={tr('规则列表')} hint={tr('前缀匹配命令段开头；正则在命令段里搜索（锚定开头写 ^）')} wide>
          <CommandRules rules={sys.commandRules ?? []} onChange={(commandRules) => set({ commandRules })} />
        </Row>
      </Section>

      <Section title={tr('隐私')}>
        <Row label={tr('发给 AI 前脱敏')} hint={tr('把密码、密钥等换成 [已脱敏]')}
          tip={trx('命令输出、文件内容、终端屏幕、MCP 结果在交给 AI 前，把已保存的主机密码/私钥、各家 API Key、群机器人 Webhook、MCP 凭据、自动应答密钥， 以及 {pw}、{db}、私钥块、JWT、{sk} 这类样式的值换成 {red}（对话里的工具卡片显示的也是脱敏后的）。 终端里你看到的、执行记录和录像不受影响。{br}代价：AI 看不到真实密钥值，排查「密码填错」「Key 不对」这类问题会受限； AI 想把 {red} 写回文件或命令会被直接拒绝。按样式识别是尽力而为，不能保证抹掉所有机密。',
            { pw: <code>password=</code>, db: <code>DB_PASS=</code>, sk: <code>sk-…</code>, red: <code>[已脱敏]</code>, br: <br /> })}>   {/* i18n-ignore 脱敏占位符本身不随语言变（shared/ai/redact.ts REDACTED） */}
          <Switch checked={sys.aiRedact} onCheckedChange={(v) => set({ aiRedact: v })} />
        </Row>
      </Section>

      <Section title={tr('上下文')}>
        <Row label={tr('自动压缩阈值')} hint={tr('自动：模型上下文窗口的 60%，最多 600K')}
          tip={tr('对话上下文超过阈值时，自动把较早的对话压缩成摘要，任务不中断。阈值按当前会话所用模型配置的「上下文窗口」计算，不用单独设置；各配置的具体数值见「模型设置」。')} />
        <Row label={tr('建议开新会话步数')} hint={tr('0 = 不提示')} tip={tr('会话执行到这么多步、且已压缩过时，提示是否用压缩摘要开新会话（只是建议，可忽略）。')}>
          <NumberInput className="w-28" value={sys.contextResetSteps} min={0} max={10000} onChange={(n) => set({ contextResetSteps: n })} />
        </Row>
      </Section>

      <AppLockSettings>
        <Row label={tr('空闲自动锁定')} hint={tr('分钟，0 = 不按空闲锁定')} tip={tr('按系统空闲时间计算。0 = 只在启动、手动、系统锁屏 / 休眠时锁定。需要先启用应用锁。')}>
          <NumberInput className="w-28" value={sys.lockIdleMinutes} min={0} max={1440} onChange={(n) => set({ lockIdleMinutes: n })} />
        </Row>
      </AppLockSettings>
    </Page>
  )
}
