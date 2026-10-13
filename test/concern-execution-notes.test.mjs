import test from 'node:test'
import assert from 'node:assert/strict'
import {concernExecutionNotes} from '../lib/concern-execution-notes.js'

function fixture() {
  const concern={id:'c',state:'watching',executionInstructions:'写草稿',resources:[{kind:'note',locator:'source'}],recordTarget:{kind:'note',locator:'result'}}
  const state={delegations:[{id:'d',status:'running',toCompanionId:'p',executionSessionId:'s',taskId:'t'}],tasks:[{id:'t',status:'doing',assigneeCompanionId:'p',requirementId:'r'}],planReceipts:[{key:'concern:c:fingerprint',requirementId:'r',tasks:[{id:'t'}]}]}
  const writes=[]
  const bridge={version:1,read:async id=>({id,name:id,content:'原文',revision:'v1'}),update:async(...args)=>{writes.push(args);return {ok:true}}}
  const input={store:{snapshot:()=>state},concerns:{list:async()=>[concern]},companionId:'p',sourceId:'d',sessionId:'s',bridge:()=>bridge}
  return {input,state,concern,writes,exec:{agent:{session:{id:'s'}}}}
}

test('temporary notes are bound to task, session and selected targets; source stays read-only',async()=>{
  const f=fixture(),grant=await concernExecutionNotes(f.input)
  assert.equal(grant.tools.length,2)
  const [read,record]=grant.tools
  assert.equal(JSON.parse(await read.execute({concernId:'c',noteId:'source'},f.exec)).content,'原文')
  await assert.rejects(read.execute({concernId:'c',noteId:'other'},f.exec),/不是当前关注/)
  await assert.rejects(read.execute({concernId:'c',noteId:'source'},{agent:{session:{id:'other'}}}),/不属于/)
  await assert.rejects(record.execute({concernId:'c',operation:'append',content:'新增',revision:'old'},f.exec),/已变化/)
  await record.execute({concernId:'c',operation:'append',content:'新增',revision:'v1'},f.exec)
  assert.deepEqual(f.writes[0].slice(0,3),['result','原文新增','v1'])
  grant.dispose()
  await assert.rejects(read.execute({concernId:'c',noteId:'source'},f.exec),/授权已结束/)
})

test('direct conversation receipt grants scoped notes without any board delegation',async()=>{
  const f=fixture()
  f.state.delegations=[];f.state.tasks=[];f.state.planReceipts=[]
  f.state.concernExecutions=[{id:'d',companionId:'p',sessionId:'s',concernId:'c',status:'running'}]
  const grant=await concernExecutionNotes(f.input)
  assert.equal(grant.tools.length,2)
  await grant.tools[0].execute({concernId:'c',noteId:'source'},f.exec)
  f.state.concernExecutions[0].status='completed'
  await assert.rejects(grant.tools[0].execute({concernId:'c',noteId:'source'},f.exec),/授权已结束/)
})

test('no general-session grant; closing concern, finishing task or changing targets revokes access',async()=>{
  for(const mutate of [f=>f.concern.executionInstructions=undefined,f=>f.state.tasks[0].status='done',f=>f.concern.resources=[],f=>f.concern.control='stopped']) {
    const f=fixture(),grant=await concernExecutionNotes(f.input);mutate(f)
    await assert.rejects(grant.tools[0].execute({concernId:'c',noteId:'source'},f.exec),/授权已结束/)
  }
  const f=fixture();f.input.sourceId='unknown'
  assert.equal((await concernExecutionNotes(f.input)).tools.length,0)
  f.input.sourceId='d';f.state.planReceipts=[]
  assert.equal((await concernExecutionNotes(f.input)).tools.length,0)
  f.state.planReceipts=[{key:'concern:c:f',requirementId:'r',tasks:[{id:'t'}]}];f.concern.recordTarget.locator='source'
  assert.equal((await concernExecutionNotes(f.input)).tools.length,1)
})
