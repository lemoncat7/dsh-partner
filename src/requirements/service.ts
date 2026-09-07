import { randomUUID } from 'node:crypto'
import type { PartnerStore } from '../store.js'
import type { TaskActor } from '../tasks/service.js'
import { optionalText, record, requiredText } from '../core/validation.js'
import type { BoardRequirement } from './domain.js'
import type { BoardTask } from '../tasks/domain.js'

export function requirementDraft(title: string, description: string, ownerCompanionId?: string, creatorSessionId?: string): BoardRequirement {
  const now = Date.now()
  return { id: `requirement-${randomUUID()}`, title, description, status: 'planning', revision: 1, createdAt: now, updatedAt: now,
    ...(ownerCompanionId ? { ownerCompanionId } : {}), ...(creatorSessionId ? { creatorSessionId } : {}) }
}

export class RequirementService {
  constructor(private readonly store: PartnerStore) {}
  list(): BoardRequirement[] { return this.store.snapshot().requirements ?? [] }
  require(id: string): BoardRequirement {
    const item = this.list().find(item => item.id === id)
    if (!item) throw new RequirementError(404, '需求已删除或不存在，请刷新看板')
    return item
  }
  async create(value: unknown, actor: TaskActor, sessionId?: string): Promise<BoardRequirement> {
    const input = record(value, 'requirement')
    const owner = actor.companionId ?? optionalText(input.ownerCompanionId, 'ownerCompanionId', 120)
    const item = requirementDraft(requiredText(input.title, 'title', 200), optionalText(input.description, 'description', 8000) ?? '', owner, sessionId)
    await this.store.update(state => {
      if (owner && !state.companions.some(c => c.id === owner)) throw new RequirementError(400, '需求负责人不存在')
      state.requirements ??= []
      if (state.requirements.length >= 500) throw new RequirementError(400, '需求数量已达上限，请删除不再需要的归档')
      state.requirements.push(item)
    })
    return item
  }
  async submit(id: string, revision: number, actor: TaskActor): Promise<BoardRequirement> {
    return this.change(id, revision, actor, (item, tasks) => {
      if (item.status !== 'planning') throw new RequirementError(409, '该需求已经提交，请刷新查看')
      if (!tasks.length) throw new RequirementError(409, '请先安排子任务，再提交规划')
      item.status = 'active'
    })
  }
  async assignOwner(id: string, revision: number, owner: string | undefined): Promise<BoardRequirement> {
    return this.change(id, revision, { kind: 'user' }, item => {
      if (item.status === 'done') throw new RequirementError(409, '已归档需求不能更改负责人')
      if (owner && !this.store.snapshot().companions.some(c => c.id === owner)) throw new RequirementError(400, '需求负责人不存在')
      if (owner) item.ownerCompanionId = owner
      else delete item.ownerCompanionId
      if (item.status === 'review') item.status = 'active'
      delete item.lastError; delete item.nextAttemptAt
    })
  }
  async reopen(id: string, revision: number, actor: TaskActor): Promise<BoardRequirement> {
    return this.change(id, revision, actor, item => {
      if (item.status === 'done') throw new RequirementError(409, '已归档需求不能重开，请创建后续需求')
      item.status = 'planning'; delete item.lastError; delete item.nextAttemptAt
    })
  }
  async finish(id: string, revision: number, summary: string, actor: TaskActor): Promise<BoardRequirement> {
    const text = requiredText(summary, 'summary', 12000)
    return this.change(id, revision, actor, (item, tasks) => {
      if (!['active', 'review'].includes(item.status) || !tasks.length || tasks.some(t => t.status !== 'done')) throw new RequirementError(409, '需求尚未提交或仍有未验收任务，不能完成归档')
      item.summary = text; item.status = 'done'; item.archivedAt = Date.now()
      item.results = tasks.map(({ id, title, assigneeCompanionId, resultSummary, resultAbstract }) => ({ id, title, ...(assigneeCompanionId ? { assigneeCompanionId } : {}), ...(resultSummary ? { resultSummary } : {}), ...(resultAbstract ? { resultAbstract } : {}) }))
      delete item.lastError; delete item.nextAttemptAt
    })
  }
  async retry(id: string): Promise<void> {
    await this.store.update(state => {
      const item = state.requirements?.find(r => r.id === id)
      if (!item) throw new RequirementError(404, '需求已删除或不存在')
      delete item.nextAttemptAt; delete item.lastError
    })
  }
  private async change(id: string, revision: number, actor: TaskActor, change: (item: BoardRequirement, tasks: BoardTask[]) => void): Promise<BoardRequirement> {
    let result!: BoardRequirement
    await this.store.update(state => {
      const item = state.requirements?.find(r => r.id === id)
      if (!item) throw new RequirementError(404, '需求已删除或不存在，请刷新看板')
      if (actor.kind !== 'user' && item.ownerCompanionId !== actor.companionId) throw new RequirementError(403, '只有需求负责人可以提交、调整或完成需求')
      if (revision !== item.revision) throw new RequirementError(409, '需求内容已更新，请刷新后重试')
      change(item, state.tasks.filter(t => t.requirementId === id))
      item.revision++; item.updatedAt = Date.now(); result = structuredClone(item)
    })
    return result
  }
}
export class RequirementError extends Error { constructor(readonly status: number, message: string) { super(message) } }
