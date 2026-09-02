import { randomUUID } from 'node:crypto'
import type { Companion, PartnerState } from '../domain.js'
import type { PartnerStore } from '../store.js'
import { optionalBoolean, requiredText } from '../core/validation.js'
import { AsyncSemaphore } from '../core/semaphore.js'
import type { LoadedSkill, MarketSkillEntry, PartnerSkill, SkillMarketSource } from './domain.js'
import { sha256 } from './loader.js'
import { SkillRepository } from './repository.js'
import { BUILTIN_SKILLS, BUILTIN_SKILL_SOURCE } from './builtin.js'
import { marketRequest, parseMarketResponse } from './markets/adapters.js'
import { extractSkillMarkdown } from './zip.js'
import { normalizeProxyUrl, requestRemoteBytes, requestRemoteText } from './network.js'

const MARKET_CACHE_MS = 5 * 60_000
const MAX_MARKET_BYTES = 1024 * 1024
const MAX_SKILL_BYTES = 512 * 1024

interface MarketCache { expiresAt: number; entries: MarketSkillEntry[] }

export class SkillService {
  private readonly cache = new Map<string, MarketCache>()
  private readonly mutations = new AsyncSemaphore(1)

  constructor(private readonly store: PartnerStore, readonly repository: SkillRepository) {}

  async initialize(): Promise<void> { await this.repository.initialize() }

  bindings(companionId: string, state: Pick<PartnerState, 'skills' | 'skillBindings'> = this.store.snapshot()): PartnerSkill[] {
    const enabled = new Set(state.skillBindings.filter(item => item.companionId === companionId && item.enabled).map(item => item.skillId))
    return state.skills.filter(item => enabled.has(item.id))
  }

  async load(skillId: string): Promise<LoadedSkill> {
    const skill = this.store.snapshot().skills.find(item => item.id === skillId)
    if (!skill) throw new Error('Skill is not installed')
    const loaded = await this.repository.read(skill)
    if (loaded.checksum !== skill.checksum) throw new Error('Skill content changed outside the installer; reinstall it before use')
    return loaded
  }

  async installLocal(document: string, id?: string): Promise<PartnerSkill> {
    return this.mutations.use(() => this.installLocalLocked(document, id))
  }

  private async installLocalLocked(document: string, id?: string): Promise<PartnerSkill> {
    const skillId = id ? requiredText(id, 'skill id', 120) : `skill-${randomUUID()}`
    this.assertInstallCapacity(skillId)
    const installed = await this.repository.install({ id: skillId, document, source: 'local', trusted: true })
    await this.store.update(state => {
      state.skills = [...state.skills.filter(item => item.id !== installed.id), installed]
    })
    return installed
  }

  async uninstall(skillId: string): Promise<void> {
    return this.mutations.use(() => this.uninstallLocked(skillId))
  }

  private async uninstallLocked(skillId: string): Promise<void> {
    const skill = this.store.snapshot().skills.find(item => item.id === skillId)
    if (!skill) throw new Error('Skill is not installed')
    await this.store.update(state => {
      state.skills = state.skills.filter(item => item.id !== skillId)
      state.skillBindings = state.skillBindings.filter(item => item.skillId !== skillId)
    })
    await this.repository.remove(skill)
  }

  async setBinding(companionId: string, skillId: string, enabled: boolean): Promise<void> {
    const state = this.store.snapshot()
    if (!state.companions.some(item => item.id === companionId)) throw new Error('Companion does not exist')
    if (!state.skills.some(item => item.id === skillId)) throw new Error('Skill is not installed')
    await this.store.update(draft => {
      draft.skillBindings = draft.skillBindings.filter(item => !(item.companionId === companionId && item.skillId === skillId))
      draft.skillBindings.push({ companionId, skillId, enabled })
    })
  }

