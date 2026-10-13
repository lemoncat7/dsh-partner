import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createSnapshotCache} from '../lib/snapshot-cache.js'

test('snapshot reads deduplicate and expose a memory-only initial value', async()=>{
  let calls=0
  const cache=createSnapshotCache(async()=>({version:++calls}))
  assert.equal(cache.peek(),undefined)
  const [a,b]=await Promise.all([cache.load(),cache.load()])
  assert.equal(calls,1); assert.equal(a,b); assert.equal(cache.peek(),a)
  await cache.load(); assert.equal(calls,2)
  cache.invalidate(); assert.equal(cache.peek(),undefined)
})
test('a pre-mutation read cannot replace the post-mutation snapshot',async()=>{
  const resolvers=[]
  const cache=createSnapshotCache(()=>new Promise(resolve=>resolvers.push(resolve)))
  const old=cache.load()
  cache.invalidate()
  const fresh=cache.load()
  resolvers[0]('old')
  await Promise.resolve()
  resolvers[1]('new')
  assert.equal(await old,'new');assert.equal(await fresh,'new');assert.equal(cache.peek(),'new')
})
test('expired cache is not displayed; failed reads can retry',async()=>{
  let calls=0
  const cache=createSnapshotCache(async()=>{if(++calls===1)throw Error('offline');return 'ok'},-1)
  await assert.rejects(cache.load(),/offline/)
  assert.equal(await cache.load(),'ok');assert.equal(cache.peek(),undefined)
})
