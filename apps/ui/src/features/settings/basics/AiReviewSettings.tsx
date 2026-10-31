import { Switch } from '../../../components/ui/Switch.js'
import { Select } from '../../../components/ui/Select.js'
import { AI_REVIEW_SCOPES, DEFAULT_AI_REVIEW, type AiReviewSettings, type AiReviewScope, type SystemSettings, tr } from '@lingshell/shared'
import { useModelProfiles } from '../../../lib/modelProfiles.js'
import { Row, Section } from '../ui.js'
import { Sub } from '../SystemSettings.js'
import { trx } from '../../../lib/trx.js'

// 设置 → AI 与安全 →「AI 复核」：高风险命令弹授权卡前，先让第二个模型（可选更便宜的配置）审一遍（双人复核）
export function AiReviewSection({ sys, set }: { sys: SystemSettings; set: (p: Partial<SystemSettings>) => void }) {
  const mp = useModelProfiles()
  const r: AiReviewSettings = { ...DEFAULT_AI_REVIEW, ...(sys.aiReview ?? {}) }
  const put = (p: Partial<AiReviewSettings>) => set({ aiReview: { ...r, ...p } })
  return (
    <Section title={tr('AI 复核')} tip={trx('参考 VS Code 的辅助授权与运维的双人复核：命中范围的命令在弹授权卡前，先把命令、主机、会话最近的上下文、该主机的规则与知识卡标题交给复核模型， 它回答「安全 / 风险 / 建议拦截」和一句理由，显示在授权卡上（「AI 复核：风险 · 理由」），也记进执行记录。写文件的改动还会把 diff 一并发给复核模型。 这些内容先按「发给 AI 前脱敏」处理，密钥保险箱里的值会换成占位符，复核模型同样看不到明文。{br}复核限时 15 秒，超时或出错按「未复核」照常弹卡。 「安全」不会自动放行（生产主机始终要你确认）。', { br: <br /> })}>
      <Row label={tr('启用 AI 复核')} hint={tr('默认关；每次复核会多一次模型调用')}>
        <Switch checked={r.enabled} onCheckedChange={(v) => put({ enabled: v })} />
      </Row>
      {r.enabled && (
        <Sub>
          <Row label={tr('复核用的模型')} hint={tr('可选一个更便宜的配置')} tip={tr('在「模型设置」里可新建模型配置；复核用量记在用量统计的「ai-review」来源下。')}>
            <Select size="sm" className="w-56" value={r.profileId ?? ''} onValueChange={(v) => put({ profileId: v || undefined })}
              options={[{ value: '', label: tr('默认配置') }, ...mp.profiles.map((p) => ({ value: p.id, label: tr('{name}（{model}）', { name: p.name, model: p.model }) }))]} />
          </Row>
          <Row label={tr('复核范围')} tip={tr('生产主机的写命令：只复核标为「生产」的主机上的非只读命令 / 写文件；所有危险命令：任何主机上命中危险模式的（rm -r、mkfs 等）；所有写命令：所有非只读命令与写文件（每张写入授权卡都会多等几秒）。只复核要弹授权卡的命令。')}>
            <Select size="sm" className="w-56" value={r.scope} onValueChange={(v) => put({ scope: v as AiReviewScope })}
              options={AI_REVIEW_SCOPES.map((s) => ({ value: s.id, label: tr(s.label) }))} />
          </Row>
          <Row label={tr('复核判「建议拦截」时')} tip={tr('直接拒绝：不弹授权卡，把理由告诉主 AI（执行记录里记「AI 复核拦截」）；只提示不拦截：照常弹卡，卡上标红提示。')}>
            <Select size="sm" className="w-56" value={r.onBlock} onValueChange={(v) => put({ onBlock: v as AiReviewSettings['onBlock'] })}
              options={[{ value: 'deny', label: tr('直接拒绝并告诉 AI') }, { value: 'warn', label: tr('只提示不拦截') }]} />
          </Row>
          <Row label={tr('复核通过则自动放行')} hint={tr('仅非生产主机 + 信任档「确认」')} tip={tr('会话信任档为「确认」、主机不是生产、命令不是危险命令、复核判「安全」时，不弹卡直接执行（执行记录里注明「AI 复核通过」）。其余情况照常弹卡。默认关。')}>
            <Switch checked={r.autoAllowSafe} onCheckedChange={(v) => put({ autoAllowSafe: v })} />
          </Row>
        </Sub>
      )}
    </Section>
  )
}
