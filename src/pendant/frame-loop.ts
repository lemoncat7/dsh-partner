import { DEFAULT_PENDANT_SETTINGS, normalizePendantFps, type PendantFps } from './settings.js'

export interface FrameDriver {
  now(): number
  request(callback: (now: number) => void): number
  cancel(id: number): void
  delay(callback: () => void, ms: number): number
  clear(id: number): void
}

/** One coalesced configurable loop. Wake near the next deadline, then synchronize
 * with the display; high-refresh screens do not multiply simulation/drawing.
 * Sleeping resets elapsed simulation time, but not the frame-rate deadline.
 */
export function createPendantFrameLoop(draw: (now: number, dt: number) => boolean, driver: FrameDriver = {
  now: () => performance.now(), request: fn => requestAnimationFrame(fn), cancel: id => cancelAnimationFrame(id),
  delay: (fn, ms) => window.setTimeout(fn, ms), clear: id => window.clearTimeout(id),
}) {
  let running = false, frame: number | undefined, timer: number | undefined
  let interval = 1000 / DEFAULT_PENDANT_SETTINGS.fps
  let paintedAt: number | undefined, steppedAt: number | undefined, dueAt: number | undefined
  const cancelPending = (): void => {
    if (frame !== undefined) driver.cancel(frame)
    if (timer !== undefined) driver.clear(timer)
    frame = timer = undefined
  }
  const schedule = (): void => {
    if (!running || frame !== undefined || timer !== undefined) return
    const wait = dueAt === undefined ? 0 : dueAt - driver.now() - 8
    if (wait > 0) timer = driver.delay(() => { timer = undefined; if (running) frame = driver.request(tick) }, wait)
    else frame = driver.request(tick)
  }
  const tick = (now: number): void => {
    frame = undefined
    if (!running) return
    // Fractional display timestamps need a small rounding tolerance.
    if (dueAt !== undefined && now < dueAt - .5) { schedule(); return }
    const dt = steppedAt === undefined ? interval / 1000 : Math.min((now - steppedAt) / 1000, 1 / 15)
    paintedAt = steppedAt = now
    // Retain fractional cadence (e.g. 24 FPS on 60 Hz), without catch-up bursts.
    dueAt = (dueAt ?? now) + interval
    if (dueAt <= now + .5) dueAt = now + interval
    if (draw(now, dt) && running) schedule()
    else { running = false; steppedAt = undefined }
  }
  return {
    setFps(fps: PendantFps) {
      const next = 1000 / normalizePendantFps(fps)
      if (next === interval) return
      interval = next; dueAt = paintedAt === undefined ? undefined : paintedAt + interval
      cancelPending(); if (running) schedule()
    },
    wake() { if (!running) { running = true; schedule() } },
    stop() {
      running = false; steppedAt = undefined
      cancelPending()
    },
  }
}
