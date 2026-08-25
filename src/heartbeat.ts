import type { Context } from '@deepseek-ai/cordis'
import type { ChannelSession, Companion, HeartbeatRuntimeState } from './domain.js'
import { PartnerStore } from './store.js'
import { PartnerAgentRuntime } from './agent-runtime.js'
import { ChannelManager } from './channels/manager.js'

const TICK_MS = 60_000

export class HeartbeatScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined
  private closed = false
  private readonly running = new Set<string>()

  constructor(
    private readonly ctx: Context,
    private readonly store: PartnerStore,
    private readonly agents: PartnerAgentRuntime,
    private readonly channels: ChannelManager,
    private readonly timeZone = 'Asia/Shanghai',
  ) {}

  start(): void {
    if (this.closed || this.timer !== undefined) return
    this.schedule(2_000)
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  async trigger(companionId: string, force = false): Promise<{ checked: boolean; sent: boolean; reason?: string }> {
    if (this.running.has(companionId)) return { checked: false, sent: false, reason: '心跳正在执行' }
    const companion = this.store.snapshot().companions.find(item => item.id === companionId)
    if (companion === undefined) throw new Error('伙伴不存在')
    if (!force && !companion.automation.heartbeat.enabled) return { checked: false, sent: false, reason: '心跳未启用' }
    this.running.add(companionId)
    try { return await this.run(companion, force) }
    finally { this.running.delete(companionId) }
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.tick().catch(error => this.ctx.logger.error(`dsh-partner heartbeat tick failed: ${message(error)}`))
        .finally(() => { if (!this.closed) this.schedule(TICK_MS) })
    }, delay)
    this.timer.unref?.()
  }

  private async tick(): Promise<void> {
    const now = Date.now()
    for (const companion of this.store.snapshot().companions) {
      if (!companion.automation.heartbeat.enabled) continue
      const stored = this.store.snapshot().heartbeatStates.find(item => item.companionId === companion.id)
      if (stored === undefined) {
        await this.saveState(companion, heartbeatState([], companion, now, this.timeZone))
        continue
      }
      const state = stored
      if (state.nextCheckAt > now) continue
      await this.trigger(companion.id).catch(error => this.ctx.logger.warn(`dsh-partner heartbeat for ${companion.id} failed: ${message(error)}`))
    }
  }

  private async run(companion: Companion, force: boolean): Promise<{ checked: boolean; sent: boolean; reason?: string }> {
    const now = Date.now()
    const policy = companion.automation.heartbeat
    const existing = heartbeatState(this.store.snapshot().heartbeatStates, companion, now, this.timeZone)
    const today = localDay(now, this.timeZone)
    const sentCount = existing.sentDay === today ? existing.sentCount : 0
    if (!force && quiet(now, policy.quietStartHour, policy.quietEndHour, this.timeZone)) {
      await this.saveState(companion, { ...existing, nextCheckAt: nextAllowedTime(now, policy.quietEndHour, this.timeZone), sentDay: today, sentCount })
      return { checked: false, sent: false, reason: '静默时段' }
    }
    if (!force && policy.dailyLimit > 0 && sentCount >= policy.dailyLimit) {
      await this.saveState(companion, { ...existing, nextCheckAt: nextDay(now, policy.quietEndHour, this.timeZone), sentDay: today, sentCount })
      return { checked: false, sent: false, reason: '达到今日主动提醒上限' }
    }
    const route = latestDeliverableRoute(this.store.snapshot(), companion.id)
    if (route === undefined) {
      await this.saveState(companion, successState(existing, companion, now, today, sentCount, false))
      return { checked: false, sent: false, reason: '没有可投递的已批准微信会话' }
    }
    try {
      const output = await this.agents.heartbeat(companion, route)
      if (!output) {
        await this.saveState(companion, successState(existing, companion, now, today, sentCount, false))
        return { checked: true, sent: false, reason: '没有值得主动通知的内容' }
      }
      await this.channels.sendProactive(route.channelId, route.userId, output)
      await this.saveState(companion, successState(existing, companion, now, today, sentCount + 1, true))
      return { checked: true, sent: true }
    } catch (error) {
      const failures = existing.consecutiveFailures + 1
      await this.saveState(companion, {
        ...existing, companionId: companion.id, lastCheckedAt: now, sentDay: today, sentCount,
        consecutiveFailures: failures, lastError: message(error),
        nextCheckAt: now + Math.min(6 * 3_600_000, 60_000 * 2 ** Math.min(failures, 8)),
      })
      throw error
    }
  }

  private async saveState(companion: Companion, next: HeartbeatRuntimeState): Promise<void> {
    await this.store.update(state => {
      state.heartbeatStates = state.heartbeatStates.filter(item => item.companionId !== companion.id)
      state.heartbeatStates.push(next)
    })
  }
}

