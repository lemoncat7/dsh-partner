import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PartnerStore} from '../lib/store.js'
import {SplitStatePersistence} from '../lib/storage/split-state.js'
const thoughts=()=>Array.from({length:64},(_,i)=>({id:'t'+i,text:'念头'+i,why:'想试试',sourceTurnId:'turn'+i,sourceRouteIds:['r'],sourceAt:100+i,evidence:'原文'+i,targetRouteId:'r',createdAt:100+i,updatedAt:100+i,status:'open',attempts:0,result:'既有进展'}))
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'partner-thought-budget-'));t.after(()=>rm(root,{recursive:true,force:true}));return root}
test('legacy flat store durably retires excess thoughts without losing records or mutating identity',async t=>{
 const root=await fixture(t),path=join(root,'state.json'),initial=await PartnerStore.open(path),raw=initial.snapshot()
 raw.companions[0].thoughts=thoughts();const identity=raw.companions[0].updatedAt
 await writeFile(path,JSON.stringify(raw));const store=await PartnerStore.open(path),c=store.snapshot().companions[0]
 assert.equal(c.thoughts.length,64);assert.equal(c.thoughts.filter(t=>t.status==='open').length,12)
 assert.equal(c.thoughts.filter(t=>t.capacityArchivedAt).length,52);assert.equal(c.updatedAt,identity)
 assert.ok(c.thoughts.every(t=>t.evidence&&t.result==='既有进展'))
 const persisted=await readFile(path,'utf8');await PartnerStore.open(path);assert.equal(await readFile(path,'utf8'),persisted)
 const reopened=await PartnerStore.open(path);assert.deepEqual(reopened.snapshot(),store.snapshot())
 // Serialized writes cannot bypass the cap, even when callers do not use ThoughtService.
 await Promise.all(Array.from({length:20},(_,i)=>store.update(s=>s.companions[0].thoughts.push({...thoughts()[0],id:'new'+i,sourceAt:Date.now()+i}))))
 assert.equal(store.snapshot().companions[0].thoughts.filter(t=>t.status==='open').length,12)
 assert.equal(store.snapshot().companions[0].thoughts.length,64)
})
test('split persistence commits the migration once and does not touch unrelated state',async t=>{
 const root=await fixture(t),base=await PartnerStore.open(join(root,'initial.json')),raw=base.snapshot()
 raw.companions[0].thoughts=thoughts()
 const split=new SplitStatePersistence(join(root,'public'),id=>join(root,id))
 await split.write(raw);const before=await split.read(),store=await PartnerStore.openSplit(split),after=await split.read()
 assert.equal(after.companions[0].thoughts.filter(t=>t.status==='open').length,12)
 const expected=structuredClone(before);expected.companions[0].thoughts=after.companions[0].thoughts
 assert.deepEqual(after,expected);assert.deepEqual(after,store.snapshot())
 const reopened=await PartnerStore.openSplit(split);assert.deepEqual(reopened.snapshot(),after)
})
