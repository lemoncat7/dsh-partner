import { randomUUID } from 'node:crypto'
import { appendBounded } from '../core/collections.js'
import { requiredText } from '../core/validation.js'
import type { Companion } from '../domain.js'
import type { EphemeralExecutionService } from '../execution/service.js'
import type { PartnerStore } from '../store.js'
import type { SkillService } from '../skills/service.js'
import type { TaskBoardService } from '../tasks/service.js'
import type { PartnerDelegation, PartnerDirectoryEntry } from './domain.js'

export class PartnerCollaborationService {
  constructor(
    private readonly store: PartnerStore,
    private readonly skills: SkillService,
    private readonly tasks: TaskBoardService,
    private readonly executor: EphemeralExecutionService,
  ) {}

  directory(): PartnerDirectoryEntry[] {
    const state = this.store.snapshot()
    const running = new Set(state.executionRuns.filter(item => item.status === 'running').map(item => item.ownerCompanionId))
    return state.companions.map(companion => ({
      id: companion.id, name: companion.name, role: companion.role, description: companion.description,
      capabilities: companion.capabilities, enabledSkills: this.skills.bindings(companion.id, state).map(skill => ({ id: skill.id, name: skill.displayName })),
      availability: running.has(companion.id) ? 'busy' : 'available',
    }))
  }

  resolveCompanion(reference: string): Companion {
    const normalized = reference.trim().replace(/^@/, '').toLocaleLowerCase()
    const matches = this.store.snapshot().companions.filter(item => item.id.toLocaleLowerCase() === normalized || item.name.toLocaleLowerCase() === normalized)
    if (matches.length === 0) throw new Error(`找不到伙伴 ${reference}`)
    if (matches.length > 1) throw new Error(`伙伴名称 ${reference} 不唯一，请使用伙伴 id`)
    return matches[0]!
  }

  async delegate(input: { taskId: string; fromCompanionId: string; to: string; request: string; parentSessionId?: string }): Promise<PartnerDelegation> {
    const task = this.tasks.require(input.taskId)
    const from = this.requireCompanion(input.fromCompanionId)
    if (!from.capabilities.includes('collaboration')) throw new Error(`伙伴「${from.name}」没有伙伴协作权限`)
    const to = this.resolveCompanion(input.to)
    if (from.id === to.id) throw new Error('伙伴不能把任务委派给自己')
    const request = requiredText(input.request, 'request', 8000)
    const now = Date.now()
    const delegation: PartnerDelegation = {
      id: `delegation-${randomUUID()}`, taskId: task.id, fromCompanionId: from.id, toCompanionId: to.id,
      request, status: 'queued', createdAt: now,
    }
    await this.save(delegation)
    try {
      Object.assign(delegation, { status: 'running' as const, startedAt: Date.now() })
      await this.save(delegation)
      const current = this.tasks.require(task.id)
      await this.tasks.update(task.id, { expectedRevision: current.revision, status: 'doing', assigneeCompanionId: to.id }, { kind: 'companion', companionId: from.id })
      const result = await this.executor.execute({
        kind: 'delegation', sourceId: delegation.id, companion: to,
        ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
        prompt: [
          `你收到伙伴「${from.name}」委派的看板任务。`,
          `任务：${task.title}`,
          task.description ? `任务说明：${task.description}` : '',
          `委派要求：${request}`,
          '请真正完成能够完成的工作，并在结果中清楚说明产出、证据、未完成项和需要验收的内容。不要访问其他伙伴的私有会话或记忆。',
        ].filter(Boolean).join('\n\n'),
        destroyAfterRun: true,
      })
      Object.assign(delegation, {
        status: 'completed' as const, completedAt: Date.now(), executionRunId: result.run.id,
        resultSummary: result.output.slice(0, 2400),
      })
      await this.save(delegation)
      const done = this.tasks.require(task.id)
      await this.tasks.update(task.id, { expectedRevision: done.revision, status: 'review' }, { kind: 'companion', companionId: to.id })
      await this.tasks.comment(task.id, `@${to.name} 已完成委派：\n${result.output.slice(0, 1800)}`, { kind: 'companion', companionId: to.id })
    } catch (error) {
      Object.assign(delegation, { status: 'failed' as const, completedAt: Date.now(), error: error instanceof Error ? error.message : String(error) })
      await this.save(delegation)
      const current = this.tasks.require(task.id)
      if (current.status === 'doing') await this.tasks.update(task.id, { expectedRevision: current.revision, status: 'blocked' }, { kind: 'companion', companionId: to.id }).catch(() => {})
      throw error
    }
    return delegation
  }

  private requireCompanion(id: string): Companion {
    const companion = this.store.snapshot().companions.find(item => item.id === id)
    if (!companion) throw new Error('Companion does not exist')
    return companion
  }

  private async save(value: PartnerDelegation): Promise<void> {
    await this.store.update(state => {
      state.delegations = state.delegations.filter(item => item.id !== value.id)
      appendBounded(state.delegations, structuredClone(value), 500)
    })
  }
}
