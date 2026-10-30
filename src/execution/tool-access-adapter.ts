import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { PartnerState } from '../domain.js'
import { qqToolAccessAdapter } from '../channels/qq/authority.js'

export interface ToolAccessDecision {
  /** Whether the model receives the session's already-authorized tool list. */
  sendTools: boolean
  /** Optional channel-specific allowlist for ordinary reply tools. */
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

/** Channel adapters only narrow access; they never grant new capabilities. */
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

/** The same adapter also rejects stale, hidden and nested tool dispatches. */
export function installToolAccessGuard(tools: ToolRuntime, snapshot: () => ToolAccessContext['state']): () => void {
  return tools.guard(exec => {
    if (!exec.agent) return
    const access = resolveToolAccess({ agent: exec.agent, state: snapshot() })
    if (!access.sendTools || (access.allowedTools && !access.allowedTools.includes(exec.name))) return access.denialReason ?? '当前渠道账号仅允许正常对话'
  })
}