  async addMarketSource(input: unknown): Promise<SkillMarketSource> {
    const value = input as Record<string, unknown>
    const indexUrl = validHttpUrl(requiredText(value.indexUrl, 'indexUrl', 2000))
    const now = Date.now()
    const source: SkillMarketSource = {
      id: `market-${randomUUID()}`, name: requiredText(value.name, 'name', 100), kind: 'dsh-index', indexUrl,
      enabled: optionalBoolean(value.enabled, true), trusted: optionalBoolean(value.trusted, false), createdAt: now, updatedAt: now,
    }
    await this.store.update(state => {
      if (state.skillMarketSources.length >= 20) throw new Error('Skill market source limit reached')
      state.skillMarketSources.push(source)
    })
    return source
  }

  async removeMarketSource(sourceId: string): Promise<void> {
    await this.store.update(state => {
      const source = state.skillMarketSources.find(item => item.id === sourceId)
      if (source?.builtin) throw new Error('Built-in Skill market source cannot be removed')
      state.skillMarketSources = state.skillMarketSources.filter(item => item.id !== sourceId)
    })
    this.cache.delete(sourceId)
  }

  networkSettings(): { proxyUrl?: string } {
    return this.store.snapshot().skillMarketNetwork
  }

  async setNetworkSettings(input: unknown): Promise<{ proxyUrl?: string }> {
    const value = input as Record<string, unknown>
    const proxyUrl = normalizeProxyUrl(value.proxyUrl)
    await this.store.update(state => { state.skillMarketNetwork = proxyUrl ? { proxyUrl } : {} })
    this.cache.clear()
    return this.networkSettings()
  }

  async testNetwork(input: unknown): Promise<{ ok: true; latencyMs: number; sourceCount: number; entryCount: number }> {
    const value = input as Record<string, unknown>
    const proxyUrl = normalizeProxyUrl(value.proxyUrl)
    const sources = this.store.snapshot().skillMarketSources.filter(item => item.enabled)
    const startedAt = Date.now()
    const results = await Promise.allSettled(sources.map(source => this.fetchMarket(source, proxyUrl)))
    const succeeded = results.filter((result): result is PromiseFulfilledResult<MarketSkillEntry[]> => result.status === 'fulfilled')
    if (succeeded.length === 0) {
      const reasons = results.flatMap(result => result.status === 'rejected' ? [result.reason instanceof Error ? result.reason.message : String(result.reason)] : [])
      throw new Error(`Skill 市场网络测试失败：${reasons.slice(0, 2).join('；') || '没有可用市场'}`)
    }
    return { ok: true, latencyMs: Date.now() - startedAt, sourceCount: succeeded.length, entryCount: succeeded.reduce((sum, result) => sum + result.value.length, 0) }
  }

  async market(force = false): Promise<{ sources: SkillMarketSource[]; entries: MarketSkillEntry[]; errors: Array<{ sourceId: string; error: string }> }> {
    const sources = this.store.snapshot().skillMarketSources.filter(item => item.enabled)
    const errors: Array<{ sourceId: string; error: string }> = []
    const groups = await Promise.all(sources.map(async source => {
      try { return await this.loadMarket(source, force) }
      catch (error) { errors.push({ sourceId: source.id, error: error instanceof Error ? error.message : String(error) }); return [] }
    }))
    const entries = deduplicateMarket([...BUILTIN_SKILLS.values()].map(item => item.entry).concat(groups.flat()))
    return { sources, entries, errors }
  }

  async installMarket(sourceId: string, entryId: string): Promise<PartnerSkill> {
    return this.mutations.use(() => this.installMarketLocked(sourceId, entryId))
  }

