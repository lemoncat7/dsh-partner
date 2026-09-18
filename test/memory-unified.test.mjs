import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PartnerMemoryStore } from '../lib/memory-store.js'
import { conversationMemoryScope } from '../lib/memory-scope.js'
import { requireGroundedMemories } from '../lib/memory-quality.js'
import { MemoryReflectionService, parseReflection } from '../lib/memory-reflection.js'
import { buildProfileSnapshot } from '../lib/profile-domain.js'
import { PartnerConcernStore } from '../lib/concern-store.js'

const daily = {summary:'原日记',events:[],openTasks:[],completedTasks:[],learnings:[]}
const result = {daily,memories:[],concerns:[]}
const turn = (id,scopeId='owner',at=Date.now()) => ({id,scopeId,companionId:'c',sessionId:'s',at,user:'我平时用 macOS',assistant:'收到'})
const candidate = {kind:'profile',subject:'常用环境',content:'用户平时使用 macOS',operation:'upsert',confidence:.95,importance:.8,evidenceQuote:'我平时用 macOS',sourceTurnId:'one'}
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'partner-unified-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  return {root,store:new PartnerMemoryStore(root)}
}
async function complete(store,source,memories=[]) {
  await store.enqueue(source)
  const job=await store.claimJob('c',Date.now()+1000)
  assert.equal(job.turn.id,source.id)
  await store.checkpointJob(job,{...result,memories})
  await store.consolidate(source,{...result,memories},job)
  await store.settleJob(job)
}

test('memory scope follows actual unified conversation, not channel name',()=>{
  const local={kind:'local',companionId:'c',sessionId:'s',channelId:'@local',userId:'owner:c'}
  const matrix={kind:'channel',companionId:'c',sessionId:'s',channelId:'matrix',userId:'u'}
  assert.equal(conversationMemoryScope(matrix,[matrix,local]),'@local:owner:c')
  assert.equal(conversationMemoryScope({...matrix,sessionId:'separate'},[local]),'matrix:u')
  assert.equal(conversationMemoryScope({...matrix,companionId:'other'},[local]),'matrix:u')
})

test('linked memory migration preserves histories and combines same-day summaries once',async t=>{
  const {store}=await fixture(t)
  await complete(store,turn('one','matrix'),[candidate])
  await complete(store,turn('two','owner'))
  await complete(store,turn('three','unrelated'))
  await store.mergeScopes('c','owner',['matrix'])
  await store.mergeScopes('c','owner',['matrix'])
  assert.equal((await store.profileSnapshot('c','owner')).entries.length,1)
  assert.equal((await store.recentMemories('c',100,'matrix')).length,0)
  const history=await store.history('c','owner')
  assert.equal(history.length,2)
  assert.equal(history.find(item=>item.id==='one').concernScopeId,'matrix')
  assert.equal(history.find(item=>item.id==='one').scopeId,'owner')
  assert.equal((await store.history('c','unrelated')).length,1)
  assert.equal((await store.recentReflectionsForScope('c','owner'))[0].turnCount,2)
})

test('repair survives restart without duplicate diaries, notifications, or evidence',async t=>{
  const {store,root}=await fixture(t)
  await complete(store,turn('one'))
  assert.equal(await store.scheduleProfileRepair('c','owner'),1)
  assert.equal(await store.scheduleProfileRepair('c','owner'),0)
  const job=await store.claimJob('c')
  assert.equal(job.repair,true)
  const restored={...result,memories:requireGroundedMemories([candidate],[job.turn])}
  await store.checkpointJob(job,restored)
  await store.restoreProfileJob(job,restored)
  await store.settleJob(job,'interrupted after commit')
  const reopened=new PartnerMemoryStore(root)
  const retry=await reopened.claimJob('c',Date.now()+60000)
  await reopened.restoreProfileJob(retry,retry.result)
  await reopened.settleJob(retry)
  assert.equal((await reopened.profileSnapshot('c','owner')).entries[0].evidence.length,1)
  assert.equal((await reopened.recentReflectionsForScope('c','owner'))[0].turnCount,1)
  assert.equal((await reopened.history('c','owner')).length,1)
  assert.equal(await reopened.scheduleProfileRepair('c','owner'),0)
})

