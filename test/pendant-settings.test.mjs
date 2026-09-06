import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_PENDANT_SETTINGS, MAX_CARD_IMAGE_LENGTH, normalizePendantSettings, samePendantSettings } from '../lib/pendant/settings.js'
import { strapStyle } from '../lib/pendant/strap-style.js'

test('pendant settings validate local data without accepting external image URLs', () => {
  for (const input of [null, [], true, 'bad', { material: 'invalid', color: 'red', enabled: 0 }]) {
    assert.deepEqual(normalizePendantSettings(input), DEFAULT_PENDANT_SETTINGS)
  }
  const image = 'data:image/jpeg;base64,YWJj'
  assert.deepEqual(normalizePendantSettings({ enabled: false, material: 'leather', color: '#AABBCC', image }), { enabled: false, fps: 30, material: 'leather', color: '#aabbcc', image })
  for (const image of ['https://example.com/a.jpg', 'javascript:alert(1)', 'data:image/svg+xml,<svg/>', 'data:image/jpeg;base64,' + 'a'.repeat(MAX_CARD_IMAGE_LENGTH)]) assert.equal(normalizePendantSettings({ image }).image, '')
})

test('appearance comparison includes each field without serializing images', () => {
  assert.equal(samePendantSettings(DEFAULT_PENDANT_SETTINGS, { ...DEFAULT_PENDANT_SETTINGS }), true)
  for (const patch of [{ enabled: false }, { fps: 24 }, { material: 'braided' }, { color: '#112233' }, { image: 'changed' }]) assert.equal(samePendantSettings(DEFAULT_PENDANT_SETTINGS, { ...DEFAULT_PENDANT_SETTINGS, ...patch }), false)
})

test('frame rate migrates old settings to 30 and accepts only supported numeric choices', () => {
  for (const fps of [24, 30, 60]) assert.equal(normalizePendantSettings({ fps }).fps, fps)
  for (const fps of [undefined, null, 0, 144, '24', true]) assert.equal(normalizePendantSettings({ fps }).fps, 30)
})

test('rope material profiles provide bounded visual widths and reusable colors', () => {
  const profiles = ['woven', 'braided', 'leather'].map(material => strapStyle({ material, color: '#123456' }))
  assert.equal(new Set(profiles.map(p => p.width)).size, 3)
  for (const p of profiles) {
    assert.equal(p.band, '#123456')
    assert.match(p.edge, /^#[0-9a-f]{6}$/)
    assert.match(p.thread, /^#[0-9a-f]{6}$/)
    assert.ok(p.width > .1 && p.width < .25)
  }
})
