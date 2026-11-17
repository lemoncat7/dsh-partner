import {runtimeState,runtimePolicy} from './runtime-policy.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { resolveToolAccess } from '../execution/tool-access-adapter.js'
import { activityDecisionAvailable } from '../character/activity-decision.js'
import { taskFollowup } from '../chat/task-followup.js'
import { activityPolicyCurrent } from '../character/post-reply.js'
import type { ChannelSession, Companion, PartnerState } from '../domain.js'
import type { PartnerStore } from '../store.js'

/** Read-only configuration index. No session wakeups, polling or transcript copies. */
export class SessionConfigurationIndex {
  private state: PartnerState
  private routes = new Map<string, ChannelSession>()
  private companions = new Map<string, Companion>()
  private readonly revisions = new Map<string, string>()
  private sessionRoutes = new Map<string, ChannelSession[]>()
  private readonly unsubscribe: () => void

  constructor(private readonly store: PartnerStore) {
    this.state = runtimeState(store.snapshot(),id=>runtimePolicy(store,id))
    this.index()
    this.unsubscribe = store.subscribe(next => { this.state = runtimeState(next,id=>runtimePolicy(store,id)); this.index() }, () => {})
  }

  private index(): void {
    this.revisions.clear()
    this.sessionRoutes = new Map()
    for (const route of this.state.sessions) {
      const routes = this.sessionRoutes.get(route.sessionId) ?? []
      routes.push(route); this.sessionRoutes.set(route.sessionId, routes)
    }
    this.routes = new Map(this.state.sessions.map(route => [route.sessionId, route]))
    this.companions = new Map(this.state.companions.map(companion => [companion.id, companion]))
  }

  forSession(sessionId: string): { route: ChannelSession; companion: Companion; revision: string } | undefined {
    const route = this.routes.get(sessionId)
    const companion = route && this.companions.get(route.companionId)
    if (!route || !companion) return undefined
    const cached = this.revisions.get(companion.id)
    if (cached !== undefined) return { route, companion, revision: cached }
    const { id, name, role, description, instructions, relationshipText, characterCard, capabilities, sleepPolicy, toolDiscovery } = companion
    const bindings = this.state.skillBindings.filter(item => item.companionId === id && item.enabled)
    const grants = this.state.companionAccessGrants.filter(item => item.fromCompanionId === id)
    const mcpBindings = this.state.mcpBindings?.filter(item => item.companionId === id) ?? []
    const revision = JSON.stringify([
      { id, name, role, description, instructions, relationshipText, characterCard, capabilities, sleepPolicy, toolDiscovery },
      companion.automation?.memory,
      mcpBindings, (this.state.mcpServers ?? []).filter(server => mcpBindings.some(binding => binding.serverId === server.id)).map(server => ({ id: server.id, revision: server.revision, enabled: server.enabled })),
      bindings, this.state.skills.filter(skill => bindings.some(binding => binding.skillId === skill.id)),
      grants, grants.map(grant => this.companions.get(grant.toCompanionId)).map(target => target && ({
        id: target.id, name: target.name, role: target.role, description: target.description, capabilities: target.capabilities,
        skills: this.state.skillBindings.filter(binding => binding.companionId === target.id && binding.enabled)
          .map(binding => this.state.skills.find(skill => skill.id === binding.skillId)),
      })),
    ])
    this.revisions.set(companion.id, revision)
    return { route, companion, revision }
  }

  runtimePolicy(owner:string){return runtimePolicy(this.store,owner)}

  // Internal read projections use the committed index; no task/receipt clones.
  // Every invocation sees the latest saved state and the caller's admitted input.
  toolAccess(agent: Pick<Agent, 'session'>, events?: readonly SessionEvent[]) {
    return resolveToolAccess({agent, state:this.state, ...(events ? {events} : {})})
  }
  toolPresentation(agent: Pick<Agent, 'session'>, events: readonly SessionEvent[]) {
    const current = this.forSession(agent.session.id)
    return {current, access:this.toolAccess(agent, events),
      decisionRequired:!!current?.companion.characterCard?.enabled && activityDecisionAvailable(this.state,current.companion,agent.session.id,events),
      followup:current?.companion.characterCard?.enabled ? taskFollowup(this.state,current.companion.id,agent.session.id,events) : undefined}
  }
  routesForSession(sessionId: string): readonly ChannelSession[] { return this.sessionRoutes.get(sessionId) ?? [] }
  activityCurrent(companion: Companion, route: ChannelSession): boolean { return activityPolicyCurrent(this.state,companion,route) }
  companion(id: string): Companion | undefined { return this.companions.get(id) }
  close(): void { this.unsubscribe(); this.routes.clear(); this.companions.clear(); this.revisions.clear(); this.sessionRoutes.clear() }
}
