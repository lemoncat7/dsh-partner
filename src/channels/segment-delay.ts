import { setTimeout as sleep } from 'node:timers/promises'
import { performance } from 'node:perf_hooks'
import type { CharacterCard } from '../character/domain.js'

/** Delivery pacing only. No model call, shared timer or persisted conversation event. */
export async function waitForSegment(options: {
  card(): CharacterCard | undefined
  validate(): void
  signal: AbortSignal
}, clock = {
  now: () => performance.now(),
  random: () => Math.random(),
  sleep: (ms: number, signal: AbortSignal) => sleep(ms, undefined, { signal }),
}): Promise<void> {
  const started = clock.now()
  let fraction: number | undefined
  for (;;) {
    options.signal.throwIfAborted()
    options.validate()
    const card = options.card(), range = card?.segmentDelay
    if (!card?.segmentedReplies || !range?.enabled) return
    const { minSeconds: min, maxSeconds: max } = range
    // Guard legacy/imported state too; never allow NaN or an unbounded queue stall.
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max > 60 || min > max) return
    fraction ??= Math.max(0, Math.min(1, clock.random()))
    const remaining = (min + (max - min) * fraction) * 1000 - (clock.now() - started)
    if (remaining <= 0) return
    // Read current settings/authorization and supersession while waiting. An edit
    // adjusts the same sampled interval, without restarting or rerolling it.
    await clock.sleep(Math.min(200, remaining), options.signal)
  }
}
