import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { PartnerState } from '../domain.js'
import type { PartnerStore } from '../store.js'
import { completedTurnEvents } from '../agent-runtime.js'
import { publicTaskDeliverable } from '../tasks/result.js'
import type { PartnerInboxStore } from './store.js'

export class PartnerNoticeService {
  private readonly stop: () => void
  private closed = false
  constructor(private readonly store: PartnerStore, private readonly inbox: PartnerInboxStore, private readonly report: (error: unknown) => void) {
    this.stop = store.subscribe((next, previous) => this.recordChanges(next, previous), report)
  }
  observeSession(session: Session, event: SessionEvent): void {
    if (this.closed || event.type !== 'turn/end' || event.data.reason.kind !== 'completed') return
    try {
      const state = this.store.snapshot()
      const route = state.sessions.find(item => item.sessionId === session.id)
      const companion = state.companions.find(item => item.id === route?.companionId)
      if (!route || !companion) return
      const events = completedTurnEvents(session.snapshotEvents(), event)
      // Internal task/review/heartbeat turns are summarized by their terminal
      // domain event, not surfaced as duplicate or unfinished assistant replies.
      if (!events.some(item => item.type === 'user/message' && item.data.source.kind === 'user')) return
      const summary = events.filter(item => item.type === 'assistant/message' && !item.data.interrupted)
        .map(item => item.type === 'assistant/message' ? item.data.message.content.filter(block => block.type === 'text').map(block => block.type === 'text' ? block.text : '').join('\n').trim() : '')
        .filter(Boolean).at(-1) ?? ''
      if (!summary) return
      this.inbox.append({ id: `reply:${session.id}:${event.data.turn}`, kind: 'reply', companionId: companion.id, companionName: companion.name, title: `${companion.name} 回复完成`, summary, createdAt: Date.now(), routeId: route.id, sessionId: session.id })
    } catch (error) { this.report(error) }
  }
  private recordChanges(next: PartnerState, previous: PartnerState): void {
    const companions = new Map(next.companions.map(item => [item.id, item]))
    const oldTasks = new Map(previous.tasks.map(item => [item.id, item]))
    for (const task of next.tasks) {
      if (!['done', 'blocked'].includes(task.status) || oldTasks.get(task.id)?.status === task.status) continue
      const companion = companions.get(task.assigneeCompanionId ?? task.creatorCompanionId ?? '')
      if (!companion) continue
      this.inbox.append({ id: `task:${task.id}:${task.revision}:${task.status}`, kind: 'task', companionId: companion.id, companionName: companion.name,
        title: `${task.status === 'done' ? '已完成' : '遇到阻塞'} · ${task.title}`, summary: task.resultAbstract || publicTaskDeliverable(task.resultSummary ?? '') || (task.status === 'done' ? '任务已完成，点击查看任务详情。' : '任务遇到阻塞，请查看任务详情。'), createdAt: task.updatedAt, taskId: task.id })
    }
    const oldRuns = new Map(previous.executionRuns.map(item => [item.id, item.status]))
    for (const run of next.executionRuns) {
      if (run.kind !== 'schedule' || !['completed', 'failed', 'timed-out', 'canceled'].includes(run.status) || oldRuns.get(run.id) === run.status) continue
      const companion = companions.get(run.ownerCompanionId)
      if (!companion) continue
      const title = next.schedules.find(item => item.id === run.sourceId)?.title ?? '定时任务'
      this.inbox.append({ id: `schedule:${run.id}:${run.status}`, kind: 'schedule', companionId: companion.id, companionName: companion.name, title: `${run.status === 'completed' ? '已完成' : '未完成'} · ${title}`, summary: run.outputSummary || run.error || '执行已结束，可到定时任务中查看记录。', createdAt: run.completedAt ?? Date.now() })
    }
  }
  close(): void { this.closed = true; this.stop() }
}
