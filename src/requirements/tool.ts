import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { record, requiredText } from '../core/validation.js'
import type { RequirementService } from './service.js'
import type { TaskBoardService } from '../tasks/service.js'

export function requirementTool(companionId: string, service: RequirementService, tasks: TaskBoardService): ToolDefinition {
  return {
    name: 'partner_requirements',
    description: 'Manage one requirement containing all tasks for a user deliverable. Create a requirement, use its id on child board tasks, then submit after the plan is fully assigned. All children must be accepted before the owner summarizes and the system archives and sends ONE final channel notification. reopen permits planning changes; finish saves an actual final summary only when all children are done. Never finish merely because tasks were submitted. remove permanently deletes a requirement and its tasks only when explicitly requested; retries of removal are idempotent. Use the enabled task-planning Skill for decomposition, not a separate workflow gate.',
    parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
      action: { type: 'string', enum: ['list', 'create', 'submit', 'reopen', 'finish', 'retry', 'remove'] },
      requirementId: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' },
      expectedRevision: { type: 'integer' }, summary: { type: 'string' },
    } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    presentCall: args => ({ card: 'generic', title: `需求 · ${String((args as { action?: string }).action ?? '操作')}` }),
    async execute(raw, exec) {
      const input = record(raw, 'arguments'), action = requiredText(input.action, 'action', 20)
      const actor = { kind: 'companion' as const, companionId }
      if (action === 'list') return JSON.stringify({ requirements: service.list() })
      if (action === 'create') return JSON.stringify(await service.create(input, actor, exec.agent?.session.id))
      const id = requiredText(input.requirementId, 'requirementId', 160)
      const item = service.list().find(r => r.id === id)
      if (!item) return JSON.stringify({ id, status: 'removed', message: '需求已删除或不存在，不要重建或继续旧任务' })
      if (item.ownerCompanionId !== companionId) throw new Error('当前伙伴不是此需求负责人')
      if (action === 'remove') { await tasks.removeRequirement(id); return JSON.stringify({ id, removed: true }) }
      if (action === 'retry') { await service.retry(id); return JSON.stringify({ id, retry: true }) }
      const revision = input.expectedRevision
      if (!Number.isInteger(revision)) throw new Error('请先查询需求并提供 expectedRevision')
      if (action === 'submit') return JSON.stringify(await service.submit(id, revision as number, actor))
      if (action === 'reopen') return JSON.stringify(await service.reopen(id, revision as number, actor))
      if (action === 'finish') return JSON.stringify(await service.finish(id, revision as number, requiredText(input.summary, 'summary', 12000), actor))
      throw new Error('需求操作无效')
    },
  }
}
