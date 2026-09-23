import { randomUUID } from 'node:crypto'
import { record, requiredText } from '../core/validation.js'
import { appendBounded } from '../core/collections.js'
import type { Companion } from '../domain.js'
import type { PartnerStore } from '../store.js'
import type { ScheduledPartnerTask } from './domain.js'
import { completionCondition, WakeToolsUnavailable } from './wakeup-context.js'
import { bindBoardContinuation } from '../tasks/continuation.js'

export interface ContinuationRunner {
  execute(entry: ScheduledPartnerTask, companion: Companion, signal: AbortSignal): Promise<unknown>
  notify(entry: ScheduledPartnerTask): Promise<void>
}

/** Durable wake-ups share schedule storage, but never inherit recurring execution semantics. */
export class ScheduleContinuations {
  private runner?: ContinuationRunner
  private readonly active = new Map<string, AbortController>()
  private readonly notifying = new Set<string>()
  private unsubscribe: (() => void) | undefined
  private closed = false
  constructor(private readonly store: PartnerStore) {}

  configure(runner: ContinuationRunner): void { this.runner = runner }
  start(): void {
    this.unsubscribe ??= this.store.subscribe(state => {
      for (const [id, controller] of this.active) {
        const entry = state.schedules.find(item => item.id === id)
        if (!entry || !state.companions.find(c => c.id === entry.companionId)?.capabilities.includes('schedules')
          || entry.continuation?.state === 'cancelled' || (!entry.enabled && entry.continuation?.state === 'running')) controller.abort()
      }
    }, () => {})
  }
  close(): void { this.closed = true; this.unsubscribe?.(); this.unsubscribe = undefined; for (const c of this.active.values()) c.abort() }

  async defer(owner: string, sessionId: string, value: unknown): Promise<ScheduledPartnerTask> {
    const input = record(value, 'continuation')
    const now = Date.now(), delay = minutes(input.delayMinutes, 2, 1, 1440)
    const taskKey = requiredText(input.taskKey, 'taskKey', 200)
    const externalTaskId = requiredText(input.externalTaskId, 'externalTaskId', 300)
    const title = requiredText(input.title, 'title', 160)
    const check = requiredText(input.check, 'check', 6000), nextStep = requiredText(input.nextStep, 'nextStep', 6000)
    const completion = input.completion === undefined ? undefined : requiredText(input.completion, 'completion', 3000)
    const timeoutMinutes = minutes(input.timeoutMinutes, 10, 1, 120)
    const maxAttempts = minutes(input.maxAttempts, 12, 1, 100)
    const deadlineAt = now + minutes(input.deadlineMinutes, 1440, delay, 43_200) * 60_000
    let result!: ScheduledPartnerTask
    await this.store.update(state => {
      if (!state.companions.find(c => c.id === owner)?.capabilities.includes('schedules')) throw new Error('请先勾选伙伴的定时任务能力')
      if (!state.sessions.some(s => s.companionId === owner && s.sessionId === sessionId)) throw new Error('只能从当前伙伴的正式会话预约续接')
      const existing = state.schedules.find(s => s.companionId === owner && s.continuation?.taskKey === taskKey)
      if (existing) {
        if (existing.continuation!.externalTaskId !== externalTaskId || existing.continuation!.originSessionId !== sessionId) throw new Error('taskKey 已用于另一个任务或会话，请核实任务身份')
        // Adopt an old timer only from its exact originating, currently executing board context.
        if (!existing.continuation!.board && existing.continuation!.state === 'waiting') bindBoardContinuation(state, existing, input.boardTaskId === undefined ? undefined : requiredText(input.boardTaskId, 'boardTaskId', 160))
        if (input.boardTaskId !== undefined && existing.continuation?.board?.taskId !== input.boardTaskId) throw new Error('此预约未绑定当前看板任务，请先核实原预约，不可复用到其他任务')
        result = structuredClone(existing); return
      }
      if (state.schedules.length >= 100) throw new Error('定时任务已达到 100 项，请先清理旧计划')
      result = { id: `schedule-${randomUUID()}`, companionId: owner, title, prompt: check,
        schedule: { kind: 'once', at: now + delay * 60_000 }, enabled: true, destroySessionAfterRun: false,
        overlapPolicy: 'queue', timeoutMinutes, nextRunAt: now + delay * 60_000, createdAt: now, updatedAt: now,
        continuation: { taskKey, externalTaskId, originSessionId: sessionId, check, ...(completion === undefined ? {} : { completion }), nextStep, state: 'waiting', attempts: 0, checks: 0, maxAttempts, deadlineAt } }
      bindBoardContinuation(state, result, input.boardTaskId === undefined ? undefined : requiredText(input.boardTaskId, 'boardTaskId', 160))
      state.schedules.push(result)
    })
    return structuredClone(result)
  }

