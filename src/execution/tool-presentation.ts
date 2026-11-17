import {runtimePolicy} from '../companions/runtime-policy.js'
import {isPartnerOwnedTool} from './tool-ownership.js'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { withActivityChoiceSchema } from '../character/activity-decision.js'
import { withTaskReviewSchema } from '../chat/task-followup.js'
import { PARTNER_TOOL_ENTRIES, isPartnerDiscoveryTool } from '../collaboration/tool-discovery.js'
import { isPartnerMcpOperation } from '../mcp/tool-entry.js'
import type { PartnerStore } from '../store.js'
import { channelToolAllowed, type ToolAccessDecision } from './tool-access-adapter.js'
import { partnerToolRevision } from './tool-ownership.js'

/** Trusted presentation modes, computed by the runtime, never accepted from model input. */
export enum ToolPresentationFlag { Discovery = 1, TerminalOnly = 2, ActivityChoice = 4, TaskReview = 8 }
export interface ToolPresentationPolicy { owner?: string | undefined; flags: number; access: ToolAccessDecision }
const terminal = new Set(['partner_chat_reply', 'partner_activity_finish'])
const entries = new Set<string>(PARTNER_TOOL_ENTRIES)
const publicEntries = new Set(['partner_tools', 'partner_channel_access', 'partner_memory_recall'])

/** Keep registrations stable. Select a bounded set of views from trusted flags.
 * Definition identity/order and ownership revision also participate: a plugin
 * unload, replacement, or host admission change cannot resurrect a cached tool.
 * Dispatch remains in the original live authorization/approval pipeline.
 */
export function createToolPresentationSelector(store: PartnerStore) {
  let definitions: readonly ToolDefinition[] = [], revision = -1
  const views = new Map<string, readonly ToolDefinition[]>()
  return (tools: readonly ToolDefinition[], policy: ToolPresentationPolicy): readonly ToolDefinition[] => {
    const currentRevision = partnerToolRevision(store)
    if (revision !== currentRevision || definitions.length !== tools.length || tools.some((tool,i)=>tool!==definitions[i])) {
      definitions = tools.slice(); revision = currentRevision; views.clear()
    }
    const {owner,flags,access} = policy
    const currentPolicy=owner?runtimePolicy(store,owner):undefined
    const key = JSON.stringify([owner,flags,access.sendTools,access.allowedTools,currentPolicy?.roleChat])
    const cached = views.get(key)
    if (cached) return cached
    const selected = tools.filter(tool => {
      if ((flags & ToolPresentationFlag.TerminalOnly) && !terminal.has(tool.name)) return false
      if (!owner) return true
      if (currentPolicy&&!currentPolicy.allowsTool(tool.name)&&isPartnerOwnedTool(store,owner,tool.name))return false
      if (isPartnerMcpOperation(store,owner,tool.name)) return false
      if ((flags & ToolPresentationFlag.Discovery) && !entries.has(tool.name) && isPartnerDiscoveryTool(store,owner,tool.name)) return false
      return publicEntries.has(tool.name) || channelToolAllowed(store,owner,tool.name,access)
    }).map(tool=>withTaskReviewSchema(withActivityChoiceSchema(tool,!!(flags & ToolPresentationFlag.ActivityChoice)),!!(flags & ToolPresentationFlag.TaskReview)))
    if (views.size >= 16) views.delete(views.keys().next().value!)
    views.set(key,selected)
    return selected
  }
}
