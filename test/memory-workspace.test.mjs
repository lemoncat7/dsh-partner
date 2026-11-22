import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PartnerMemoryStore} from '../lib/memory-store.js'
import {MemoryReflectionService} from '../lib/memory-reflection.js'
import {preferenceEmphasisLabel} from '../lib/memory-evidence.js'

async function fixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'memory-workspace-'))
  t.after(()=>rm(dir,{recursive:true,force:true}))
  return new PartnerMemoryStore(dir,'Asia/Shanghai')
}
const turn=(id,at,user,scopeId='owner')=>({id,at,user,scopeId,companionId:'c',sessionId:'s',assistant:'已经验证配置的结果'})
const daily={summary:'当天回顾',events:[],openTasks:[],completedTasks:[],learnings:[]}

test('timeline counts archived and pending turns in the configured timezone and only in the selected scope',async t=>{
  const memory=await fixture(t)
  const before=Date.parse('2026-11-21T15:58:00Z'), after=Date.parse('2026-11-21T16:03:00Z')
  await memory.enqueue(turn('one',before,'队列配置'))
  await memory.enqueue(turn('two',after,'容器名称 mochen'))
  await memory.enqueue(turn('other',after,'另一范围不得计入','other'))
  await memory.consolidate(turn('one',before,'队列配置'),{daily,memories:[]})
  const timeline=await memory.historyTimeline('c','owner',after+60_000)
  assert.equal(timeline.timeZone,'Asia/Shanghai')
  assert.equal(timeline.days.length,28)
  assert.deepEqual(timeline.days.slice(-2).map(({day,turns,pending})=>({day,turns,pending})),[
    {day:'2026-11-21',turns:1,pending:1},{day:'2026-11-22',turns:1,pending:1},
  ])
  assert.equal(timeline.days.at(-2).reflection.summary,'当天回顾')
  const older=await memory.historyTimeline('c','owner',after+60_000,'2026-11-21')
  assert.equal(older.today,'2026-11-22')
  assert.equal(older.days.at(-1).day,'2026-11-21')
  assert.equal(older.days.at(-1).turns,1)
  assert.deepEqual((await memory.history('c','owner',after+1,30,'\uffff','2026-11-22')).map(item=>item.id),['two'])
  assert.deepEqual((await memory.searchHistory('c','owner','mochen',12)).map(item=>item.id),['two'])
})

test('preference emphasis is removed after a correction changes the preference',async t=>{
  const memory=await fixture(t)
  const at=Date.now()
  const candidate={kind:'preference',subject:'交付格式',content:'一律用 Markdown',confidence:.99,importance:.9,operation:'upsert'}
  for(let i=0;i<3;i++)await memory.consolidate(turn('p'+i,at+i,'一律用 Markdown'),{daily,memories:[candidate]})
  const [item]=await memory.recentMemories('c',10,'owner')
  assert.equal(preferenceEmphasisLabel(item),'反复强调')
  const edit=await memory.updateMemory('c',item.id,item.subject,'优先发送 PDF')
  assert.equal(preferenceEmphasisLabel(edit),'')
  assert.equal(edit.evidence.length,3)
  assert.ok(edit.evidence.every(e=>e.supportsCurrent===false))
})

