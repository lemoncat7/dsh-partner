import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { PartnerStore } from './store.js'
import type { PartnerConcernStore } from './concern-store.js'
import { record, requiredText } from './core/validation.js'

/** Management stays scoped to the current companion; ids and revisions come from list. */
export function concernManagementTool(store: PartnerStore, concerns: PartnerConcernStore): ToolDefinition {
  return {
    name: 'partner_concerns',
    description: 'List, update, resolve, stop or delete this companion’s ongoing watches. Use list first for exact concernId and expectedUpdatedAt; never guess a target. User requests to change/stop watching use this tool, not a new suggestion or a schedule. Resolve verified completed matters; delete only when the user requests removal. One-shot work belongs to the task board, not ongoing watches.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      action: { type: 'string', enum: ['list', 'update', 'resolve', 'stop', 'delete'] },
      concernId: { type: 'string' }, expectedUpdatedAt: { type: 'integer' },
      subject: { type: 'string' }, reason: { type: 'string' }, watchQuery: { type: 'string' },
    }, required: ['action'] },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(raw, exec) {
      const state = store.snapshot()
      const route = state.sessions.find(s => s.sessionId === exec.agent?.session.id)
      if (!route || !state.companions.find(c => c.id === route.companionId)?.automation.memory.enabled) throw new Error('当前伙伴记忆未启用')
      const input = record(raw, 'arguments')
      if (input.action === 'list') return JSON.stringify(await concerns.list(route.companionId, undefined, true, 1000))
      const id = requiredText(input.concernId, 'concernId', 160)
      const entry = (await concerns.list(route.companionId, undefined, true, 1000)).find(c => c.id === id)
      if (!entry) throw new Error('当前伙伴没有此关注，请重新 list')
      if (!Number.isSafeInteger(input.expectedUpdatedAt) || input.expectedUpdatedAt !== entry.updatedAt) throw new Error('关注已变化，请 list 后使用最新 expectedUpdatedAt')
      if (input.action === 'update') return JSON.stringify(await concerns.editExplicit(route.companionId, id, {
        subject: input.subject === undefined ? entry.subject : requiredText(input.subject, 'subject', 300),
        reason: input.reason === undefined ? entry.reason : requiredText(input.reason, 'reason', 800),
        sources: entry.resources.map(r => r.kind === 'knowledge' ? `@知识库[${r.locator}]` : `@"${r.locator}"`).join(' '),
        expectedUpdatedAt: entry.updatedAt, recordTarget: entry.recordTarget,
        watchKind: entry.watchKind, watchQuery: input.watchQuery === undefined ? entry.watchQuery : requiredText(input.watchQuery, 'watchQuery', 300),
      }))
      if (input.action === 'delete') await concerns.remove(route.companionId, id, entry.updatedAt)
      else if (input.action === 'resolve' || input.action === 'stop') await concerns.act(route.companionId, id, input.action === 'resolve' ? 'resolve' : 'ignore', Date.now(), entry.updatedAt)
      else throw new Error('关注操作无效')
      return JSON.stringify({ concernId: id, action: input.action, ok: true })
    },
  }
}
