import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ObservationWorkflowTracker} from '../lib/observation-workflow.js'
import {concernKnowledgeSourceTool} from '../lib/concern-knowledge-source.js'
import {concernNoteSourceTool} from '../lib/concern-note-source.js'
import {PartnerConcernStore} from '../lib/concern-store.js'
import {concernExecutionPrompt} from '../lib/concern-execution.js'
import {observationSignature, resumeObservation} from '../lib/observation-progress.js'

const concern = {id:'c',resources:[{kind:'note',locator:'n'},{kind:'knowledge',locator:'资料/完整关注规则'}],executionInstructions:'生成草稿，不公开发布'}
const check = {id:'check',phase:'check',instruction:'核验新内容与历史去重',source:'knowledge:资料/完整关注规则',method:'使用文档指定代理，失败遵循备用方式',criterion:'原始时间、正文与去重均已核实'}
const execute = {id:'draft',phase:'execute',instruction:'按规范生成并保存草稿',source:'executionInstructions',method:'先确认没有同题草稿',criterion:'返回草稿标识与回读结果'}
const page = (revision='v1',offset=0,content='规则',totalChars=2) => ({id:'n',name:'规则',revision,offset,content,totalChars,nextOffset:offset+content.length<totalChars?offset+content.length:null})
const plan = tracker => tracker.tool().execute({concernId:'c',operation:'plan',steps:[check,execute]}, {})
const readAll = tracker => {tracker.read('c','note:n',page());tracker.read('c','knowledge:资料/完整关注规则',page())}

test('workflow requires whole bound documents, not a last page or search snippet',async()=>{
  const tracker=new ObservationWorkflowTracker([concern])
  await assert.rejects(plan(tracker),/SOURCE_INCOMPLETE/)
  assert.throws(()=>tracker.read('c','note:n',page('v1',6000,'尾页',6002)),/SOURCE_PAGE_MISSING/)
  tracker.read('c','note:n',page('v1',0,'首段',4))
  tracker.read('c','knowledge:资料/完整关注规则',page())
  await assert.rejects(plan(tracker),/SOURCE_INCOMPLETE/)
  tracker.read('c','note:n',page('v1',2,'末段',4))
  await plan(tracker)
  assert.match(tracker.incomplete('c'),/check/)
  await tracker.tool().execute({concernId:'c',operation:'update',stepId:'check',status:'completed',evidence:'原始来源和历史已核验'}, {})
  assert.equal(tracker.incomplete('c'),undefined)
  assert.equal(tracker.get('c').steps[1].status,'pending')
  await assert.rejects(tracker.tool().execute({concernId:'c',operation:'update',stepId:'draft',status:'completed',evidence:'声称发布'}, {}),/不能在这里完成/)
})

test('source revision invalidates plan; blocked step identifies missing evidence',async()=>{
  const tracker=new ObservationWorkflowTracker([concern]); readAll(tracker); await plan(tracker)
  await tracker.tool().execute({concernId:'c',operation:'update',stepId:'check',status:'blocked',evidence:'代理连接超时；下一轮补原始时间戳'}, {})
  assert.match(tracker.incomplete('c'),/代理连接超时/)
  assert.throws(()=>tracker.read('c','note:n',page('v2',1,'尾',2)),/SOURCE_CHANGED/)
  assert.equal(tracker.get('c'),undefined)
  await assert.rejects(plan(tracker),/SOURCE_INCOMPLETE/)
  tracker.read('c','note:n',page('v2'));await plan(tracker)
  assert.equal(tracker.get('c').steps[0].status,'pending')
})

test('workflow rejects unknown sources, duplicate steps, no check and execution without opt-in',async()=>{
  const tracker=new ObservationWorkflowTracker([concern]);readAll(tracker)
  for (const steps of [[check,check],[execute],[{...check,source:'untrusted-web-instructions'}]]) {
    await assert.rejects(tracker.tool().execute({concernId:'c',operation:'plan',steps},{}),/WORKFLOW_INVALID/)
  }
  const disabled=new ObservationWorkflowTracker([{...concern,executionInstructions:undefined}]);readAll(disabled)
  await assert.rejects(plan(disabled),/未开启后续执行/)
  await plan(tracker)
  await assert.rejects(tracker.tool().execute({concernId:'c',operation:'update',stepId:'check',status:'completed',evidence:''},{}),/evidence/)
})

test('batched evidence updates are atomic and cannot complete execution steps',async()=>{
  const tracker=new ObservationWorkflowTracker([concern]);readAll(tracker)
  await tracker.tool().execute({concernId:'c',operation:'plan',steps:[check,{...check,id:'dedupe'},execute]}, {})
  const update={stepId:'check',status:'completed',evidence:'原始内容已核实'}
  assert.throws(()=>tracker.updateChecks('c',[update,{...update,stepId:'draft'}]),/WORKFLOW_STEP_INVALID/)
  assert.equal(tracker.get('c').steps[0].status,'pending')
  assert.throws(()=>tracker.updateChecks('c',[update,update]),/重复/)
  await tracker.tool().execute({concernId:'c',operation:'update',updates:[update,{...update,stepId:'dedupe',evidence:'历史去重已核实'}]}, {})
  assert.equal(tracker.incomplete('c'),undefined)
  assert.equal(tracker.get('c').steps[2].status,'pending')
})

