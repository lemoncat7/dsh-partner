import type { PartnerStore } from './store.js'
import type { PartnerAgentRuntime } from './agent-runtime.js'

/** Optional archival catch-up; disabled startup must not open old sessions. */
export async function recoverStartupConversationMemory(
  enabled: boolean,
  store: Pick<PartnerStore, 'snapshot'>,
  agents: Pick<PartnerAgentRuntime, 'recoverConversationMemory'>,
): Promise<void> {
  if (!enabled) return
  for (const companion of store.snapshot(['companions']).companions) {
    await agents.recoverConversationMemory(companion.id)
  }
}