  async resolve(owner: string, sessionId: string, value: unknown): Promise<ScheduledPartnerTask> {
    const input = record(value, 'continuation result'), id = requiredText(input.scheduleId, 'scheduleId', 160)
    const token = input.runToken === undefined ? undefined : requiredText(input.runToken, 'runToken', 160)
    const summary = requiredText(input.summary, 'summary', 12_000)
    if (!['pending', 'completed', 'blocked'].includes(String(input.outcome))) throw new Error('outcome 必须为 pending、completed 或 blocked')
    let result!: ScheduledPartnerTask
    await this.store.update(state => {
      if (!state.companions.find(c => c.id === owner)?.capabilities.includes('schedules')) throw new Error('定时任务能力已撤回')
      const entry = state.schedules.find(s => s.id === id && s.companionId === owner), wake = entry?.continuation
      const running = wake?.state === 'running' && token !== undefined && wake.runToken === token
      // The originating conversation may verify an external result before its timer fires.
      // It can settle only a waiting task with an exact external identity, never a stale run token.
      const early = wake?.state === 'waiting' && token === undefined && input.externalTaskId === wake.externalTaskId && input.outcome !== 'pending'
      if (!entry || !wake || !entry.enabled || (!running && !early) || wake.originSessionId !== sessionId) throw new Error('续接轮次已结束、已取消或不属于当前会话，请重新读取计划')
      const now = Date.now()
      wake.summary = summary; wake.checks = (wake.checks ?? 0) + 1; delete wake.runToken
      if (input.outcome === 'pending') {
        const delay = minutes(input.delayMinutes, Math.min(60, 2 ** Math.min(wake.attempts, 6)), 1, 1440)
        if (wake.attempts >= wake.maxAttempts || now + delay * 60_000 > wake.deadlineAt) {
          wake.state = 'blocked'; wake.summary = `等待已达到次数或截止时间上限。${summary}`; entry.enabled = false
        } else {
          wake.state = 'waiting'; entry.nextRunAt = now + delay * 60_000; entry.schedule = { kind: 'once', at: entry.nextRunAt }
        }
      } else { wake.state = input.outcome as 'completed' | 'blocked'; entry.enabled = false }
      entry.lastRunAt = now; entry.lastRunStatus = wake.state === 'blocked' ? 'failed' : 'completed'; entry.updatedAt = now
      result = structuredClone(entry)
    })
    return result
  }

  async cancel(owner: string, id: string): Promise<void> {
    await this.store.update(state => {
      const entry = state.schedules.find(s => s.id === id && s.companionId === owner)
      if (!entry?.continuation) throw new Error('续接计划不存在')
      entry.continuation.state = 'cancelled'; delete entry.continuation.runToken
      entry.enabled = false; entry.updatedAt = Date.now()
    })
  }

  async tick(): Promise<void> {
    if (this.closed) return
    for (const entry of this.store.snapshot().schedules.filter(s => s.continuation)) {
      if (!this.store.hasCapability(entry.companionId, 'schedules')) continue
      if (entry.enabled && entry.nextRunAt <= Date.now()) void this.run(entry.id).catch(() => {})
      else if (!this.active.has(entry.id)) void this.notify(entry.id).catch(() => {})
    }
  }

