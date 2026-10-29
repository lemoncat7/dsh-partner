import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PartnerStore} from '../lib/store.js'

test('unchanged updates avoid disk commits; queued changes stay durable and notify once',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'partner-noop-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const initial=await PartnerStore.open(join(dir,'state.json'));let durable=initial.snapshot(),writes=0,notices=0,fail=false
 const store=await PartnerStore.openSplit({read:async()=>structuredClone(durable),write:async next=>{writes++;if(fail)throw Error('disk');durable=structuredClone(next)}})
 store.subscribe(()=>notices++,e=>assert.fail(e))
 await store.update(()=>{});assert.equal(writes,0);assert.equal(notices,0)
 await Promise.all([store.update(s=>s.recentReceipts.push('once')),store.update(s=>{if(!s.recentReceipts.includes('once'))s.recentReceipts.push('once')})])
 assert.equal(writes,1);assert.equal(notices,1);assert.deepEqual(durable.recentReceipts,['once'])
 const returned=await store.update(()=>{});returned.recentReceipts.push('not committed');assert.deepEqual(store.snapshot().recentReceipts,['once'])
 fail=true;await assert.rejects(store.update(s=>s.recentReceipts.push('lost')),/disk/);assert.deepEqual(store.snapshot().recentReceipts,['once'])
 fail=false;await store.update(s=>s.recentReceipts.push('retry'));assert.deepEqual(durable.recentReceipts,['once','retry'])
})
