export const SKILL_CONTEXTS = ['inline', 'fork'] as const
export type SkillExecutionContext = typeof SKILL_CONTEXTS[number]
export type SkillSourceKind = 'builtin' | 'market' | 'local'

export interface PartnerSkill {
  id: string
  name: string
  displayName: string
  description: string
  version: string
  source: SkillSourceKind
  sourceId?: string
  rootPath: string
  checksum: string
  allowedTools: string[]
  executionContext: SkillExecutionContext
  userInvocable: boolean
  trusted: boolean
  installedAt: number
  updatedAt: number
}
export interface CompanionSkillBinding {
  companionId: string
  skillId: string
  enabled: boolean
  config?: Record<string, string | number | boolean>
}

export interface SkillMarketSource {
  id: string
  name: string
  indexUrl: string
  enabled: boolean
  trusted: boolean
  createdAt: number
  updatedAt: number
}

export interface MarketSkillEntry {
  id: string
  name: string
  description: string
  version: string
  tags: string[]
  skillUrl: string
  checksum?: string
  sourceId: string
}

export interface LoadedSkill extends PartnerSkill {
  body: string
}
