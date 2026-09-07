import type { ChannelSession, Companion, PartnerState } from '../domain.js'
import type { PartnerStore } from '../store.js'

/** Read-only configuration index. No session wakeups, polling or transcript copies. */
export class SessionConfigurationIndex {
  private state: PartnerState
  private routes = new Map<string, ChannelSession>()
  private companions = new Map<string, Companion>()
  private readonly unsubscribe: () => void

  constructor(store: PartnerStore) {
    this.state = store.snapshot()
    this.index()
    this.unsubscribe = store.subscribe(next => { this.state = next; this.index() }, () => {})
  }

  private index(): void {
    this.routes = new Map(this.state.sessions.map(route => [route.sessionId, route]))
    this.companions = new Map(this.state.companions.map(companion => [companion.id, companion]))
  }

  forSession(sessionId: string): { route: ChannelSession; companion: Companion; revision: string } | undefined {
    const route = this.routes.get(sessionId)
    const companion = route && this.companions.get(route.companionId)
    if (!route || !companion) return undefined
    const { id, name, role, description, instructions, capabilities } = companion
    const bindings = this.state.skillBindings.filter(item => item.companionId === id && item.enabled)
    const grants = this.state.companionAccessGrants.filter(item => item.fromCompanionId === id)
    const revision = JSON.stringify([
      { id, name, role, description, instructions, capabilities },
      bindings, this.state.skills.filter(skill => bindings.some(binding => binding.skillId === skill.id)),
      grants, grants.map(grant => this.companions.get(grant.toCompanionId)).map(target => target && ({
        id: target.id, name: target.name, role: target.role, capabilities: target.capabilities,
        skills: this.state.skillBindings.filter(binding => binding.companionId === target.id && binding.enabled)
          .map(binding => this.state.skills.find(skill => skill.id === binding.skillId)),
      })),
    ])
    return { route, companion, revision }
  }

  companion(id: string): Companion | undefined { return this.companions.get(id) }
  close(): void { this.unsubscribe(); this.routes.clear(); this.companions.clear() }
}