  private async installMarketLocked(sourceId: string, entryId: string): Promise<PartnerSkill> {
    this.assertInstallCapacity(entryId)
    if (sourceId === BUILTIN_SKILL_SOURCE) {
      const builtin = BUILTIN_SKILLS.get(entryId)
      if (!builtin) throw new Error('Built-in Skill does not exist')
      const installed = await this.repository.install({ id: entryId, document: builtin.document, source: 'builtin', sourceId: BUILTIN_SKILL_SOURCE, trusted: true })
      await this.store.update(state => {
        state.skills = [...state.skills.filter(item => item.id !== installed.id), installed]
      })
      return installed
    }
    const source = this.store.snapshot().skillMarketSources.find(item => item.id === sourceId && item.enabled)
    if (!source) throw new Error('Skill market source is unavailable')
    const entry = (await this.loadMarket(source, false)).find(item => item.id === entryId)
    if (!entry) throw new Error('Skill market entry does not exist')
    const proxyUrl = this.networkSettings().proxyUrl
    const document = entry.installKind === 'zip'
      ? await fetchSkillFromZip(entry.skillUrl, MAX_SKILL_BYTES, proxyUrl)
      : await fetchText(entry.skillUrl, MAX_SKILL_BYTES, undefined, proxyUrl)
    if (entry.checksum && sha256(document) !== normalizeChecksum(entry.checksum)) throw new Error('Skill checksum verification failed')
    const installed = await this.repository.install({
      id: entry.id, document, source: 'market', sourceId: source.id, trusted: source.trusted,
    })
    await this.store.update(state => {
      state.skills = [...state.skills.filter(item => item.id !== installed.id), installed]
    })
    return installed
  }

  private async loadMarket(source: SkillMarketSource, force: boolean): Promise<MarketSkillEntry[]> {
    const cached = this.cache.get(source.id)
    if (!force && cached && cached.expiresAt > Date.now()) return cached.entries
    const entries = await this.fetchMarket(source, this.networkSettings().proxyUrl)
    this.cache.set(source.id, { entries, expiresAt: Date.now() + MARKET_CACHE_MS })
    return entries
  }

  private async fetchMarket(source: SkillMarketSource, proxyUrl?: string): Promise<MarketSkillEntry[]> {
    const request = marketRequest(source)
    const raw = await fetchText(request.url, MAX_MARKET_BYTES, request.init, proxyUrl)
    return parseMarketResponse(JSON.parse(raw), source)
  }

  private assertInstallCapacity(skillId: string): void {
    const skills = this.store.snapshot().skills
    if (!skills.some(item => item.id === skillId) && skills.length >= 500) throw new Error('Installed Skill limit reached')
  }
}

export function renderEnabledSkills(companion: Companion, skills: PartnerSkill[]): string {
  if (!companion.capabilities.includes('skills') || skills.length === 0) return ''
  return [
    '以下 Skill 已绑定到当前伙伴。需要执行时调用 partner_skill；不要假装已经执行。市场 Skill 默认在隔离临时会话中运行，且只能缩小既有工具权限。',
    ...skills.map(skill => `- ${skill.id}｜${skill.displayName}｜${skill.description}｜上下文 ${skill.executionContext}`),
  ].join('\n')
}

async function fetchText(url: string, limit: number, init: RequestInit = {}, proxyUrl?: string): Promise<string> {
  const headers = new Headers(init.headers)
  if (!headers.has('accept')) headers.set('accept', 'application/json,text/markdown,text/plain')
  return requestRemoteText({
    url: validHttpUrl(url), maxBytes: limit, timeoutMs: 15_000, headers,
    ...(init.method ? { method: init.method } : {}),
    ...(typeof init.body === 'string' ? { body: init.body } : {}),
    ...(proxyUrl ? { proxyUrl } : {}),
  })
}
async function fetchSkillFromZip(url: string, limit: number, proxyUrl?: string): Promise<string> {
  const bytes = await requestRemoteBytes({
    url: validHttpUrl(url), maxBytes: 8 * 1024 * 1024, timeoutMs: 20_000,
    headers: { accept: 'application/zip,application/octet-stream' }, ...(proxyUrl ? { proxyUrl } : {}),
  })
  return extractSkillMarkdown(bytes, limit)
}
function validHttpUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only HTTP(S) market URLs are supported')
  url.username = ''; url.password = ''
  return url.toString()
}
function normalizeChecksum(value: string): string {
  const checksum = value.replace(/^sha256:/i, '').trim().toLocaleLowerCase()
  if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error('Skill checksum must be SHA-256')
  return checksum
}
function deduplicateMarket(entries: MarketSkillEntry[]): MarketSkillEntry[] {
  const seen = new Set<string>()
  return entries.filter(entry => { const key = `${entry.sourceId}:${entry.id}`; if (seen.has(key)) return false; seen.add(key); return true })
}
