import type { SkillMarketSource } from '../domain.js'

export const BUILTIN_MARKET_IDS = {
  clawhub: 'market-clawhub',
  loophub: 'market-loophub',
  skillhub: 'market-skillhub',
} as const

/** Public Skill rankings built into nomifun's Skill market. */
export function builtinMarketSources(now = Date.now()): SkillMarketSource[] {
  return [
    { id: BUILTIN_MARKET_IDS.clawhub, name: 'ClawHub', kind: 'clawhub', indexUrl: 'https://wry-manatee-359.convex.cloud/api/query', enabled: true, trusted: false, builtin: true, createdAt: now, updatedAt: now },
    { id: BUILTIN_MARKET_IDS.loophub, name: 'LoopHub', kind: 'loophub', indexUrl: 'https://api.cocoloop.cn/api/v1/store/skills?page=1&page_size=100&sort=downloads&tab=overall', enabled: true, trusted: false, builtin: true, createdAt: now, updatedAt: now },
    { id: BUILTIN_MARKET_IDS.skillhub, name: 'SkillHub', kind: 'skillhub', indexUrl: 'https://api.skillhub.cn/api/skills?page=1&pageSize=100&sortBy=score&order=desc', enabled: true, trusted: false, builtin: true, createdAt: now, updatedAt: now },
  ]
}

export function mergeBuiltinMarketSources(sources: SkillMarketSource[], now = Date.now()): SkillMarketSource[] {
  const builtins = builtinMarketSources(now)
  const byId = new Map(sources.map(source => [source.id, source]))
  return [...builtins.map(source => ({ ...source, enabled: byId.get(source.id)?.enabled ?? source.enabled })), ...sources.filter(source => !builtins.some(builtin => builtin.id === source.id))]
}