test('artifact refresh saves scoped scenes and grounds reusable steps in independent confirmations',async t=>{
  const memory=await fixture(t)
  const at=Date.now()
  await memory.consolidate(turn('preference',at,'日常使用 Markdown'),{daily,memories:[
    {kind:'preference',subject:'报告格式',content:'报告使用 Markdown',confidence:.99,importance:.9,operation:'upsert'},
  ]})
  for(const [i,user] of ['新机器测试通过','另一个项目验收通过'].entries()){
    const source=turn('confirmation-'+i,at-60000+i,user)
    await memory.enqueue(source)
    const job=await memory.claimJob('c')
    assert.equal(job.turn.id,source.id)
    await memory.settleJob(job)
  }
  const [item]=await memory.recentMemories('c',10,'owner')
  const evidence=[{turnId:'confirmation-0',quote:'测试通过'},{turnId:'confirmation-1',quote:'验收通过'}]
  const llm={async *stream(){yield {type:'text-delta',text:JSON.stringify({
    scenes:[{title:'报告交付',memoryIds:[item.id]},{title:'另一范围',memoryIds:['foreign']}],
    experiences:[{title:'复验配置',steps:['应用同样配置后测试'],evidence},{title:'一次检查',steps:['查看'],evidence:evidence.slice(0,1)}],
  })}}}
  const reflection=new MemoryReflectionService({llm,agentDefaultModel:{currentSelection:()=>({provider:'test',model:'test'})}},memory,{})
  const result=await reflection.refreshArtifacts({id:'c',automation:{memory:{enabled:true}}},'owner',()=>true)
  assert.deepEqual(result,{scenes:1,experiences:1,confirmations:2})
  const layers=await memory.memoryLayers('c','owner')
  assert.equal(layers.scenes[0].title,'报告交付')
  assert.equal(layers.experiences[0].status,'draft')
  assert.equal((await memory.memoryLayers('c','other')).scenes.length,0)
})

test('group timeline uses the authenticated owner route and excludes guest history and forwarded text', async()=>{
  const {Session}=await import('@deepseek-ai/dsh-session')
  const {createUserMessage,createAssistantMessage}=await import('@deepseek-ai/dsh-llm')
  const {recordInputOrigin}=await import('../lib/channels/input-origin.js')
  const {ownerGroupSources,ownerGroupTurns,ownerGroupTimeline}=await import('../lib/api/owner-group-history.js')
  const s=Session.create('shared')
  const route=(id,userId)=>({id,kind:'channel',channelId:'qq',companionId:'c',sessionId:s.id,userId})
  const owner=route('owner','group:100000:100001'), guest=route('guest','group:100000:100002'), other=route('other','group:100003:100001')
  const channels=[{id:'qq',platform:'qq',companionId:'c',enabled:true,qq:{groupReplies:true,groupIds:['100000','100003'],identityBinding:{enabled:true,qqIds:['100001']}}}]
  const sources=ownerGroupSources({channels,sessions:[owner,guest,other]},'c')
  assert.deepEqual(sources.map(source=>source.routes.map(r=>r.id)),[['owner'],['other']])
  const append=(route,turn,plain)=>{
    const input=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'前置转发内容\n'+plain}]})
    s.append('turn/start',{turn})
    recordInputOrigin(s,{messageId:input.id,routeId:route.id,channelId:route.channelId,userId:route.userId,imageRequest:plain})
    s.append('user/message',input,{surfaceOp:'append'})
    s.append('assistant/message',{turn,step:0,message:createAssistantMessage({source:{provider:'test',model:'test'},content:[{type:'text',text:'回复 '+plain}]}),stream:[]},{surfaceOp:'append'})
    s.append('turn/end',{turn,reason:{kind:'completed'}})
  }
  append(owner,1,'真实的归属账号消息')
  append(guest,2,'其他群友消息')
  append(other,3,'另外一个群的同一人')
  const rows=ownerGroupTurns(s.snapshotEvents(),sources[0].routes)
  assert.deepEqual(rows.map(({user,assistant,accountId})=>[user,assistant,accountId]),[['真实的归属账号消息','回复 真实的归属账号消息','100001']])
  assert.equal(ownerGroupTimeline(rows,'Asia/Shanghai').days.at(-1).turns,1)
  const now=rows[0].at+34*86_400_000,ward=ownerGroupTimeline(rows,'Asia/Shanghai',now)
  assert.equal(ward.days.reduce((count,day)=>count+day.turns,0),0)
  const original=ownerGroupTimeline(rows,'Asia/Shanghai',rows[0].at).today
  const older=ownerGroupTimeline(rows,'Asia/Shanghai',now,original)
  assert.equal(older.days.at(-1).turns,1)
})