  async run(id: string): Promise<void> {
    if (this.closed || !this.runner || this.active.has(id)) return
    const initial = this.store.snapshot().schedules.find(s => s.id === id)
    if (!initial?.enabled || !initial.continuation || !this.store.hasCapability(initial.companionId, 'schedules')) return
    if ([...this.active.keys()].some(key => this.store.snapshot().schedules.find(s => s.id === key)?.companionId === initial.companionId)) return
    const controller = new AbortController(); this.active.set(id, controller)
    let claimed: ScheduledPartnerTask | undefined
    try {
      await this.store.update(state => {
        const entry = state.schedules.find(s => s.id === id), wake = entry?.continuation
        if (!entry?.enabled || !wake || !['waiting', 'running'].includes(wake.state) || !state.companions.find(c => c.id === entry.companionId)?.capabilities.includes('schedules')) return
        // A persisted running state after restart must re-check external facts, not replay submission.
        if (wake.attempts >= wake.maxAttempts || Date.now() >= wake.deadlineAt) {
          wake.state = 'blocked'; wake.summary = '等待已达到检查次数或截止时间上限，请人工核实外部任务'; entry.enabled = false; return
        }
        wake.state = 'running'; wake.attempts++; wake.runToken = randomUUID(); wake.dispatchedAt = Date.now(); entry.updatedAt = Date.now()
        appendBounded(state.executionRuns, { id: `wake-${wake.runToken}`, kind: 'schedule', ownerCompanionId: entry.companionId,
          sessionId: wake.originSessionId, sourceId: entry.id, status: 'running', destroyAfterRun: false, startedAt: Date.now(), toolNames: [] }, 500)
        claimed = structuredClone(entry)
      })
      if (!claimed) return
      controller.signal.throwIfAborted()
      const companion = this.store.snapshot().companions.find(c => c.id === claimed!.companionId)!
      await this.runner.execute(claimed, companion, controller.signal)
      // A natural-language promise is not a durable outcome. Never silently mark it completed.
      await this.blockUnresolved(id, claimed.continuation!.runToken!, '本轮未提交续接结果，已暂停；请核实执行记录后处理')
    } catch (error) {
      const message = error instanceof WakeToolsUnavailable || (error instanceof Error && error.message.startsWith('本次定时检查超过')) ? error.message : '本轮续接执行失败，已暂停以避免重复执行后续动作'
      if (claimed && !this.closed) await this.blockUnresolved(id, claimed.continuation!.runToken!, controller.signal.aborted ? '执行被取消或能力已关闭；请核实执行记录后处理' : message)
    } finally {
      this.active.delete(id)
      if (claimed && !this.closed) await this.store.update(state => {
        const run = state.executionRuns.find(r => r.id === `wake-${claimed!.continuation!.runToken}`)
        const wake = state.schedules.find(s => s.id === id)?.continuation
        if (run) {
          run.status = !wake || wake.state === 'cancelled' ? 'canceled' : wake.state === 'blocked' ? 'failed' : 'completed'
          run.completedAt = Date.now()
          if (wake?.summary) run.outputSummary = wake.summary.slice(0, 2000)
          if (run.status === 'failed') run.error = wake?.summary ?? '续接失败'
        }
      })
      if (!this.closed) await this.notify(id).catch(() => {})
    }
  }

  private async blockUnresolved(id: string, token: string, summary: string): Promise<void> {
    await this.store.update(state => {
      const entry = state.schedules.find(s => s.id === id), wake = entry?.continuation
      if (!entry || !wake || wake.state !== 'running' || wake.runToken !== token) return
      wake.state = 'blocked'; wake.summary = summary; delete wake.runToken
      entry.enabled = false; entry.lastRunStatus = 'failed'; entry.lastRunAt = Date.now(); entry.updatedAt = Date.now()
    })
  }

