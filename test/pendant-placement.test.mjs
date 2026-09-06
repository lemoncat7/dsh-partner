import assert from 'node:assert/strict'
import test from 'node:test'
import { readerPlacement } from '../lib/pendant/use-placement.js'

test('reader stays beside its card when there is room', () => {
  assert.deepEqual(readerPlacement({ x: 500, y: 220, width: 84, height: 116 }, { width: 1440, height: 960 }), {
    width: 360, maxHeight: 480, left: 124, top: 208,
  })
})

test('reader stays reachable at all edges on narrow and landscape viewports', () => {
  for (const viewport of [{ width: 375, height: 667 }, { width: 667, height: 375 }, { width: 320, height: 240 }]) {
    for (const anchor of [{ x: -100, y: -100 }, { x: 1400, y: 950 }, { x: 180, y: 180 }]) {
      const rect = readerPlacement({ ...anchor, width: 84, height: 116 }, viewport)
      assert.ok(rect.left >= 12 && rect.top >= 16)
      assert.ok(rect.left + rect.width <= viewport.width - 12)
      assert.ok(rect.top + rect.maxHeight <= viewport.height - 16)
    }
  }
})

test('reader chooses the right when there is no space left, and vertical space on phones', () => {
  for (const viewport of [{ width: 1440, height: 960 }, { width: 375, height: 667 }]) {
    for (const anchor of [{ x: 30, y: 220, width: 84, height: 116 }, { x: 160, y: 480, width: 68, height: 94 }]) {
      const rect = readerPlacement(anchor, viewport)
      assert.ok(rect.left + rect.width <= anchor.x || rect.left >= anchor.x + anchor.width || rect.top + rect.maxHeight <= anchor.y || rect.top >= anchor.y + anchor.height, 'does not overlap the card')
    }
  }
})
