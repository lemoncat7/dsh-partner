import { createHash } from 'node:crypto'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { PartnerState } from '../domain.js'
import type { PartnerStore } from '../store.js'
import { completedTurnEvents } from '../agent-runtime.js'
import { channelReplyPartsAfter, isAutonomousDeliveryTurn, isRequirementDeliveryReceipt } from '../channels/delivery-policy.js'
import { continuationFinalReply } from '../scheduler/final-reply.js'
import type { PushEvent } from './push-domain.js'
import type { PushService } from './push-service.js'

const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24)
export function pushEventsFromChanges(next: PartnerState, previous: PartnerState): PushEvent[] {
  const events: PushEvent[] = []
  const names = new Map(next.companions.map(c => [c.id, c.name]))
  for (const item of next.requirements ?? []) {
    if (!item.ownerCompanionId || !names.has(item.ownerCompanionId)) continue
    const old = previous.requirements?.find(r => r.id === item.id)
    if (item.status === 'done' && item.summary && (old?.status !== 'done' || old.summary !== item.summary)) {
      events.push({ id: `requirement:${item.id}:${digest(item.summary)}`, companionId: item.ownerCompanionId,
        title: `${names.get(item.ownerCompanionId)} · 需求完成`, text: `${item.title}\n${item.summary}`, createdAt: item.updatedAt, outcome: 'completed' })
    } else if (item.stageReport?.summary && old?.stageReport?.key !== item.stageReport.key
      && next.tasks.some(t => t.requirementId === item.id && t.status === 'blocked')) {
      events.push({ id: `requirement-blocked:${item.id}:${item.stageReport.key}`, companionId: item.ownerCompanionId,
        title: `${names.get(item.ownerCompanionId)} · 需要处理`, text: item.stageReport.summary, createdAt: item.stageReport.createdAt, outcome: 'problem' })
    }
  }
  for (const entry of next.schedules) {
    const wake = entry.continuation
    if (!wake?.finalReply || wake.board || !['completed','blocked'].includes(wake.state) || previous.schedules.find(s => s.id === entry.id)?.continuation?.finalReply?.key === wake.finalReply.key) continue
    events.push({ id: `reply:${wake.finalReply.key}`, companionId: entry.companionId,
      title: `${names.get(entry.companionId) ?? '伙伴'} · ${wake.state === 'completed' ? '执行完成' : '需要处理'}`,
      text: wake.finalReply.text, createdAt: Date.now(), outcome: wake.state === 'completed' ? 'completed' : 'problem' })
  }
  for (const run of next.executionRuns) {
    if (run.kind !== 'schedule' || !['completed','failed','timed-out'].includes(run.status) || previous.executionRuns.find(r => r.id === run.id)?.status === run.status) continue
    const entry = next.schedules.find(s => s.id === run.sourceId)
    if (!entry || entry.continuation || entry.boardTaskId) continue
    events.push({ id: `schedule:${run.id}`, companionId: run.ownerCompanionId, title: `${names.get(run.ownerCompanionId) ?? '伙伴'} · ${entry.title}`,
      text: run.outputSummary || run.error || '定时执行已结束，请查看记录。', createdAt: run.completedAt ?? Date.now(), outcome: run.status === 'completed' ? 'completed' : 'problem' })
  }
  return events
}

export class PushObserver {
  private readonly stop: () => void
  private closed = false
  private readonly pending = new Set<Promise<void>>()
  constructor(private readonly store: PartnerStore, private readonly push: PushService, private readonly report: () => void) {
    this.stop = store.subscribe((next, old) => {
      if (!next.pushChannels?.some(c => c.enabled)) return
      for (const event of pushEventsFromChanges(next, old)) this.submit(event)
    }, report)
  }
  private submit(event: PushEvent): void {
    if (this.closed) return
    const work = this.push.enqueue(event).catch(this.report).finally(() => this.pending.delete(work))
    this.pending.add(work)
  }
  observeSession(session: Session, event: SessionEvent): void {
    if (this.closed || event.type !== 'turn/end' || event.data.reason.kind !== 'completed') return
    const state = this.store.snapshot()
    const route = state.sessions.find(r => r.sessionId === session.id)
    const companion = state.companions.find(c => c.id === route?.companionId)
    if (!companion || !state.pushChannels?.some(c => c.companionId === companion.id && c.enabled)) return
    const history = session.snapshotEvents().filter(e => e.seq < event.seq)
    const turn = completedTurnEvents(history, event)
    const continuation = continuationFinalReply(state.schedules, session.id, history, turn, event)
    if (continuation) {
      const wake = state.schedules.find(s => s.id === continuation.id)!.continuation!
      this.submit({ id: `reply:${continuation.reply.key}`, companionId: companion.id,
        title: `${companion.name} · ${wake.state === 'completed' ? '执行完成' : '需要处理'}`, text: continuation.reply.text,
        createdAt: Date.now(), outcome: wake.state === 'completed' ? 'completed' : 'problem' }); return
    }
    // Requirement delivery has its own single receipt. Internal review/heartbeat
    // turns never become user notifications just because a model turn ended.
    if (turn.some(isRequirementDeliveryReceipt)) return
    const parts = channelReplyPartsAfter(turn, -1, isAutonomousDeliveryTurn(turn, history))
    if (!parts.text) return
    this.submit({ id: `reply:${session.id}:${event.data.turn}`, companionId: companion.id,
      title: `${companion.name} · 回复完成`, text: parts.text, createdAt: Date.now(), outcome: 'completed' })
  }
  async close(): Promise<void> { this.closed = true; this.stop(); await Promise.all(this.pending) }
}
