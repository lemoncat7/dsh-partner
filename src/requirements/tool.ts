import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { record, requiredText } from '../core/validation.js'
import type { RequirementService } from './service.js'
import type { TaskBoardService } from '../tasks/service.js'
import { RequirementConflictError } from './revisions.js'
import { planParameters } from './plan-schema.js'

export function requirementTool(companionId: string, service: RequirementService, tasks: TaskBoardService, dispatch?: () => Promise<void>): ToolDefinition {
  return {
    name: 'partner_requirements',
    description: 'Manage one requirement containing all tasks for a user deliverable. submit_plan atomically saves 1–40 tasks with local dependency keys, authorized executor IDs, acceptanceCriteria and optional exclusive resourceKeys. Use one stable submissionKey on retries; replay returns existing IDs, never restarts deleted work. New goals use title/description; continuation uses requirementId/expectedRevision after reopen. autoRun defaults true; completeScope defaults false and must only confirm a fully planned requirement. Keep decomposition policy in the enabled Skill. Single create plus child tasks remains supported. submit confirms the complete scope: when all children are accepted the system summarizes and archives automatically. A requirement containing only done/blocked tasks sends one stage result per changed batch even without submit. Any backlog, ready, doing, review or queued execution suppresses stage delivery. Never report individual review/rework steps. Stage delivery does NOT require archiving and permits further tasks. When the owner confirms the whole requirement is complete, finish saves a real final summary and archives if all children are done, including planning requirements. Never finish merely because work is queued or blocked. update changes the authoritative requirement and invalidates old child execution/reviews; use it for changed scope, not a comment alone. For continued work on the same user goal, list and reuse the original requirement instead of creating another per specialist phase. reopen supports submitted AND archived requirements, preserving previous archives and accepted tasks; optional title/description extends the overall scope for NEW work without invalidating old deliverables. Use update only when changing acceptance requirements for existing work. remove permanently deletes only on explicit user request and is idempotent. Use the enabled task-planning Skill for decomposition.',
    parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
      action: { type: 'string', enum: ['list', 'create', 'submit_plan', 'update', 'submit', 'reopen', 'finish', 'retry', 'remove'] },
      ...planParameters,
      requirementId: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' },
      expectedRevision: { type: 'integer', description: 'Use revision returned by create/list or a board response requirement. submit/update/reopen tolerate child creation and progress since that read, but not intervening scope/control edits or task removal. finish requires the exact snapshot reviewed. A conflict returns current content and recovery instructions: reconcile before retrying, never repeatedly list or recreate the requirement.' }, summary: { type: 'string' },
    } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    presentCall: args => ({ card: 'generic', title: `需求 · ${String((args as { action?: string }).action ?? '操作')}` }),
    async execute(raw, exec) {
      const input = record(raw, 'arguments'), action = requiredText(input.action, 'action', 20)
      const actor = { kind: 'companion' as const, companionId }
      if (action === 'list') return JSON.stringify({ requirements: service.list() })
      if (action === 'create') return JSON.stringify(await service.create(input, actor, exec.agent?.session.id))
      if (action === 'submit_plan') {
        try {
          const result = await service.submitPlan(input, actor, exec.agent?.session.id)
          let warning: string | undefined
          if (result.execution === 'submitted') try { await dispatch?.() } catch { warning = '整份计划已保存，后台将继续调度；不要重复创建' }
          return JSON.stringify({ ...result, ...(warning ? { warning } : {}) })
        } catch (error) {
          if (!(error instanceof RequirementConflictError)) throw error
          return JSON.stringify({ ok: false, code: error.code, current: error.current, recovery: error.recovery })
        }
      }
      const id = requiredText(input.requirementId, 'requirementId', 160)
      const item = service.list().find(r => r.id === id)
      if (!item) return JSON.stringify({ id, status: 'removed', message: '需求已删除或不存在，不要重建或继续旧任务' })
      if (item.ownerCompanionId !== companionId) return JSON.stringify({ ok: false, retryable: false, code: 'REQUIREMENT_OWNER_REQUIRED',
        message: '当前伙伴不是此需求负责人', current: { id: item.id, status: item.status, revision: item.revision, ownerCompanionId: item.ownerCompanionId ?? null },
        recovery: '不要重复修改需求或另建同名需求。若你是子任务执行者且缺工具、需换人或拆分，调用 partner_task_board request_replan，携带当前 taskId、expectedRevision、message；由需求负责人或用户调整后再执行。' })
      if (action === 'remove') { await tasks.removeRequirement(id); return JSON.stringify({ id, removed: true }) }
      if (action === 'retry') { await service.retry(id); return JSON.stringify({ id, retry: true }) }
      const revision = input.expectedRevision
      if (!Number.isInteger(revision)) throw new Error('请先查询需求并提供 expectedRevision')
      try {
        if (action === 'update') return JSON.stringify(await service.update(id, revision as number, input, actor))
        if (action === 'submit') return JSON.stringify(await service.submit(id, revision as number, actor))
        if (action === 'reopen') return JSON.stringify(await service.reopen(id, revision as number, actor, input))
        if (action === 'finish') return JSON.stringify(await service.finish(id, revision as number, requiredText(input.summary, 'summary', 12000), actor))
        throw new Error('需求操作无效')
      } catch (error) {
        if (!(error instanceof RequirementConflictError)) throw error
        return JSON.stringify({ ok: false, code: error.code, action, expectedRevision: error.expectedRevision,
          message: error.message, current: error.current, recovery: error.recovery })
      }
    },
  }
}
