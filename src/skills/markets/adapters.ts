import type { MarketSkillEntry, SkillMarketSource } from '../domain.js'

export interface MarketRequest { url: string; init?: RequestInit }

export function marketRequest(source: SkillMarketSource): MarketRequest {
  if (source.kind !== 'clawhub') return { url: source.indexUrl }
  return { url: source.indexUrl, init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'skills:listPublicPageV4', format: 'convex_encoded_json', args: [{ dir: 'desc', numItems: 100, sort: 'newest' }] }) } }
}

export function parseMarketResponse(raw: unknown, source: SkillMarketSource): MarketSkillEntry[] {
  if (source.kind === 'dsh-index') return parseDshIndex(raw, source)
  if (source.kind === 'clawhub') return parseClawHub(raw, source)
  if (source.kind === 'loophub') return parseLoopHub(raw, source)
  return parseSkillHub(raw, source)
}

function parseClawHub(root: unknown, source: SkillMarketSource): MarketSkillEntry[] {
  const rows = valueAt(root, ['value', 'page']) ?? valueAt(root, ['value', 'items'])
  return bounded(rows).flatMap((row, index) => {
    const skill = objectAt(row, 'skill'); const version = objectAt(row, 'latestVersion')
    const slug = cleanId(textAt(skill, 'slug')); const owner = cleanId(textAt(row, 'ownerHandle'))
    if (!slug || !owner || skill.isSuspicious === true) return []
    return [{ id: cleanId(`clawhub-${owner}-${slug}`) || `clawhub-${index}`, name: textAt(skill, 'displayName') || slug, description: textAt(skill, 'summary') || textAt(version, 'parsed', 'description') || 'ClawHub Skill', version: textAt(version, 'version') || '0.0.0', tags: stringList(skill.topics), skillUrl: `https://clawhub.ai/api/v1/download?slug=${encodeURIComponent(slug)}&version=${encodeURIComponent(textAt(version, 'version') || 'latest')}`, installKind: 'zip', sourceId: source.id }]
  })
}

function parseLoopHub(root: unknown, source: SkillMarketSource): MarketSkillEntry[] {
  return bounded(valueAt(root, ['data', 'items'])).flatMap((row, index) => {
    const skillUrl = textAt(row, 'download_url')
    if (!/^https:\/\/dl\.cocoloop\.cn\/bss\/skills\//.test(skillUrl)) return []
    const author = cleanId(textAt(row, 'author')) || 'community'; const name = textAt(row, 'name') || `LoopHub Skill ${index + 1}`
    return [{ id: cleanId(`loophub-${author}-${name}`) || `loophub-${index}`, name, description: textAt(row, 'brief') || textAt(row, 'subtitle') || 'LoopHub Skill', version: versionFromUrl(skillUrl), tags: [textAt(row, 'category'), textAt(row, 'security_level')].filter(Boolean), skillUrl, installKind: 'zip', sourceId: source.id }]
  })
}

function parseSkillHub(root: unknown, source: SkillMarketSource): MarketSkillEntry[] {
  return bounded(valueAt(root, ['data', 'skills'])).flatMap((row, index) => {
    const namespace = objectAt(row, 'namespace'); const canonical = textAt(namespace, 'canonicalName')
    const handle = cleanId(textAt(namespace, 'handle')); const slug = cleanId(textAt(row, 'slug'))
    if (!handle || !slug) return []
    return [{ id: cleanId(`skillhub-${handle}-${slug}`) || `skillhub-${index}`, name: textAt(row, 'name') || canonical || slug, description: textAt(row, 'description_zh') || textAt(row, 'description') || 'SkillHub Skill', version: textAt(row, 'version') || '0.0.0', tags: bounded(valueAt(row, ['subCategories']), 12).map(item => textAt(item, 'name')).filter(Boolean), skillUrl: `https://api.skillhub.cn/api/v1/download?slug=${encodeURIComponent(slug)}`, installKind: 'zip', sourceId: source.id }]
  })
}

function parseDshIndex(value: unknown, source: SkillMarketSource): MarketSkillEntry[] {
  const entries = Array.isArray(value) ? value : object(value).skills
  if (!Array.isArray(entries) || entries.length > 2000) throw new Error('Skill market index must contain at most 2000 skills')
  const base = new URL(source.indexUrl)
  return entries.map(item => {
    const row = object(item); const id = required(row.id, 'id', 120); const skillUrl = new URL(required(row.skillUrl, 'skillUrl', 2000), base).toString()
    const checksum = typeof row.checksum === 'string' && row.checksum.trim() ? row.checksum.trim() : undefined
    return { id, name: required(row.name, 'name', 120), description: required(row.description, 'description', 600), version: typeof row.version === 'string' ? row.version.slice(0, 80) : '0.0.0', tags: stringList(row.tags), skillUrl, installKind: 'markdown', ...(checksum ? { checksum } : {}), sourceId: source.id }
  })
}

function bounded(value: unknown, max = 200): Record<string, unknown>[] { return Array.isArray(value) ? value.slice(0, max).filter(item => typeof item === 'object' && item !== null && !Array.isArray(item)) as Record<string, unknown>[] : [] }
function object(value: unknown): Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function objectAt(value: unknown, key: string): Record<string, unknown> { return object(object(value)[key]) }
function valueAt(value: unknown, path: string[]): unknown { let current = value; for (const key of path) current = object(current)[key]; return current }
function textAt(value: unknown, ...path: string[]): string { const result = valueAt(value, path); return typeof result === 'string' ? result.trim().slice(0, 600) : '' }
function stringList(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map(item => item.trim().slice(0, 40)).filter(Boolean).slice(0, 20) : [] }
function cleanId(value: string): string { return value.trim().toLocaleLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[._-]+|[._-]+$/g, '').slice(0, 120) }
function required(value: unknown, label: string, max: number): string { if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`); return value.trim().slice(0, max) }
function versionFromUrl(url: string): string { return url.match(/-(\d+\.\d+\.\d+)\.zip(?:$|\?)/)?.[1] ?? '0.0.0' }
