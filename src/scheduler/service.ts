import { randomUUID } from 'node:crypto'
import { oneOf, optionalBoolean, record, requiredText } from '../core/validation.js'
import type { EphemeralExecutionService } from '../execution/service.js'
import type { PartnerStore } from '../store.js'
import type { ScheduledPartnerTask } from './domain.js'

const OVERLAP_POLICIES = ['skip', 'queue'] as const

export class PartnerSchedulerService {
  private timer: NodeJS.Timeout | undefined
  private readonly running = new Set<string>()
  private readonly queued = new Set<string>()
  private closed = false

  constructor(private readonly store: PartnerStore, private readonly executor: EphemeralExecutionService, private readonly timeZone: string) {}

  start(): void {
    if (this.timer || this.closed) return
    this.timer = setInterval(() => { void this.tick() }, 15_000)
    this.timer.unref?.()
    void this.tick()
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  list(): ScheduledPartnerTask[] { return this.store.snapshot().schedules }

  async create(value: unknown, companionId?: string): Promise<ScheduledPartnerTask> {
    const input = record(value, 'schedule')
    const owner = companionId ?? requiredText(input.companionId, 'companionId', 120)
    this.requireCompanion(owner)
    const now = Date.now()
    const schedule = parseSchedule(input.schedule)
    const entry: ScheduledPartnerTask = {
      id: `schedule-${randomUUID()}`, companionId: owner, title: requiredText(input.title, 'title', 160),
      prompt: requiredText(input.prompt, 'prompt', 12_000), schedule,
      enabled: optionalBoolean(input.enabled, true), destroySessionAfterRun: optionalBoolean(input.destroySessionAfterRun, true),
      overlapPolicy: input.overlapPolicy === undefined ? 'skip' : oneOf(input.overlapPolicy, OVERLAP_POLICIES, 'overlapPolicy'),
      timeoutMinutes: boundedInteger(input.timeoutMinutes, 10, 1, 120),
      nextRunAt: nextOccurrence(schedule, now, this.timeZone), createdAt: now, updatedAt: now,
    }
    await this.store.update(state => {
      if (state.schedules.length >= 100) throw new Error('Scheduled task limit reached; remove an obsolete schedule first')
      state.schedules.push(entry)
    })
    return entry
  }

  async update(id: string, value: unknown): Promise<ScheduledPartnerTask> {
    const input = record(value, 'schedule')
    let output!: ScheduledPartnerTask
    await this.store.update(state => {
      const entry = state.schedules.find(item => item.id === id)
      if (!entry) throw new Error('Schedule does not exist')
      if (input.title !== undefined) entry.title = requiredText(input.title, 'title', 160)
      if (input.prompt !== undefined) entry.prompt = requiredText(input.prompt, 'prompt', 12_000)
      if (input.schedule !== undefined) entry.schedule = parseSchedule(input.schedule)
      if (input.enabled !== undefined) entry.enabled = optionalBoolean(input.enabled, entry.enabled)
      if (input.destroySessionAfterRun !== undefined) entry.destroySessionAfterRun = optionalBoolean(input.destroySessionAfterRun, entry.destroySessionAfterRun)
      if (input.overlapPolicy !== undefined) entry.overlapPolicy = oneOf(input.overlapPolicy, OVERLAP_POLICIES, 'overlapPolicy')
      if (input.timeoutMinutes !== undefined) entry.timeoutMinutes = boundedInteger(input.timeoutMinutes, entry.timeoutMinutes, 1, 120)
      entry.updatedAt = Date.now()
      entry.nextRunAt = nextOccurrence(entry.schedule, entry.updatedAt, this.timeZone)
      output = structuredClone(entry)
    })
    return output
  }

  async remove(id: string): Promise<void> {
    await this.store.update(state => { state.schedules = state.schedules.filter(item => item.id !== id) })
  }

  async trigger(id: string): Promise<void> {
    const entry = this.store.snapshot().schedules.find(item => item.id === id)
    if (!entry) throw new Error('Schedule does not exist')
    await this.run(entry)
  }

  private async tick(): Promise<void> {
    if (this.closed) return
    const due = this.store.snapshot().schedules.filter(item => item.enabled && item.nextRunAt <= Date.now())
    for (const entry of due) void this.run(entry).catch(() => {})
  }

  private async run(entry: ScheduledPartnerTask): Promise<void> {
    if (this.running.has(entry.id)) {
      if (entry.overlapPolicy === 'queue') this.queued.add(entry.id)
      else await this.advance(entry.id, 'skipped')
      return
    }
    this.running.add(entry.id)
    try {
      const companion = this.requireCompanion(entry.companionId)
      await this.executor.execute({
        kind: 'schedule', sourceId: entry.id, companion, prompt: entry.prompt,
        timeoutMinutes: entry.timeoutMinutes, destroyAfterRun: entry.destroySessionAfterRun,
        systemInstruction: `这是定时任务「${entry.title}」。只执行本次计划内容；不要自行修改调度规则。`,
      })
      await this.advance(entry.id, 'completed')
    } catch {
      await this.advance(entry.id, 'failed')
      throw new Error(`Scheduled task failed: ${entry.title}`)
    } finally {
      this.running.delete(entry.id)
      if (this.queued.delete(entry.id)) {
        const current = this.store.snapshot().schedules.find(item => item.id === entry.id && item.enabled)
        if (current) void this.run(current).catch(() => {})
      }
    }
  }

  private async advance(id: string, status: NonNullable<ScheduledPartnerTask['lastRunStatus']>): Promise<void> {
    const now = Date.now()
    await this.store.update(state => {
      const entry = state.schedules.find(item => item.id === id)
      if (!entry) return
      entry.lastRunAt = now
      entry.lastRunStatus = status
      entry.nextRunAt = nextOccurrence(entry.schedule, Math.max(now, entry.nextRunAt), this.timeZone)
      entry.updatedAt = now
    })
  }

  private requireCompanion(id: string) {
    const companion = this.store.snapshot().companions.find(item => item.id === id)
    if (!companion) throw new Error('Companion does not exist')
    return companion
  }
}

export function nextOccurrence(schedule: ScheduledPartnerTask['schedule'], now: number, timeZone: string): number {
  if (schedule.kind === 'interval') return now + schedule.minutes * 60_000
  const start = Math.floor(now / 60_000) * 60_000 + 60_000
  for (let offset = 0; offset <= 49 * 60; offset += 1) {
    const candidate = start + offset * 60_000
    const parts = localParts(candidate, timeZone)
    if (parts.hour === schedule.hour && parts.minute === schedule.minute) return candidate
  }
  throw new Error('Unable to calculate next daily schedule occurrence')
}

function parseSchedule(value: unknown): ScheduledPartnerTask['schedule'] {
  const input = record(value, 'schedule expression')
  if (input.kind === 'interval') return { kind: 'interval', minutes: boundedInteger(input.minutes, 60, 5, 43_200) }
  if (input.kind === 'daily') return { kind: 'daily', hour: boundedInteger(input.hour, 9, 0, 23), minute: boundedInteger(input.minute, 0, 0, 59) }
  throw new Error('Schedule kind must be interval or daily')
}
function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new Error('Schedule number is out of range')
  return value as number
}
function localParts(at: number, timeZone: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at)
  const get = (type: string): number => Number(parts.find(item => item.type === type)?.value ?? -1)
  return { hour: get('hour'), minute: get('minute') }
}
