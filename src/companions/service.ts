import { randomBytes } from 'node:crypto'
import { DEFAULT_AUTOMATION, normalizeCompanionDraft, type Companion } from '../domain.js'
import type { PartnerStore } from '../store.js'

type SessionProvisioner = (companionId: string) => Promise<unknown>

/** Owns the atomic identity + initial local-session creation boundary. */
export class CompanionService {
  private provisionSession?: SessionProvisioner

  constructor(private readonly store: PartnerStore) {}

  setSessionProvisioner(provisioner: SessionProvisioner): void {
    this.provisionSession = provisioner
  }

  async create(value: unknown): Promise<Companion> {
    if (!this.provisionSession) throw new Error('伙伴会话服务尚未就绪')
    const draft = normalizeCompanionDraft({ ...identityRecord(value), capabilities: [] })
    const now = Date.now()
    const companion: Companion = {
      ...draft,
      id: `companion-${randomBytes(10).toString('hex')}`,
      capabilities: [],
      automation: structuredClone(DEFAULT_AUTOMATION),
      createdAt: now,
      updatedAt: now,
    }
    await this.store.update(state => { state.companions.push(companion) })
    try {
      await this.provisionSession(companion.id)
    } catch (error) {
      await this.store.update(state => {
        state.companions = state.companions.filter(item => item.id !== companion.id)
        state.sessions = state.sessions.filter(item => item.companionId !== companion.id)
      }).catch(() => {})
      throw error
    }
    return companion
  }
}

function identityRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('companion must be an object')
  const input = value as Record<string, unknown>
  return {
    name: input.name,
    role: input.role,
    description: input.description,
    instructions: input.instructions,
  }
}
