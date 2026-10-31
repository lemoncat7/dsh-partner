import type { Companion } from '../domain.js'
import { sleepPolicy } from './sleep.js'

export const FATIGUE_AWAKE_PER_HOUR = 5
export const FATIGUE_SLEEP_PER_HOUR = 35
export const INITIAL_FATIGUE = 30
const HOUR = 3_600_000
const clamp = (n: number) => Math.max(0, Math.min(100, n))
type Sleeper = Pick<Companion, 'sleepState' | 'sleepPolicy' | 'characterCard'>

/** Integrate actual elapsed time, including a natural wake while the host was offline. */
export function fatigueValue(c: Sleeper, now = Date.now()): number {
  const sample = c.sleepState?.fatigue
  const value = Number.isFinite(sample?.value) ? clamp(sample!.value) : INITIAL_FATIGUE
  if (!sample || !Number.isFinite(sample.at) || now <= sample.at || !sleepPolicy(c).enabled) return value
  const e = c.sleepState?.episode
  const sleepEnd = e ? Math.min(e.wakeAt, e.wokeAt ?? now, now) : 0
  const asleep = e ? Math.max(0, sleepEnd - Math.max(sample.at, e.startedAt)) : 0
  const awake = Math.max(0, now - sample.at - asleep)
  // Apply sleep first when crossing a wake boundary; do not let negative fatigue offset later wakefulness.
  return Math.round(clamp(clamp(value - asleep / HOUR * FATIGUE_SLEEP_PER_HOUR) + awake / HOUR * FATIGUE_AWAKE_PER_HOUR) * 1_000_000) / 1_000_000
}
export function settleFatigue(c: Sleeper, now = Date.now()): number {
  const value = fatigueValue(c, now)
  const state = c.sleepState ??= {}
  state.fatigue = { value, at: Math.max(now, state.fatigue?.at ?? now) }
  return value
}
export function fatigueLabel(value: number): string {
  return value >= 80 ? '困得厉害' : value >= 60 ? '很困了' : value >= 40 ? '有些疲惫' : '精神尚好'
}
/** One roll per idle minute; no LLM gate and no fixed bedtime. */
export function fatigueSleepProbability(value: number): number {
  return value < 40 ? 0 : Math.min(0.3, 0.01 + ((value - 40) / 60) ** 2 * 0.29)
}
export function fatigueSleepMinutes(value: number): number {
  return Math.max(20, Math.min(480, Math.round((value - 20) / FATIGUE_SLEEP_PER_HOUR * 60)))
}
export function wakeCallsNeeded(value: number): number { return value >= 80 ? 4 : value >= 55 ? 3 : value >= 25 ? 2 : 1 }
