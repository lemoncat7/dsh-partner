import test from 'node:test'
import assert from 'node:assert/strict'
import { createPendantFrameLoop } from '../lib/pendant/frame-loop.js'

function fakeDisplay(hz) {
  let now = 0, nextId = 0
  const jobs = new Map()
  const queue = (fn, at) => { const id = ++nextId; jobs.set(id, { fn, at }); return id }
  return {
    driver: {
      now: () => now,
      request: fn => queue(fn, (Math.floor((now + .001) / (1000 / hz)) + 1) * 1000 / hz),
      cancel: id => jobs.delete(id), delay: (fn, ms) => queue(fn, now + ms), clear: id => jobs.delete(id),
    },
    advance(until) {
      let limit = 10000
      while (jobs.size) {
        const [id, job] = [...jobs].sort((a, b) => a[1].at - b[1].at)[0]
        if (job.at > until) break
        assert.ok(limit-- > 0, 'scheduler cannot busy-loop')
        now = job.at; jobs.delete(id); job.fn(now)
      }
      now = until
    },
    get pending() { return jobs.size },
  }
}

test('24/30/60 FPS cadence follows its target on 60/90/120/144 Hz displays', () => {
  for (const hz of [60, 90, 120, 144]) for (const fps of [24, 30, 60]) {
    const display = fakeDisplay(hz), frames = []
    const loop = createPendantFrameLoop((at, dt) => { frames.push({ at, dt }); return true }, display.driver)
    loop.setFps(fps)
    loop.wake()
    for (let at = 1; at <= 1000; at++) { display.advance(at); loop.wake() }
    assert.ok(frames.length >= fps - 1 && frames.length <= fps + 1, `${hz} Hz / ${fps} FPS: ${frames.length} draws`)
    assert.ok(frames.at(-1).at - frames[0].at >= (frames.length - 1) * 1000 / fps - 1000 / hz - .5)
    loop.stop(); assert.equal(display.pending, 0)
  }
})

test('live frame-rate changes keep one scheduled callback and preserve sleep', () => {
  const display = fakeDisplay(120), frames = []
  const loop = createPendantFrameLoop((at, dt) => { frames.push({ at, dt }); return true }, display.driver)
  loop.wake(); display.advance(1000)
  for (const [index, fps] of [24, 60, 30, 24].entries()) {
    const before = frames.length
    loop.setFps(fps); assert.ok(display.pending <= 1)
    display.advance((index + 2) * 1000)
    assert.ok(Math.abs(frames.length - before - fps) <= 1)
    assert.ok(frames.slice(before).every(frame => frame.dt <= 1 / 15))
  }
  loop.stop(); loop.setFps(60); assert.equal(display.pending, 0)
})

test('sleep and stop leave no polling, and wake does not catch up hidden time', () => {
  const display = fakeDisplay(120), frames = []
  const loop = createPendantFrameLoop((at, dt) => { frames.push({ at, dt }); return false }, display.driver)
  loop.wake(); display.advance(100)
  assert.equal(frames.length, 1); assert.equal(display.pending, 0)
  display.advance(10000); loop.wake(); display.advance(10100)
  assert.equal(frames.length, 2); assert.equal(frames[1].dt, 1 / 30)
  loop.wake(); loop.stop(); display.advance(10200)
  assert.equal(frames.length, 2); assert.equal(display.pending, 0)
})

test('rapid redraw requests cannot bypass the frame limit after sleeping', () => {
  const display = fakeDisplay(120), frames = []
  const loop = createPendantFrameLoop(at => { frames.push(at); return false }, display.driver)
  for (let at = 0; at <= 1000; at++) { display.advance(at); loop.wake() }
  assert.ok(frames.length <= 30)
  loop.stop(); assert.equal(display.pending, 0)
})
