import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PartnerStore} from '../lib/store.js'
import {ConcernExecutionDispatcher, concernExecutionPrompt} from '../lib/concern-execution.js'
import {PartnerConcernStore} from '../lib/concern-store.js'

test('execution configuration persists atomically, defaults off, preserves omission and supports disabling',async t=>{
  const root=await mkdtemp(join(tmpdir(),'concern-config-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const store=new PartnerConcernStore(root)
  let item=await store.createExplicit('c','*','关注版本')
  assert.equal(item.executionInstructions,undefined)
  item=await store.createExplicit('c','*','关注版本','检查发布',undefined,'上传草稿，不公开发布')
  assert.equal(item.executionInstructions,'上传草稿，不公开发布')
  item=await store.createExplicit('c','*','关注版本')
  assert.equal(item.executionInstructions,'上传草稿，不公开发布')
  assert.equal((await new PartnerConcernStore(root).list('c'))[0].executionInstructions,item.executionInstructions)
  await assert.rejects(store.createExplicit('c','*','非法配置','',undefined,'  '),/后续执行要求/)
  assert.equal((await store.list('c')).length,1)
  item=await store.editExplicit('c',item.id,{subject:item.subject,reason:item.reason,sources:'',expectedUpdatedAt:item.updatedAt,executionInstructions:null})
  assert.equal(item.executionInstructions,undefined)
  assert.equal((await new PartnerConcernStore(root).list('c'))[0].executionInstructions,undefined)
})

test('direct concern delivery creates no board task and keeps persistent deduplication',async t=>{
  const root=await mkdtemp(join(tmpdir(),'concern-execution-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const path=join(root,'state.json'),store=await PartnerStore.open(path),id=store.snapshot().companions[0].id
  await store.update(s=>s.sessions.push({id:'r',companionId:id,kind:'local',channelId:'@local',userId:'u',sessionId:'s',lastMessageAt:0}))
  const concern={id:'watch',subject:'选题草稿',state:'watching',scopeId:'@local:u',resources:[]}
  const event={concernId:'watch',fingerprint:'first',event:'项目更新',evidence:'项目更新',source:'https://github.com/example/repo'}
  const concerns={activity:async()=>({concerns:[concern],observations:[event]})}
  let calls=0,finish
  const executor={executeConcern:async(receipt)=>{calls++;await new Promise(r=>finish=r);await store.update(s=>s.concernExecutions.find(r=>r.id===receipt.id).status='completed')}}
  const dispatch=new ConcernExecutionDispatcher(store,concerns,executor)
  await dispatch.dispatch(id);assert.equal(calls,0)
  concern.executionInstructions='仅生成并上传公众号草稿，不公开发布。'
  await dispatch.dispatch(id);assert.equal(calls,1)
  await dispatch.dispatch(id);assert.equal(calls,1)
  assert.equal(store.snapshot().tasks.length,0);assert.equal((store.snapshot().planReceipts??[]).length,0)
  finish();await new Promise(r=>setTimeout(r,30))
  const restored=await PartnerStore.open(path)
  await new ConcernExecutionDispatcher(restored,concerns,{executeConcern:async()=>{throw Error('must not redeliver')}}).dispatch(id)
  assert.equal(restored.snapshot().concernExecutions.length,1)
  const prompt=concernExecutionPrompt(concern,event)
  assert.equal(prompt.split('项目更新').length-1,1)
  assert.ok(!prompt.includes('resultSummary'))
  assert.ok(prompt.includes('仅生成并上传公众号草稿'))
})