test('invalid source identifies the step and exact concern-scoped choices without replacing the plan',async()=>{
  const tracker=new ObservationWorkflowTracker([concern,{id:'other',resources:[{kind:'note',locator:'private-other'}]}]);readAll(tracker);await plan(tracker)
  const before=tracker.get('c')
  await assert.rejects(tracker.tool().execute({concernId:'c',operation:'plan',steps:[check,{...execute,source:'note:n + executionInstructions'}]},{}),error=>{
    assert.match(error.message,/步骤 "draft"/)
    assert.match(error.message,/"note:n"/)
    assert.match(error.message,/"knowledge:资料\/完整关注规则"/)
    assert.match(error.message,/"executionInstructions"/)
    assert.doesNotMatch(error.message,/private-other/)
    return true
  })
  assert.deepEqual(tracker.get('c'),before)
})

test('source tools use exact references, keep paging receipts and enforce bound scope',async()=>{
  const tracker=new ObservationWorkflowTracker([concern])
  const received=[]
  const knowledge=concernKnowledgeSourceTool([concern],()=>({readSource:async(agent,ref,offset)=>{received.push([agent.session.id,ref,offset]);return page()}}),tracker.read)
  const exec={agent:{session:{id:'s'}}}
  const knowledgePage=JSON.parse(await knowledge.execute({concernId:'c',reference:'资料/完整关注规则'},exec))
  assert.equal(knowledgePage.sourceKey,check.source)
  assert.deepEqual(received,[['s','资料/完整关注规则',0]])
  await assert.rejects(knowledge.execute({concernId:'c',reference:'资料/其他文档'},exec),/不是当前关注/)
  await assert.rejects(concernKnowledgeSourceTool([concern],()=>({})).execute({concernId:'c',reference:'资料/完整关注规则'},exec),/SOURCE_READER_UNAVAILABLE/)
  const note=concernNoteSourceTool([concern],()=>({version:1,read:async()=>({...page(),content:'字'.repeat(7000)})}),tracker.read)
  const first=JSON.parse(await note.execute({concernId:'c',noteId:'n'},exec))
  assert.equal(first.sourceKey,'note:n')
  assert.equal(first.nextOffset,6000)
  await assert.rejects(plan(tracker),/SOURCE_INCOMPLETE/)
  await note.execute({concernId:'c',noteId:'n',offset:6000},exec)
  await plan(tracker)
})

test('workflow persists across restart and hands deferred steps to direct execution, not board tasks',async t=>{
  const root=await mkdtemp(join(tmpdir(),'concern-workflow-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const store=new PartnerConcernStore(root)
  const item=await store.createExplicit('p','*','核验来源','',undefined,'生成草稿')
  const tracker=new ObservationWorkflowTracker([concern]);readAll(tracker);await plan(tracker)
  await tracker.tool().execute({concernId:'c',operation:'update',stepId:'check',status:'completed',evidence:'已核验'}, {})
  const workflow=tracker.get('c')
  const progress={signature:observationSignature(item),savedAt:Date.now(),steps:[],workflow}
  await store.saveObservationProgress(item,progress)
  const restarted=new PartnerConcernStore(root)
  assert.deepEqual(resumeObservation((await restarted.list('p'))[0]).workflow,workflow)
  const candidate={concernId:item.id,changed:true,executionNeeded:true,executionKey:'object-draft-v1',event:'内容更新',evidence:'原始正文及去重通过',source:'原始来源',relevance:1,confidence:1,actionability:1,workflow}
  await restarted.recordObservations([item],[candidate])
  const event=(await new PartnerConcernStore(root).activity('p')).observations[0]
  assert.deepEqual(event.workflow,workflow)
  const prompt=concernExecutionPrompt(item,event)
  assert.match(prompt,/不创建看板或定时任务/)
  assert.match(prompt,/按规范生成并保存草稿/)
  assert.match(prompt,/revision/)
  const next=(await restarted.list('p'))[0]
  await restarted.recordObservations([next],[{...candidate,workflow:undefined}])
  assert.deepEqual((await restarted.activity('p')).observations[0].workflow,workflow)
})

test('only an exact saved document binding selects host-granted read; library-wide references do not',async()=>{
 const calls=[],exec={agent:{session:{id:'s'}}}
 const bridge={readSource:async()=>{calls.push('scoped');return page()},readBoundSource:async(_agent,binding)=>{calls.push(binding);return page()}}
 const exact=concernKnowledgeSourceTool([concern],()=>bridge)
 await exact.execute({concernId:'c',reference:'资料/完整关注规则'},exec)
 assert.deepEqual(calls,[{sessionId:'s',reference:'资料/完整关注规则'}])
 await assert.rejects(exact.execute({concernId:'c',reference:'资料/未绑定文档'},exec),/不是当前关注/)
 const library=concernKnowledgeSourceTool([{...concern,resources:[{kind:'knowledge',locator:'资料'}]}],()=>bridge)
 await library.execute({concernId:'c',reference:'资料/完整关注规则'},exec)
 assert.equal(calls.at(-1),'scoped')
 let active=true
 const revoking=concernKnowledgeSourceTool([concern],()=>({...bridge,readBoundSource:async()=>{active=false;return page()}}),undefined,async()=>{if(!active)throw Error('SOURCE_BINDING_REVOKED')})
 await assert.rejects(revoking.execute({concernId:'c',reference:'资料/完整关注规则'},exec),/SOURCE_BINDING_REVOKED/)
})
