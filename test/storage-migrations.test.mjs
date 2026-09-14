import test from 'node:test'
import assert from 'node:assert/strict'
import { migrationPath, runMigrationPath, storageMigrations } from '../lib/storage/migrations/index.js'
const step = (from, events) => ({id:`v${from}-to-v${from+1}`,from,to:from+1,title:'test',execute:async()=>{events.push(`execute${from}`)},verify:async()=>{events.push(`verify${from}`)}})

test('versioned migration registry resolves ordered chain and skips committed versions',()=>{
 const events=[];const steps=[step(1,events),step(0,events),step(2,events)]
 assert.deepEqual(migrationPath(steps,0,3).map(s=>s.from),[0,1,2])
 assert.deepEqual(migrationPath(steps,2,3).map(s=>s.from),[2])
 assert.deepEqual(migrationPath(steps,3,3),[])
})
test('registry rejects missing, duplicate, jumping and downgrade versions',()=>{
 const steps=[step(0,[])]
 assert.throws(()=>migrationPath(steps,0,2),/缺少/)
 assert.throws(()=>migrationPath([...steps,...steps],0,1),/重复/)
 assert.throws(()=>migrationPath([{...steps[0],to:2}],0,2),/逐版本/)
 assert.throws(()=>migrationPath(steps,2,1),/降级/)
})
test('each step executes then verifies then durably commits before next version',async()=>{
 const events=[]
 await runMigrationPath([step(0,events),step(1,events)],0,2,{},async(from,to)=>{events.push(`commit${from}:${to}`)})
 assert.deepEqual(events,['execute0','verify0','commit0:1','execute1','verify1','commit1:2'])
})
test('verification or commit failure stops subsequent versions',async()=>{
 for(const phase of ['execute','verify','commit']) {
  const events=[];const first=step(0,events)
  if(phase!=='commit')first[phase]=async()=>{throw Error('injected')}
  await assert.rejects(runMigrationPath([first,step(1,events)],0,2,{},async()=>{if(phase==='commit')throw Error('injected');events.push('committed')}),/injected/)
  assert.equal(events.includes('execute1'),false);assert.equal(events.includes('committed'),false)
 }
})
test('inspection-only future step cannot execute or commit a new version',async()=>{
 let committed=false
 await assert.rejects(runMigrationPath([{id:'future',from:0,to:1,title:'pending'}],0,1,{},async()=>{committed=true}),/尚未全部实现/)
 assert.equal(committed,false)
})
test('v0-to-v1 has its own executable implementation and verification',()=>{
 assert.equal(storageMigrations[0].from,0);assert.equal(storageMigrations[0].to,1)
 assert.equal(typeof storageMigrations[0].execute,'function');assert.equal(typeof storageMigrations[0].verify,'function')
})
test('an incomplete later step blocks the whole chain before any writes',async()=>{
 const events=[]
 await assert.rejects(runMigrationPath([step(0,events),{id:'v1-to-v2',from:1,to:2,title:'pending'}],0,2,{},async()=>{}),/尚未全部实现/)
 assert.deepEqual(events,[])
})