  private async notify(id: string): Promise<void> {
    const entry = this.store.snapshot().schedules.find(s => s.id === id), wake = entry?.continuation
    // Linked task delivery belongs to the requirement, never to each timer.
    if (wake?.board) return
    if (!this.runner || this.notifying.has(id) || !entry || !wake || !['completed', 'blocked'].includes(wake.state)
      || wake.notifiedAt || (wake.nextNotifyAt ?? 0) > Date.now() || !this.store.hasCapability(entry.companionId, 'schedules')) return
    this.notifying.add(id)
    try {
      await this.runner.notify(entry)
      await this.store.update(state => { const current = state.schedules.find(s => s.id === id)?.continuation; if (current?.state === wake.state) current.notifiedAt = Date.now() })
    } catch {
      await this.store.update(state => { const current = state.schedules.find(s => s.id === id)?.continuation; if (current) current.nextNotifyAt = Date.now() + 300_000 })
    } finally { this.notifying.delete(id) }
  }
}

function minutes(value: unknown, fallback: number, min: number, max: number): number {
  const result = value === undefined ? fallback : value
  if (!Number.isInteger(result) || (result as number) < min || (result as number) > max) throw new Error(`参数须为 ${min}–${max} 范围的整数`)
  return result as number
}

export function continuationPrompt(entry: ScheduledPartnerTask): string {
  const wake = entry.continuation!
  if (wake.board) return `这是看板任务的外部结果核验，不是新任务，也不是执行整个后续流程。
看板任务 ID：${wake.board.taskId}；计划 ID：${entry.id}；runToken：${wake.runToken}；外部任务 ID：${wake.externalTaskId}
先调用 partner_schedule list 确认本计划仍启用且 token 一致；过期请求直接结束。
完成条件：${completionCondition(entry)}
只读检查方法：${wake.check}
上次结果：${wake.summary ?? '首次检查'}
只核实已有外部任务，禁止重新提交、创建新预约或执行 nextStep。仍未完成调用 resolve outcome=pending 保存延期；已完成调用 resolve outcome=completed 并在 summary 写结果路径、外部 ID 和核实证据；失败调用 resolve outcome=blocked。每次 resolve 携带 scheduleId 和当前 runToken。
提交回执后立即结束本轮。看板会恢复原任务执行后续步骤；等待不送验收，不向渠道发送中间通知，不使用 sleep 或 Goal 持续轮询。`
  return `这是一次长任务续接，不是新任务。只处理已授权范围，仍遵守当前权限及审批。先检查原任务是否已被用户取消或完成；已取消时调用 partner_schedule cancel。不可重复提交外部任务，重启后先核实已有产出。
计划 ID：${entry.id}\n本轮 runToken：${wake.runToken}\n外部任务 ID：${wake.externalTaskId}
检查次数：${wake.attempts}/${wake.maxAttempts}；截止：${new Date(wake.deadlineAt).toISOString()}
本预约自己的完成条件：\n${completionCondition(entry)}
历史检查说明（仅提取查询方法；其中的后续动作不能扩大上面的完成条件）：\n${wake.check}\n预约关闭后的后续流程（历史 Goal 引用仅作背景，不是关闭预约的前提，不为续接创建或修改 Goal）：\n${wake.nextStep}\n上次结果：${wake.summary ?? '首次检查'}
仍在运行：调用 partner_schedule resolve，outcome=pending，summary 写真实检查结果，可指定 delayMinutes；工具保存延期成功后结束本轮，不睡眠轮询，不通知用户。
已完成：只核实本预约自己的完成条件，立即调用 resolve，outcome=completed 关闭本预约，summary 写核实证据；然后才继续上述后续流程。不得等待整个对话或 Goal 完成，也不得把后续流程的新任务当成原任务延期。若后续步骤产生新的长任务，为新任务单独 defer。
失败、无法核实或需新增授权：调用 resolve，outcome=blocked，summary 写原因。resolve 必须携带上述 scheduleId 和 runToken。不要仅口头声称已预约或完成。
本次请求可能插入正在执行的会话；先用 partner_schedule list 核对本预约仍启用且 runToken 相同，过期或取消的请求直接跳过。这是已有预约的续接，不是新增关注，不调用 partner_concern_suggest，不编造 evidence 或占位参数。工具缺失时明确报告受阻，不使用无关工具代替。已有结果只核验，不重复生成后续已有产物。不得使用 sleep 等待；未完成即 pending 并释放检查。系统负责本预约完成/受阻后的通知，请勿另发重复通知。不要创建周期任务或新的同任务续接来绕过次数和期限。`
}
