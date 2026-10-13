import { concernResourcesSchema, validateConcernResources } from './concern-resources.js'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { PartnerStore } from './store.js'
import type { PartnerConcernStore } from './concern-store.js'
import { record, requiredText } from './core/validation.js'
import type { ConcernRevision } from './concern-attention.js'

/** Management stays scoped to the current companion; ids and revisions come from list. */
export function concernManagementTool(store: PartnerStore, concerns: PartnerConcernStore): ToolDefinition {
  return {
    name: 'partner_concerns',
    description: 'Autonomously maintain this companion’s ongoing watches: list, update content/priority, resolve, archive or restore. No explicit user authorization phrase is required. Use list for exact concernId and expectedUpdatedAt. priority is attention (0–1): >=.8 focus, >=.4 follow, below .4 observe; implicit watches below .18 archive. Explain each change with reason based on relevance, impact and progress, not silence alone. Explicit user watches may be archived only when resolved or expired. User-pinned/stopped controls cannot be overridden. Reuse existing watches; one-shot work belongs to the task board. Permanent deletion is UI-only.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      action: { type: 'string', enum: ['list', 'update', 'resolve', 'archive', 'restore', 'stop'] },
      resources: concernResourcesSchema,
      concernId: { type: 'string' }, expectedUpdatedAt: { type: 'integer' },
      subject: { type: 'string' }, reason: { type: 'string' }, watchQuery: { type: 'string' },
      details: { type: 'string', description: 'Optional replacement watch instructions. reason explains this adjustment only; omit details to preserve existing instructions.' },
      priority: { type: 'number', minimum: 0, maximum: 1 },
      conclusion: { type: 'string', enum: ['resolved', 'expired', 'irrelevant'] },
    }, required: ['action'] },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(raw, exec) {
      const state = store.snapshot()
      const route = state.sessions.find(s => s.sessionId === exec.agent?.session.id)
      if (!route || !state.companions.some(c => c.id === route.companionId)) throw new Error('关注管理仅用于有效的伙伴会话')
      const input = record(raw, 'arguments')
      if (input.action === 'list') return JSON.stringify(await concerns.list(route.companionId, undefined, true, 1000))
      const id = requiredText(input.concernId, 'concernId', 160)
      const entry = (await concerns.list(route.companionId, undefined, true, 1000)).find(c => c.id === id)
      if (!entry) throw new Error('当前伙伴没有此关注，请重新 list')
      if (!Number.isSafeInteger(input.expectedUpdatedAt) || input.expectedUpdatedAt !== entry.updatedAt) throw new Error('关注已变化，请 list 后使用最新 expectedUpdatedAt')
      const action = input.action === 'stop' ? 'archive' : input.action
      if (!['update', 'archive', 'resolve', 'restore'].includes(String(action))) throw new Error('关注操作无效；永久删除请在页面操作')
      return JSON.stringify(await concerns.revise(route.companionId, id, entry.updatedAt, {
        action: action as ConcernRevision['action'], reason: requiredText(input.reason, 'reason', 800),
        ...(input.resources === undefined ? {} : {resources: validateConcernResources(input.resources)}),
        ...(input.priority === undefined ? {} : { priority: input.priority as number }),
        ...(input.conclusion === undefined ? {} : { conclusion: input.conclusion as NonNullable<ConcernRevision['conclusion']> }),
        ...(input.subject === undefined ? {} : { subject: requiredText(input.subject, 'subject', 300) }),
        ...(input.details === undefined ? {} : { details: requiredText(input.details, 'details', 800) }),
        ...(input.watchQuery === undefined ? {} : { watchQuery: requiredText(input.watchQuery, 'watchQuery', 300) }),
      }))
    },
  }
}
