import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PartnerStore } from '../lib/store.js'
import { TaskBoardService } from '../lib/tasks/service.js'
import { PartnerCollaborationService } from '../lib/collaboration/service.js'
import { PartnerAgentComposition } from '../lib/collaboration/composition.js'
import { SkillService } from '../lib/skills/service.js'
import { SkillRepository } from '../lib/skills/repository.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'partner-dispatch-'))
  const store = await PartnerStore.open(join(root, 'state.json'))
  const board = new TaskBoardService(store)
  const skills = new SkillService(store, new SkillRepository(join(root, 'skills')))
  const service = new PartnerCollaborationService(store, skills, board, {})
  const calls = []
  service.setSessionExecutor({ execute: async input => { calls.push(input); return {run:{id:'run-'+calls.length}, output:'真实产出'} } })
  t.after(async () => { await service.close(); await rm(root,{recursive:true,force:true}) })
  return {root,store,board,skills,service,calls}
}
const waitFor = async predicate => {
  for(let i=0;i<200;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10))}
  assert.fail('condition did not become true')
}
const actor={kind:'companion',companionId:'companion-default'}
const assigned={assigneeCompanionId:'companion-default',autoRun:true}

test('assigned create tool submits automatically, reports the Skill protocol, and honors planning-only', async t=>{
  const {store,board,skills,service,calls}=await fixture(t)
  await skills.initialize();await skills.installMarket('builtin','task-planning');await skills.setBinding('companion-default','task-planning',true)
  await store.update(s=>{s.companions[0].capabilities=['skills']})
  const tools=[],sections=[]
  const composition=new PartnerAgentComposition(store,skills,board,service,{},{},{})
  await composition.compose({tools:{register:tool=>{tools.push(tool);return()=>{}}},systemPrompt:{section:section=>{sections.push(section);return()=>{}}}},store.snapshot().companions[0])
  assert.match(sections.map(s=>s.text).join('\n'),/主动应用/)
  assert.match(sections.map(s=>s.text).join('\n'),/无需用户再要求|不需要再询问/)
  const tool=tools.find(t=>t.name==='partner_task_board'),exec={agent:{session:{id:'creator-session'}}}
  const planned=JSON.parse(await tool.execute({action:'create',title:'先规划',assignee:'companion-default',autoRun:false},exec))
  assert.equal(planned.execution,'planning-only');assert.equal(planned.status,'backlog')
  const work=JSON.parse(await tool.execute({action:'create',title:'交付任务',assignee:'companion-default'},exec))
  assert.equal(work.execution,'submitted');assert.equal(work.autoRun,true)
  await waitFor(()=>board.require(work.id).status==='review')
  assert.equal(calls.length,1);assert.equal(board.require(planned.id).status,'backlog')
})

test('four dependent tasks are submitted once and advance only after all prerequisites pass review',async t=>{
  const {board,service,calls,store}=await fixture(t)
  const a=await board.create({title:'收集',...assigned},actor)
  const b=await board.create({title:'核验',...assigned,dependencyTaskIds:[a.id]},actor)
  const c=await board.create({title:'另一路收集',...assigned},actor)
  const d=await board.create({title:'汇总',...assigned,dependencyTaskIds:[b.id,c.id]},actor)
  await service.dispatchReadyTasks()
  await waitFor(()=>board.require(a.id).status==='review'&&board.require(c.id).status==='review')
  assert.equal(calls.length,2);assert.equal(board.require(b.id).status,'ready');assert.equal(board.require(d.id).status,'ready')
  assert.equal(store.snapshot().delegations.length,4)
  await service.dispatchReadyTasks();assert.equal(calls.length,2)
  await board.accept(a.id,actor);await service.dispatchReadyTasks()
  await waitFor(()=>board.require(b.id).status==='review')
  await board.accept(b.id,actor);await service.dispatchReadyTasks();assert.equal(calls.length,3)
  await board.accept(c.id,actor);await service.dispatchReadyTasks()
  await waitFor(()=>board.require(d.id).status==='review');assert.equal(calls.length,4)
  assert.match(calls[3].prompt,/已验收前置任务的公开产出/)
  assert.match(calls[3].prompt,/真实产出/)
  assert.equal(store.snapshot().delegations.length,4)
})

