import {runtimePolicy,type CompanionRuntimePolicy} from '../companions/runtime-policy.js'
import {isPartnerOwnedTool} from './tool-ownership.js'
import type {PartnerStore} from '../store.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { PartnerState } from '../domain.js'
import { qqToolAccessAdapter } from '../channels/qq/authority.js'

export interface ToolAccessDecision {
  /** Whether this channel may use partner-owned tools; external tools keep host policy. */
  sendTools: boolean
  /** Optional allowlist for partner-owned tools only. */
  allowedTools?: readonly string[]
  denialReason?: string
}
export interface ToolAccessContext {
  agent: Pick<Agent, 'session'>
  state: Pick<PartnerState, 'sessions' | 'channels'>
  /** Host-admitted input during prompt preparation only; dispatch uses persisted events. */
  events?: readonly SessionEvent[]
}
export interface ToolAccessAdapter {
  resolve(context: ToolAccessContext): ToolAccessDecision | undefined
}

/** Channel adapters narrow partner capabilities only; they never grant host capabilities. */
export const defaultToolAccessAdapter: ToolAccessAdapter = {
  resolve: () => ({ sendTools: true }),
}
const channelAdapters: readonly ToolAccessAdapter[] = [qqToolAccessAdapter]

export function resolveToolAccess(context: ToolAccessContext): ToolAccessDecision {
  for (const adapter of channelAdapters) {
    const decision = adapter.resolve(context)
    if (decision) return decision
  }
  return defaultToolAccessAdapter.resolve(context)!
}

/** Apply the channel decision only to tools registered by this plugin. */
export function channelToolAllowed(store: object, owner: string, name: string, access: ToolAccessDecision): boolean {
  return !isPartnerOwnedTool(store, owner, name) || access.sendTools && (!('runtimePolicy' in store)||!!runtimePolicy(store as PartnerStore,owner)?.allowsTool(name)) && (!access.allowedTools || access.allowedTools.includes(name))
}

/** Stale and nested partner calls still receive the same live channel check. */
interface LiveToolAccessIndex {
  runtimePolicy?(owner:string):CompanionRuntimePolicy|undefined
  routesForSession(sessionId: string): readonly {companionId:string}[]
  toolAccess(agent: Pick<Agent, 'session'>): ToolAccessDecision
}
export function installToolAccessGuard(tools: ToolRuntime, store: Pick<PartnerStore, 'snapshot'>, index?: LiveToolAccessIndex): () => void {
  return tools.guard(exec => {
    if (!exec.agent) return
    const state = index ? undefined : store.snapshot()
    const routes = index ? index.routesForSession(exec.agent.session.id) : state!.sessions.filter(route => route.sessionId === exec.agent!.session.id)
    const owners = new Set(routes.map(route => route.companionId))
    if (![...owners].some(owner => isPartnerOwnedTool(store, owner, exec.name))) return
    if([...owners].some(owner=>isPartnerOwnedTool(store,owner,exec.name)&&!(index?.runtimePolicy?.(owner)??runtimePolicy(store,owner))?.allowsTool(exec.name)))return '当前生效策略未开放此角色聊天功能'
    const access = index ? index.toolAccess(exec.agent) : resolveToolAccess({ agent: exec.agent, state: state! })
    if (!access.sendTools || (access.allowedTools && !access.allowedTools.includes(exec.name))) return access.denialReason ?? '当前渠道账号不能使用此伙伴能力'
  })
}
