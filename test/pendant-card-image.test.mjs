import assert from 'node:assert/strict'
import test from 'node:test'
import { cardImageRect } from '../lib/pendant/card-image.js'

test('image fitting preserves landscape, portrait and square source aspect ratios', () => {
  for (const [width, height] of [[1600,900],[900,1600],[1000,1000],[8,11],[1,1024]]) {
    for (const fit of ['contain','cover']) {
      const r = cardImageRect(width,height,512,704,fit)
      assert.ok(Math.abs(r.width/r.height-width/height)<1e-9)
      assert.ok(Math.abs(r.x*2+r.width-512)<1e-9)
      assert.ok(Math.abs(r.y*2+r.height-704)<1e-9)
      if (fit==='contain') assert.ok(r.x>=0&&r.y>=0&&r.width<=512+1e-9&&r.height<=704+1e-9)
      else assert.ok(r.width>=512-1e-9&&r.height>=704-1e-9)
    }
  }
})

test('image fitting rejects invalid sizes before touching canvas', () => {
  for (const size of [0,-1,NaN,Infinity]) assert.throws(()=>cardImageRect(size,1,512,704,'contain'),/尺寸无效/)
})
