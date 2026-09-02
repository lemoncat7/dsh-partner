import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { createDefaultCompanion, DEFAULT_AUTOMATION, normalizeLegacyHeartbeatFocus, type PartnerState } from './domain.js'
import { mergeBuiltinMarketSources } from './skills/markets/builtin.js'

export class PartnerStore {
  private state: PartnerState
  private writes: Promise<void> = Promise.resolve()

  private constructor(private readonly path: string, state: PartnerState) {
    this.state = state
  }

  static async open(path: string): Promise<PartnerStore> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    let state: PartnerState
    try {
      const raw = JSON.parse(await readFile(path, 'utf8')) as unknown
      state = parseState(raw)
      if (typeof raw === 'object' && raw !== null && (raw as { schemaVersion?: unknown }).schemaVersion !== state.schemaVersion) {
        const store = new PartnerStore(path, state)
        await store.persist(state)
        return store
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      state = emptyState()
      const store = new PartnerStore(path, state)
      await store.persist(state)
      return store
    }
    return new PartnerStore(path, state)
  }

  snapshot(): PartnerState {
    return structuredClone(this.state)
  }

  async update(change: (draft: PartnerState) => void): Promise<PartnerState> {
    let resolveResult!: (value: PartnerState) => void
    let rejectResult!: (reason: unknown) => void
    const result = new Promise<PartnerState>((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
    this.writes = this.writes.then(async () => {
      const next = structuredClone(this.state)
      change(next)
      validateState(next)
      await this.persist(next)
      this.state = next
      resolveResult(this.snapshot())
    }).catch(error => { rejectResult(error) })
    return result
  }

  private async persist(state: PartnerState): Promise<void> {
    const temporary = `${this.path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    const file = await open(temporary, 'r+')
    try { await file.sync() } finally { await file.close() }
    try {
      await rename(temporary, this.path)
    } catch (error) {
      if (process.platform !== 'win32' || !replaceError(error)) throw error
      await rm(this.path, { force: true })
      await rename(temporary, this.path)
    } finally {
      await rm(temporary, { force: true }).catch(() => {})
    }
    if (process.platform !== 'win32') {
      const directory = await open(dirname(this.path), 'r')
      try { await directory.sync() } finally { await directory.close() }
    }
  }
}

function emptyState(): PartnerState {
  return {
    schemaVersion: 14,
    companions: [createDefaultCompanion()], channels: [], pairings: [], sessions: [], recentReceipts: [], heartbeatStates: [],
    skills: [], skillBindings: [], skillMarketSources: mergeBuiltinMarketSources([]), skillMarketNetwork: {}, tasks: [], taskActivities: [], delegations: [], companionAccessGrants: [], schedules: [], executionRuns: [],
  }
}

function parseState(value: unknown): PartnerState {
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && (value as { schemaVersion?: unknown }).schemaVersion === 1) {
    const legacy = value as Record<string, unknown>
    value = {
      ...legacy,
      schemaVersion: 4,
      companions: Array.isArray(legacy.companions) ? legacy.companions.map(item => ({
        ...(item as Record<string, unknown>), automation: structuredClone(DEFAULT_AUTOMATION),
      })) : legacy.companions,
      heartbeatStates: [],
    }
  } else if (typeof value === 'object' && value !== null && !Array.isArray(value) && (value as { schemaVersion?: unknown }).schemaVersion === 2) {
    const legacy = value as Record<string, unknown>
    value = {
      ...legacy,
      schemaVersion: 4,
      companions: Array.isArray(legacy.companions) ? legacy.companions.map(item => {
        const companion = item as Record<string, unknown>
        const automation = companion.automation as Record<string, unknown> | undefined
        const journal = automation?.journal as Record<string, unknown> | undefined
        return {
          ...companion,
          automation: {
            ...automation,
            journal: { ...journal, retentionDays: journal?.retentionDays === 90 ? 0 : journal?.retentionDays },
          },
        }
      }) : legacy.companions,
    }
  } else if (typeof value === 'object' && value !== null && !Array.isArray(value) && (value as { schemaVersion?: unknown }).schemaVersion === 3) {
    const legacy = value as Record<string, unknown>
    value = {
      ...legacy,
      schemaVersion: 4,
      companions: Array.isArray(legacy.companions) ? legacy.companions.map(item => {
        const companion = item as Record<string, unknown>
        const automation = companion.automation as Record<string, unknown> | undefined
        const heartbeat = automation?.heartbeat as Record<string, unknown> | undefined
        return {
          ...companion,
          automation: {
            ...automation,
            heartbeat: { ...heartbeat, dailyLimit: heartbeat?.dailyLimit === 2 ? 0 : heartbeat?.dailyLimit },
          },
        }
      }) : legacy.companions,
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && (value as { schemaVersion?: unknown }).schemaVersion === 4) {
    const legacy = value as Record<string, unknown>
    value = {
      ...legacy,
      schemaVersion: 5,
      companions: Array.isArray(legacy.companions) ? legacy.companions.map(item => {
        const companion = item as Record<string, unknown>
        const automation = companion.automation as Record<string, unknown> | undefined
        const { journal, ...rest } = automation ?? {}
        return { ...companion, automation: { ...rest, memory: journal ?? structuredClone(DEFAULT_AUTOMATION.memory) } }
      }) : legacy.companions,
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && (value as { schemaVersion?: unknown }).schemaVersion === 5) {
    value = { ...(value as Record<string, unknown>), schemaVersion: 6 }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && (value as { schemaVersion?: unknown }).schemaVersion === 6) {
    const legacy = value as Record<string, unknown>
    value = {
      ...legacy, schemaVersion: 7,
      companions: Array.isArray(legacy.companions) ? legacy.companions.map(item => {
        const companion = item as Record<string, unknown>
        const automation = companion.automation as Record<string, unknown>
        return { ...companion, automation: { ...automation, memory: { ...(automation.memory as Record<string, unknown>), dailyReviewEnabled: true, dailyReviewHour: 2 } } }
      }) : legacy.companions,
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && (value as { schemaVersion?: unknown }).schemaVersion === 7) {
    const legacy = value as Record<string, unknown>
    value = {
      ...legacy, schemaVersion: 8,
      companions: Array.isArray(legacy.companions) ? legacy.companions.map(item => {
        const companion = item as Record<string, unknown>
        const automation = companion.automation as Record<string, unknown>
        const heartbeat = automation.heartbeat as Record<string, unknown>
        return { ...companion, automation: { ...automation, heartbeat: { ...heartbeat, focus: normalizeLegacyHeartbeatFocus(heartbeat.focus) } } }
      }) : legacy.companions,
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && (value as { schemaVersion?: unknown }).schemaVersion === 8) {
    const legacy = value as Record<string, unknown>
    value = {
      ...legacy, schemaVersion: 9,
      heartbeatStates: Array.isArray(legacy.heartbeatStates) ? legacy.heartbeatStates.map(item => {
        const { focusCursor: _focusCursor, ...state } = item as Record<string, unknown>
        return state
      }) : legacy.heartbeatStates,
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && (value as { schemaVersion?: unknown }).schemaVersion === 9) {
    const legacy = value as Record<string, unknown>
    value = {
      ...legacy, schemaVersion: 10,
      companions: Array.isArray(legacy.companions) ? legacy.companions.map(item => {
        const companion = item as Record<string, unknown>
        const automation = companion.automation as Record<string, unknown>
        const heartbeat = automation.heartbeat as Record<string, unknown>
        const { focus, ...rest } = heartbeat
        const legacyFocus = normalizeLegacyHeartbeatFocus(focus)
        return { ...companion, automation: { ...automation, heartbeat: { ...rest, ...(legacyFocus ? { legacyFocus } : {}) } } }
      }) : legacy.companions,
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && (value as { schemaVersion?: unknown }).schemaVersion === 10) {
    value = {
      ...(value as Record<string, unknown>), schemaVersion: 11,
      skills: [], skillBindings: [], skillMarketSources: [], tasks: [], taskActivities: [], delegations: [], schedules: [], executionRuns: [],
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && (value as { schemaVersion?: unknown }).schemaVersion === 11) {
    const legacy = value as Record<string, unknown>
    const sources = Array.isArray(legacy.skillMarketSources) ? legacy.skillMarketSources.map(item => ({ ...(item as Record<string, unknown>), kind: 'dsh-index' })) : []
    value = {
      ...legacy,
      schemaVersion: 12,
      companions: Array.isArray(legacy.companions) ? legacy.companions.map(item => {
        const companion = item as Record<string, unknown>
        return { ...companion, capabilities: Array.isArray(companion.capabilities) ? companion.capabilities.filter(capability => capability !== 'collaboration') : [] }
      }) : legacy.companions,
      skillMarketSources: mergeBuiltinMarketSources(sources as PartnerState['skillMarketSources']),
      companionAccessGrants: [],
      delegations: Array.isArray(legacy.delegations) ? legacy.delegations.map(item => ({ initiatedBy: 'companion', ...(item as Record<string, unknown>) })) : [],
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && (value as { schemaVersion?: unknown }).schemaVersion === 12) {
    value = { ...(value as Record<string, unknown>), schemaVersion: 13, skillMarketNetwork: {} }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && (value as { schemaVersion?: unknown }).schemaVersion === 13) {
    const legacy = value as Record<string, unknown>
    value = {
      ...legacy,
      schemaVersion: 14,
      sessions: Array.isArray(legacy.sessions) ? legacy.sessions.map(item => {
        const session = item as Record<string, unknown>
        return { ...session, kind: session.kind === 'local' ? 'local' : 'channel' }
      }) : legacy.sessions,
      tasks: Array.isArray(legacy.tasks) ? legacy.tasks.map(item => {
        const task = item as Record<string, unknown>
        const { relatedTaskIds, ...rest } = task
        return { ...rest, dependencyTaskIds: Array.isArray(task.dependencyTaskIds) ? task.dependencyTaskIds : Array.isArray(relatedTaskIds) ? relatedTaskIds : [] }
      }) : legacy.tasks,
    }
  }
  validateState(value)
  return value
}

function validateState(value: unknown): asserts value is PartnerState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('partner state must be an object')
  const state = value as Partial<PartnerState>
  if (state.schemaVersion !== 14) throw new Error('unsupported partner state schema')
  for (const key of [
    'companions', 'channels', 'pairings', 'sessions', 'recentReceipts', 'heartbeatStates',
    'skills', 'skillBindings', 'skillMarketSources', 'tasks', 'taskActivities', 'delegations', 'companionAccessGrants', 'schedules', 'executionRuns',
  ] as const) {
    if (!Array.isArray(state[key])) throw new Error(`partner state ${key} must be an array`)
  }
  if (typeof state.skillMarketNetwork !== 'object' || state.skillMarketNetwork === null || Array.isArray(state.skillMarketNetwork)) throw new Error('partner state skillMarketNetwork must be an object')
  if (state.skillMarketNetwork.proxyUrl !== undefined && typeof state.skillMarketNetwork.proxyUrl !== 'string') throw new Error('partner state skillMarketNetwork.proxyUrl must be a string')
  const companionIds = new Set(state.companions!.map(companion => companion.id))
  const grantKeys = new Set<string>()
  if (state.companionAccessGrants!.length > 1000) throw new Error('partner state companionAccessGrants exceeds limit')
  for (const grant of state.companionAccessGrants!) {
    if (!companionIds.has(grant.fromCompanionId) || !companionIds.has(grant.toCompanionId)) throw new Error('partner access grant references a missing companion')
    if (grant.fromCompanionId === grant.toCompanionId) throw new Error('partner access grant cannot target itself')
    const key = `${grant.fromCompanionId}\u0000${grant.toCompanionId}`
    if (grantKeys.has(key)) throw new Error('partner access grant is duplicated')
    grantKeys.add(key)
  }
}

function replaceError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EPERM' || code === 'EACCES' || code === 'EEXIST'
}
