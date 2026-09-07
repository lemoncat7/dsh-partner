import { randomUUID } from 'node:crypto'
import type { PartnerState } from '../domain.js'
import type { BoardTask } from '../tasks/domain.js'
import { delegationKind, delegationPending, type PartnerDelegation } from './domain.js'

/** Pure checks shared by automatic submission and explicit delegation. */
export function taskDependenciesDone(task: BoardTask, tasks: readonly BoardTask[]): boolean {
  const done = new Set(tasks.filter(item => item.status === 'done').map(item => item.id))
  return task.dependencyTaskIds.every(id => done.has(id))
}

export function taskDispatchDenied(state: PartnerState, item: PartnerDelegation): string | undefined {
  if (!state.companions.some(companion => companion.id === item.toCompanionId)) return '执行伙伴已不存在'
  if (item.initiatedBy === 'companion') {
    if (!state.companions.some(companion => companion.id === item.fromCompanionId)) return '创建伙伴已不存在'
    if (item.fromCompanionId !== item.toCompanionId && !state.companionAccessGrants.some(grant => grant.fromCompanionId === item.fromCompanionId && grant.toCompanionId === item.toCompanionId)) return '伙伴协作授权已撤回，未启动任务'
  }
  return undefined
}

export function autoRunCandidates(state: PartnerState): BoardTask[] {
  const pending = new Set(state.delegations.filter(delegationPending).map(item => item.taskId))
  return state.tasks.filter(task => task.autoRun === true && task.status === 'ready' && task.assigneeCompanionId && !pending.has(task.id))
}

export function taskDelegation(task: BoardTask, input: { initiatedBy: 'user' | 'companion'; fromCompanionId?: string; to: string; request: string; parentSessionId?: string }): PartnerDelegation {
  return {
    id: `delegation-${randomUUID()}`, kind: 'task', taskId: task.id, initiatedBy: input.initiatedBy,
    ...(input.fromCompanionId ? { fromCompanionId: input.fromCompanionId } : {}), toCompanionId: input.to,
    request: input.request, status: 'queued', attempts: 0, nextAttemptAt: Date.now(),
    ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}), createdAt: Date.now(),
  }
}

/** Never evict queued/running work to make room for new requests. */
export function appendDelegation(state: PartnerState, item: PartnerDelegation): void {
  if (state.delegations.length >= 500) {
    const index = state.delegations.findIndex(value => !delegationPending(value))
    if (index < 0) throw new Error('执行队列已满，请等待已有任务完成')
    state.delegations.splice(index, 1)
  }
  state.delegations.push(item)
}

export function pendingTaskDelegation(state: PartnerState, taskId: string): PartnerDelegation | undefined {
  return state.delegations.find(item => item.taskId === taskId && delegationKind(item) === 'task' && delegationPending(item))
}