test('fresh turns have priority over bounded historical repair',async t=>{
  const {store}=await fixture(t)
  for(let i=0;i<33;i++) await complete(store,turn(`old-${i}`,'owner',Date.now()-100000+i))
  assert.equal(await store.scheduleProfileRepair('c','owner'),30)
  await store.enqueue(turn('new'))
  assert.equal((await store.claimJob('c')).turn.id,'new')
})

test('missing evidence retries instead of silently completing an empty extraction',async t=>{
  const {store,root}=await fixture(t)
  let valid=false
  const ctx={logger:{warn(){}},agentDefaultModel:{currentSelection:()=>({provider:'test',model:'test'})},llm:{async *stream(input){
    assert.match(input.system,/evidenceQuote/)
    assert.match(input.system,/sourceTurnId/)
    yield {type:'text-delta',text:JSON.stringify({...result,memories:[valid?candidate:{...candidate,evidenceQuote:''}]})}
  }}}
  const service=new MemoryReflectionService(ctx,store,new PartnerConcernStore(root))
  const companion={id:'c',automation:{memory:{enabled:true,retentionDays:90}},capabilities:{}}
  await store.enqueue(turn('one'))
  await assert.rejects(service.processPending(companion),/记忆证据校验失败/)
  assert.equal((await store.memoryLayers('c','owner')).retryCount,1)
  valid=true
  await store.retryJob('c','owner','one')
  await service.processPending(companion)
  assert.equal((await store.profileSnapshot('c','owner')).entries.length,1)
  assert.equal((await store.memoryLayers('c','owner')).jobCount,0)
})

test('malformed profile candidates fail extraction rather than becoming empty success',()=>{
  assert.throws(()=>parseReflection(JSON.stringify({...result,memories:[{...candidate,subject:'unsupported profile slot'}]}),true),/记忆候选格式无效/)
  assert.throws(()=>parseReflection(JSON.stringify({...result,memories:{}}),true),/记忆候选格式无效/)
})

test('live scope migration waits for extraction and rolls back without changing memory',async t=>{
  const {store}=await fixture(t)
  await complete(store,turn('one','matrix'),[candidate])
  await store.enqueue(turn('two','owner'))
  const job=await store.claimJob('c')
  await assert.rejects(store.mergeScopes('c','owner',['matrix']),/正在整理/)
  assert.equal((await store.profileSnapshot('c','matrix')).entries.length,1)
  await store.settleJob(job)
  await store.mergeScopes('c','owner',['matrix'])
  assert.equal((await store.profileSnapshot('c','owner')).entries.length,1)
})

test('high confidence evidenced preference can appear after one explicit statement',()=>{
  const base={id:'p',companionId:'c',scopeId:'owner',kind:'preference',subject:'协作方式',content:'今后先给方案再实施',status:'active',confidence:.97,importance:.85,createdAt:1,updatedAt:1,
    evidence:[{turnId:'one',at:1,excerpt:'今后先给方案再实施'}]}
  assert.equal(buildProfileSnapshot('c','owner',[base]).preferences.length,1)
  assert.equal(buildProfileSnapshot('c','owner',[{...base,evidence:[]}]).preferences.length,0)
  assert.equal(buildProfileSnapshot('c','owner',[{...base,confidence:.85}]).preferences.length,0)
})

test('historical repair service does not replay concerns or overwrite newer facts',async t=>{
  const {store,root}=await fixture(t)
  await complete(store,turn('one','owner',Date.now()-1000))
  await complete(store,turn('two'),[{...candidate,content:'用户已改用 Linux',sourceTurnId:'two'}])
  await store.scheduleProfileRepair('c','owner')
  const ctx={agentDefaultModel:{currentSelection:()=>({provider:'test',model:'test'})},llm:{async *stream(){yield {type:'text-delta',text:JSON.stringify({...result,memories:[candidate]})}}}}
  const service=new MemoryReflectionService(ctx,store,new PartnerConcernStore(root))
  service.applyConcerns=async()=>{throw new Error('repair must not create concerns')}
  await service.processPending({id:'c',automation:{memory:{enabled:true,retentionDays:90}}},async()=>{throw new Error('repair must not notify')})
  assert.equal((await store.profileSnapshot('c','owner')).entries[0].content,'用户已改用 Linux')
  assert.equal((await store.recentReflectionsForScope('c','owner'))[0].turnCount,2)
})
