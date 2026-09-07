export const COMPANION_CAPABILITIES = ['knowledge', 'skills', 'ssh', 'git', 'companions', 'schedules', 'access', 'administration'] as const
export type CompanionCapability = typeof COMPANION_CAPABILITIES[number]

export const CAPABILITY_LABELS: Record<CompanionCapability, string> = {
  knowledge: '知识库', skills: 'Skill', ssh: 'SSH', git: 'Git', companions: '创建伙伴',
  schedules: '定时任务', access: '伙伴授权', administration: '伙伴管理（高权限）',
}

export function isCompanionCapability(value: string): value is CompanionCapability {
  return (COMPANION_CAPABILITIES as readonly string[]).includes(value)
}
