import { describe, it, expect } from 'vitest'
import { TEAM_FEATURES, TEAM_FEATURE_LABEL, hasTeamFeature, isTeamLicenseActive, type TeamEntitlements } from './team.js'

const ent = (over: Partial<TeamEntitlements> = {}): TeamEntitlements => ({
  edition: 'team', seats: 5, features: ['shared_vault', 'audit_export'], expiresAt: '2027-01-01T00:00:00Z', ...over,
})

describe('团队版协议辅助', () => {
  it('每个功能都有中文标签', () => {
    for (const f of TEAM_FEATURES) expect(TEAM_FEATURE_LABEL[f]).toBeTruthy()
  })
  it('hasTeamFeature：按 features 判断，未授权 / 无能力为 false', () => {
    expect(hasTeamFeature(ent(), 'shared_vault')).toBe(true)
    expect(hasTeamFeature(ent(), 'sso')).toBe(false)
    expect(hasTeamFeature(undefined, 'shared_vault')).toBe(false)
  })
  it('isTeamLicenseActive：未到期 true，到期 / 非法日期 false', () => {
    const now = new Date('2026-10-21T00:00:00Z')
    expect(isTeamLicenseActive(ent(), now)).toBe(true)
    expect(isTeamLicenseActive(ent({ expiresAt: '2026-10-20T00:00:00Z' }), now)).toBe(false)
    expect(isTeamLicenseActive(ent({ expiresAt: 'not-a-date' }), now)).toBe(false)
  })
})