test('explicit delegation accepts pending dependencies, repeated submissions share one job, and revocation stops it',async t=>{
  const {board,service,calls,store}=await fixture(t)
  await store.update(s=>s.companions.push({...structuredClone(s.companions[0]),id:'worker',name:'执行者'}))
  await service.replaceAccessTargets('companion-default',['worker'])
  const parent=await board.create({title:'前置'},{kind:'user'})
  const work=await board.create({title:'后续',dependencyTaskIds:[parent.id]},actor)
  const input={taskId:work.id,initiatedBy:'companion',fromCompanionId:'companion-default',to:'worker',request:'实际执行'}
  const jobs=await Promise.all([service.delegate(input),service.delegate(input)])
  assert.equal(jobs[0].id,jobs[1].id);assert.equal(jobs[0].status,'queued');assert.equal(calls.length,0)
  await service.replaceAccessTargets('companion-default',[]);await service.dispatchReadyTasks()
  assert.equal(calls.length,0);assert.equal(board.require(work.id).status,'blocked')
  assert.match(store.snapshot().delegations[0].error,/授权已撤回/)
})

test('durable execution intent survives restart, without starting legacy ready tasks',async t=>{
  const {root,board,service}=await fixture(t)
  const legacy=await board.create({title:'旧任务',status:'ready',assigneeCompanionId:'companion-default'},{kind:'user'})
  const work=await board.create({title:'提交后立即重启',...assigned},actor)
  await service.close()
  const restored=await PartnerStore.open(join(root,'state.json')), tasks=new TaskBoardService(restored)
  const second=new PartnerCollaborationService(restored,{},tasks,{execute:async()=>({run:{id:'restored'},output:'重启后执行'})})
  t.after(()=>second.close())
  await second.start();await waitFor(()=>tasks.require(work.id).status==='review')
  assert.equal(tasks.require(legacy.id).status,'ready')
})

test('direct submissions obey the shared concurrency limit',async t=>{
  const {board,service,store}=await fixture(t)
  let release;const pending=new Promise(resolve=>{release=resolve});let running=0,peak=0
  service.setSessionExecutor({execute:async()=>{running++;peak=Math.max(peak,running);await pending;running--;return{run:{id:'bounded'},output:'完成'}}})
  try {
  const tasks=[];for(let i=0;i<5;i++)tasks.push(await board.create({title:'并行 '+i},{kind:'user'}))
  await Promise.all(tasks.map(task=>service.delegate({taskId:task.id,initiatedBy:'user',to:'companion-default',request:'执行'})))
  assert.equal(peak,3);assert.equal(store.snapshot().delegations.filter(d=>d.status==='queued').length,2)
  release();await waitFor(()=>running===0);await waitFor(()=>store.snapshot().delegations.filter(d=>d.status==='running').length===0)
  await service.dispatchReadyTasks();await waitFor(()=>tasks.every(t=>board.require(t.id).status==='review'))
  assert.ok(peak<=3)
  } finally { release() }
})

test('switching submitted work to planning-only cancels waiting execution without affecting other tasks',async t=>{
  const {board,service,calls,store}=await fixture(t)
  const parent=await board.create({title:'前置'},{kind:'user'})
  const child=await board.create({title:'暂不执行',...assigned,dependencyTaskIds:[parent.id]},actor)
  await service.dispatchReadyTasks()
  const current=board.require(child.id)
  await board.update(child.id,{expectedRevision:current.revision,autoRun:false},actor)
  assert.equal(store.snapshot().delegations[0].status,'canceled')
  const p=await board.update(parent.id,{expectedRevision:1,status:'doing'},{kind:'user'})
  await board.completeExecution(p.id,'产出',actor);await board.accept(p.id,actor)
  await service.dispatchReadyTasks();assert.equal(calls.length,0)
  assert.equal(board.require(child.id).status,'ready')
})

test('removing the assignee while queued prevents dispatch to the old companion',async t=>{
  const {board,service,calls,store}=await fixture(t)
  const parent=await board.create({title:'前置'},{kind:'user'})
  const child=await board.create({title:'取消负责人',...assigned,dependencyTaskIds:[parent.id]},actor)
  await service.dispatchReadyTasks()
  await board.update(child.id,{expectedRevision:board.require(child.id).revision,assigneeCompanionId:''},actor)
  const p=await board.update(parent.id,{expectedRevision:1,status:'doing'},{kind:'user'})
  await board.completeExecution(p.id,'产出',actor);await board.accept(p.id,actor)
  await service.dispatchReadyTasks()
  assert.equal(calls.length,0);assert.equal(store.snapshot().delegations[0].status,'canceled')
})
