import type { PartnerState } from '../domain.js'
import type { BoardTask } from './domain.js'

export function preserveTaskAttempt(task: BoardTask): void {
  if (!task.resultSummary && !task.reviewSummary && !task.reviewHandoff) return
  task.previousAttempt = {
    ...(task.resultSummary ? { resultSummary: task.resultSummary } : {}),
    ...(task.reviewSummary ? { reviewSummary: task.reviewSummary } : {}),
    ...(task.reviewHandoff ? { reviewHandoff: task.reviewHandoff } : {}),
  }
}

/** Supersede queued/running work atomically; the runtime observes cancellation. */
export function invalidateTaskWork(state: PartnerState, task: BoardTask, reason: string): void {
  preserveTaskAttempt(task)
  task.workRevision = (task.workRevision ?? 1) + 1
  if (['doing', 'review', 'done'].includes(task.status)) task.status = 'ready'
  delete task.resultSummary; delete task.resultAbstract; delete task.reviewSummary; delete task.reviewHandoff; delete task.completedAt
  for (const job of state.delegations) {
    if (job.taskId !== task.id || !['running', 'queued'].includes(job.status)) continue
    job.status = 'canceled'; job.error = reason; job.completedAt = Date.now(); delete job.nextAttemptAt
  }
}

/** One bounded context for executors, reviewers and creator callbacks. */
export function taskWorkContext(state: PartnerState, task: BoardTask): string {
  const requirement = state.requirements?.find(r => r.id === task.requirementId)
  const activities = state.taskActivities.filter(a => a.taskId === task.id)
  const comments = activities.filter(a => a.kind === 'commented').slice(-12)
  const legacyRejection = activities.filter(a => a.kind === 'reopened' && a.message.startsWith('验收打回：')).at(-1)?.message
  return [
    `任务 ID：${task.id}；任务版本 expectedRevision=${task.revision}；工作版本=${task.workRevision ?? 1}。验收必须针对所读取的此版本；版本变化后重新核验，不得只刷新版本号继续提交旧结论。`,
    requirement ? `所属需求（最新）：${requirement.title}\n${requirement.description}` : '',
    requirement ? `需求 ID：${requirement.id}；状态：${requirement.status}；需求负责人：${requirement.ownerCompanionId ?? '未指定（由用户处理）'}；需求 expectedRevision=${requirement.revision}。任务执行者不等于需求负责人，只有负责人可 reopen 后追加任务。` : '',
    `当前执行者：${task.assigneeCompanionId ?? '未分配'}；连续打回：${task.reworkCount ?? 0}；等待重规划：${Boolean(task.replanRequested)}。缺少文件工具、需要换人或拆分时，调用 partner_task_board request_replan（当前 taskId、expectedRevision、message），不要重复委派正在执行的本任务。`,
    `当前任务：${task.title}\n${task.description}`,
    comments.length ? `最近任务补充/讨论（按时间顺序；进度讨论不自动扩大范围，较新的明确要求优先）：\n${comments.map(a => `- ${a.message}`).join('\n')}` : '',
    task.status !== 'done' && (task.rejectionReason || legacyRejection) ? `最近打回理由（在最新需求范围内逐项回应；用户已撤回的旧范围不应再次追加）：\n${task.rejectionReason ?? legacyRejection}` : '',
    task.status !== 'done' && task.previousAttempt?.resultSummary ? `上次交付（可能不完整，不等于本次完成）：\n${task.previousAttempt.resultSummary.slice(0, 6000)}` : '',
    task.status !== 'done' && task.previousAttempt?.reviewSummary ? `上次核验意见：\n${task.previousAttempt.reviewSummary.slice(0, 3000)}` : '',
    task.status !== 'done' && task.previousAttempt?.reviewHandoff ? `上次内部交接：\n${task.previousAttempt.reviewHandoff.slice(0, 2000)}` : '',
    task.status === 'done' ? '此任务已经通过验收，历史打回不是新的返工要求，不要重复执行。' : '若补充要求或打回理由指出缺项，针对缺项修正并说明实际变化，不要原样重复旧交付。若要求相互冲突或无法完成，明确说明，不要伪称完成。',
  ].filter(Boolean).join('\n\n')
}
