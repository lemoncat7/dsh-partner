import type { PartnerState } from '../domain.js'
import type { BoardTask } from './domain.js'
import { delegationPending, type PartnerDelegation } from '../collaboration/domain.js'
import { taskDispatchDenied } from '../collaboration/task-dispatch.js'

export const BOARD_CONCURRENCY = 3
export interface TaskScheduling { code: string; message: string; taskIds?: string[]; resourceKeys?: string[]; retryAt?: number }

/** The same resource predicate is used at claim time and in read-only UI status. */
export function executionWait(state: PartnerState, task: BoardTask, liveClaims: readonly PartnerDelegation[] = []): TaskScheduling | undefined {
  const running = [...new Map([...state.delegations.filter(d => d.status === 'running'), ...liveClaims].map(d => [d.id, d])).values()]
  const keys = new Set(task.resourceKeys ?? [])
  const conflicts = running.filter(d => (d.resourceKeys ?? state.tasks.find(t => t.id === d.taskId)?.resourceKeys ?? []).some(k => keys.has(k)))
  const manual = state.tasks.filter(t => t.id !== task.id && t.status === 'doing' && t.resourceKeys?.some(k => keys.has(k)))
  if (conflicts.length || manual.length) return { code: 'resource_busy', message: '等待共享资源释放', taskIds: [...new Set([...conflicts.map(d => d.taskId), ...manual.map(t => t.id)])], resourceKeys: [...keys] }
  if (running.length >= BOARD_CONCURRENCY) return { code: 'capacity', message: '等待执行空位' }
  return undefined
}

export function taskScheduling(state: PartnerState, task: BoardTask, liveClaims?: readonly PartnerDelegation[]): TaskScheduling {
  if (task.status === 'done') return { code: 'done', message: '已完成' }
  if (task.replanRequested) return { code: 'replan', message: '等待需求负责人重新规划' }
  if (task.status === 'blocked') return { code: 'blocked', message: task.resultSummary?.slice(0, 200) || '执行受阻，需要处理' }
  const job = state.delegations.find(d => d.taskId === task.id && delegationPending(d))
  if (job?.status === 'running') return { code: 'running', message: job.kind === 'review' ? '正在验收' : '正在执行' }
  if (task.status === 'review' && !job) return { code: 'review', message: task.reviewerCompanionId ? '等待验收伙伴核验' : '等待人工验收' }
  if (!task.assigneeCompanionId) return { code: 'unassigned', message: '尚未指定执行伙伴' }
  if (!job && !task.autoRun && task.status !== 'doing') return { code: 'planning', message: '仅保存规划，尚未提交执行' }
  const pending = task.dependencyTaskIds.filter(id => state.tasks.find(t => t.id === id)?.status !== 'done')
  if (pending.length && task.status !== 'review') return { code: 'dependencies', message: `等待 ${pending.length} 项前置任务通过验收`, taskIds: pending }
  const target = job?.toCompanionId ?? task.assigneeCompanionId
  const probe: PartnerDelegation = job ?? { id: '', taskId: task.id, initiatedBy: task.creatorCompanionId ? 'companion' : 'user', ...(task.creatorCompanionId ? { fromCompanionId: task.creatorCompanionId } : {}), toCompanionId: target, status: 'queued', request: '', createdAt: 0 }
  const denied = taskDispatchDenied(state, probe)
  if (denied) return { code: 'permission', message: denied }
  if (job?.nextAttemptAt && job.nextAttemptAt > Date.now()) return { code: 'retry', message: '暂时失败，等待自动重试', retryAt: job.nextAttemptAt }
  if (task.status === 'doing') return { code: 'running', message: '正在执行或等待中断恢复' }
  return executionWait(state, task, liveClaims) ?? { code: 'queued', message: '已提交，等待调度' }
}