function heartbeatState(states: HeartbeatRuntimeState[], companion: Companion, now: number, timeZone: string): HeartbeatRuntimeState {
  return states.find(item => item.companionId === companion.id) ?? {
    companionId: companion.id, nextCheckAt: now + companion.automation.heartbeat.intervalMinutes * 60_000,
    sentDay: localDay(now, timeZone), sentCount: 0, consecutiveFailures: 0,
  }
}

function successState(previous: HeartbeatRuntimeState, companion: Companion, now: number, sentDay: string, sentCount: number, sent: boolean): HeartbeatRuntimeState {
  const { lastError: _lastError, ...rest } = previous
  return {
    ...rest, companionId: companion.id, lastCheckedAt: now,
    ...(sent ? { lastSentAt: now } : {}),
    nextCheckAt: now + companion.automation.heartbeat.intervalMinutes * 60_000,
    sentDay, sentCount, consecutiveFailures: 0,
  }
}

function latestDeliverableRoute(state: ReturnType<PartnerStore['snapshot']>, companionId: string): ChannelSession | undefined {
  return state.sessions
    .filter(route => route.companionId === companionId
      && state.channels.some(channel => channel.id === route.channelId && channel.enabled)
      && state.pairings.some(pairing => pairing.channelId === route.channelId && pairing.userId === route.userId && pairing.status === 'approved'))
    .sort((a, b) => b.lastMessageAt - a.lastMessageAt)[0]
}

export function quiet(now: number, start: number, end: number, timeZone = 'Asia/Shanghai'): boolean {
  if (start === end) return false
  const hour = zonedParts(now, timeZone).hour
  return start < end ? hour >= start && hour < end : hour >= start || hour < end
}
export function nextAllowedTime(now: number, hour: number, timeZone = 'Asia/Shanghai'): number {
  return nextZonedHour(now, hour, timeZone, false)
}
export function nextDay(now: number, hour: number, timeZone = 'Asia/Shanghai'): number {
  return nextZonedHour(now, hour, timeZone, true)
}
export function localDay(now: number, timeZone = 'Asia/Shanghai'): string {
  const part = zonedParts(now, timeZone)
  return `${part.year}-${String(part.month).padStart(2, '0')}-${String(part.day).padStart(2, '0')}`
}

function nextZonedHour(now: number, hour: number, timeZone: string, requireNextDay: boolean): number {
  const currentDay = localDay(now, timeZone)
  let candidate = Math.floor(now / 60_000) * 60_000 + 60_000
  for (let minute = 0; minute < 60 && zonedParts(candidate, timeZone).minute !== 0; minute += 1) candidate += 60_000
  for (let elapsedHours = 0; elapsedHours <= 49; elapsedHours += 1, candidate += 3_600_000) {
    const part = zonedParts(candidate, timeZone)
    const candidateDay = `${part.year}-${String(part.month).padStart(2, '0')}-${String(part.day).padStart(2, '0')}`
    if (part.hour === hour && (!requireNextDay || candidateDay !== currentDay)) return candidate
  }
  throw new Error(`cannot resolve next ${hour}:00 in ${timeZone}`)
}

function zonedParts(now: number, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const values: Record<string, number> = {}
  for (const part of formatter(timeZone).formatToParts(now)) {
    if (part.type !== 'literal') values[part.type] = Number(part.value)
  }
  return { year: values.year!, month: values.month!, day: values.day!, hour: values.hour!, minute: values.minute! }
}

const formatters = new Map<string, Intl.DateTimeFormat>()
function formatter(timeZone: string): Intl.DateTimeFormat {
  let value = formatters.get(timeZone)
  if (value === undefined) {
    value = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
    })
    formatters.set(timeZone, value)
  }
  return value
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
