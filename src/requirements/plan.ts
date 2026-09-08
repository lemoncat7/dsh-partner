import { createHash, randomUUID } from 'node:crypto'
import type { PartnerStore } from '../store.js'
import type { TaskActor } from '../tasks/service.js'
import type { BoardTask } from '../tasks/domain.js'
import { record, requiredText, optionalText, optionalBoolean, stringList } from '../core/validation.js'
import { taskDraft, assertTaskDependencies } from '../tasks/draft.js'
import { requirementDraft } from './draft.js'
import { advanceRequirementRevision, assertRequirementRevision } from './revisions.js'
import type { BoardRequirement } from './domain.js'
import { appendBounded } from '../core/collections.js'

export interface PlanReceipt { actor: string; key: string; digest: string; requirementId: string; tasks: Array<{ key: string; id: string }>; createdAt: number }
export interface PlanResult { replayed: boolean; requirement?: BoardRequirement; requirementId: string; tasks: Array<{ key: string; id: string; task?: BoardTask; removed: boolean }>; execution: 'submitted' | 'planning-only' | 'removed' | 'unchanged' }

/** One metadata transaction. No nested service writes or network/agent execution. */
export async function submitRequirementPlan(store: PartnerStore, value: unknown, actor: TaskActor, sessionId?: string): Promise<PlanResult> {
  const input = record(value, 'plan')
  const key = requiredText(input.submissionKey, 'submissionKey', 120)
  const requirementId = optionalText(input.requirementId, 'requirementId', 160)
  const title = requirementId ? undefined : requiredText(input.title, 'title', 200)
  const description = requirementId ? undefined : planDescription(input.description) ?? ''
  const autoRun = optionalBoolean(input.autoRun, true), completeScope = optionalBoolean(input.completeScope, false)
  if (requirementId && !Number.isInteger(input.expectedRevision)) throw new Error('追加计划需要读取原需求并提供 expectedRevision')
  if (requirementId && (input.title !== undefined || input.description !== undefined)) throw new Error('追加计划不能隐式改写原需求，请先 update/reopen')
  if (!Array.isArray(input.tasks) || !input.tasks.length || input.tasks.length > 40) throw new Error('整份计划需要 1–40 项任务')
  const items = input.tasks.map(raw => {
    const item = record(raw, 'plan task')
    const fields = new Set(['key', 'title', 'description', 'assigneeCompanionId', 'reviewerCompanionId', 'dependsOn', 'dependencyTaskIds', 'skillIds', 'acceptanceCriteria', 'resourceKeys', 'priority'])
    for (const name of Object.keys(item)) if (!fields.has(name)) throw new Error(`计划任务字段不支持：${name}`)
    return { ...item, title: requiredText(item.title, 'task title', 200), description: planDescription(item.description), key: requiredText(item.key, 'task key', 80),
      assigneeCompanionId: requiredText(item.assigneeCompanionId, 'assigneeCompanionId', 120),
      dependsOn: stringList(item.dependsOn, 'dependsOn', 20, 80), dependencyTaskIds: stringList(item.dependencyTaskIds, 'dependencyTaskIds', 20, 120) }
  })
  if (new Set(items.map(item => item.key)).size !== items.length) throw new Error('计划内任务 key 不能重复')
  const owner = actor.companionId ?? optionalText(input.ownerCompanionId, 'ownerCompanionId', 120)
  const digest = createHash('sha256').update(canonical({ requirementId, title, description, owner, autoRun, completeScope, items })).digest('hex')
  const actorKey = actor.companionId ? `companion:${actor.companionId}` : actor.kind
  let result!: PlanResult
  await store.update(state => {
    if (actor.companionId && (!state.companions.some(c => c.id === actor.companionId) || store.isCompanionRemoving(actor.companionId))) throw new Error('创建伙伴已不存在或正在删除')
    const previous = state.planReceipts?.find(r => r.actor === actorKey && r.key === key)
    if (previous) {
      if (previous.digest !== digest) throw new Error('submissionKey 已用于不同计划；不要用原 key 修改范围，请先读取原需求')
      result = planResult(previous, state, true, autoRun); return
    }
    if ((state.planReceipts?.length ?? 0) >= 2000) throw new Error('计划提交回执已达安全上限；请先处理历史回执，不会自动遗忘幂等键')
    if (state.tasks.length + items.length > 500) throw new Error('任务看板容量不足，整份计划未保存')
    if (owner && (!state.companions.some(c => c.id === owner) || store.isCompanionRemoving(owner))) throw new Error('需求负责人不存在或正在删除')
    state.requirements ??= []
    const requirement = requirementId ? state.requirements.find(r => r.id === requirementId) : requirementDraft(title!, description!, owner, sessionId)
    if (!requirement) throw new Error('原需求已删除，不会自动重建')
    if (requirementId) {
      if (actor.kind !== 'user' && requirement.ownerCompanionId !== actor.companionId) throw new Error('只有需求负责人可以提交计划')
      assertRequirementRevision(requirement, input.expectedRevision as number)
      if (requirement.status !== 'planning') throw new Error('追加计划前请由负责人 reopen 原需求，保留旧交付')
    } else if (state.requirements.length >= 500) throw new Error('需求数量已达上限')
    const drafts = items.map(item => {
      const task = taskDraft({ ...item, autoRun, creatorSessionId: sessionId }, actor, state)
      task.requirementId = requirement.id
      for (const target of [task.assigneeCompanionId, task.reviewerCompanionId]) {
        if (target && store.isCompanionRemoving(target)) throw new Error('目标伙伴正在删除')
        if (target && actor.kind !== 'user' && target !== actor.companionId && !state.companionAccessGrants.some(g => g.fromCompanionId === actor.companionId && g.toCompanionId === target)) throw new Error(`无权委派或指定验收伙伴：${target}`)
      }
      for (const skillId of task.skillIds) if (!state.companions.find(c => c.id === task.assigneeCompanionId)?.capabilities.includes('skills') || !state.skills.some(s => s.id === skillId) || !state.skillBindings.some(b => b.companionId === task.assigneeCompanionId && b.skillId === skillId && b.enabled)) throw new Error(`执行伙伴未启用 Skill：${skillId}`)
      return task
    })
    const keyed = new Map(items.map((item, index) => [item.key, drafts[index]!]))
    drafts.forEach((task, index) => {
      const item = items[index]!
      for (const id of item.dependencyTaskIds) if (!state.tasks.some(t => t.id === id && t.requirementId === requirement.id)) throw new Error(`前置任务不属于原需求或已删除：${id}`)
      task.dependencyTaskIds = [...new Set([...item.dependencyTaskIds, ...item.dependsOn.map(key => {
        const dependency = keyed.get(key)
        if (!dependency) throw new Error(`计划内前置 key 不存在：${key}`)
        return dependency.id
      })])]
      if (task.dependencyTaskIds.length > 20) throw new Error('单项任务依赖最多 20 项')
    })
    const allTasks = [...state.tasks, ...drafts]
    for (const task of drafts) assertTaskDependencies(task.id, task.dependencyTaskIds, allTasks)
    // All validation precedes insertion; listeners only see the entire plan.
    if (!requirementId) state.requirements.push(requirement)
    state.tasks.push(...drafts)
    for (const task of drafts) appendBounded(state.taskActivities, { id: `activity-${randomUUID()}`, taskId: task.id, actor: actor.kind,
      ...(actor.companionId ? { actorCompanionId: actor.companionId } : {}), kind: 'created', message: `整份计划创建：${task.title}`, at: task.createdAt }, 2000)
    if (completeScope) requirement.status = 'active'
    advanceRequirementRevision(requirement, true)
    const receipt: PlanReceipt = { actor: actorKey, key, digest, requirementId: requirement.id, tasks: items.map((item, index) => ({ key: item.key, id: drafts[index]!.id })), createdAt: Date.now() }
    ;(state.planReceipts ??= []).push(receipt)
    result = planResult(receipt, state, false, autoRun)
  })
  return result
}

function planResult(receipt: PlanReceipt, state: import('../domain.js').PartnerState, replayed: boolean, autoRun: boolean): PlanResult {
  const requirement = state.requirements?.find(r => r.id === receipt.requirementId)
  const tasks = receipt.tasks.map(({ key, id }) => { const task = state.tasks.find(t => t.id === id); return { key, id, ...(task ? { task: structuredClone(task) } : {}), removed: !task } })
  return { replayed, requirementId: receipt.requirementId, ...(requirement ? { requirement: structuredClone(requirement) } : {}), tasks,
    execution: !requirement || tasks.some(t => t.removed) ? 'removed' : replayed ? 'unchanged' : autoRun ? 'submitted' : 'planning-only' }
}
function planDescription(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || value.trim().length > 8000) throw new Error('description 必须是最多 8000 字符的文本')
  return value.trim() || undefined
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
