import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PartnerConcernStore } from '../lib/concern-store.js'
import { concernStage } from '../lib/concern-attention.js'
import { concernManagementTool } from '../lib/concern-management-tool.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'concern-attention-'))
  t.after(() => rm(root, { recursive:true, force:true }))
  return {root, store:new PartnerConcernStore(root)}
}
const candidate = {subject:'上游兼容性持续跟进',reason:'等待上游版本修复兼容问题',operation:'upsert',priority:.8,confidence:.9,watchKind:'web',watchQuery:'版本修复进展'}

test('autonomous attention lowers, archives and restores same identity without authorization phrases',async t=>{
  const {root,store}=await fixture(t)
  const [item]=await store.applyCandidates('c','*',[candidate],'implicit')
  let next=await store.revise('c',item.id,item.updatedAt,{action:'update',priority:.3,reason:'已有可靠替代方案，降低检查频率'})
  assert.equal(concernStage(next),'暂时观察')
  assert.ok(next.nextCheckAt>item.nextCheckAt)
  next=await store.revise('c',item.id,next.updatedAt,{action:'update',priority:.1,reason:'已不再依赖该上游，退出关注'})
  assert.equal(next.state,'archived')
  assert.equal((await store.due('c','*',{includeFuture:true})).length,0)
  next=await store.revise('c',item.id,next.updatedAt,{action:'restore',priority:.8,reason:'重新依赖此组件，需要恢复关注'})
  const restored=(await new PartnerConcernStore(root).list('c'))[0]
  assert.equal(restored.id,item.id)
  assert.equal(restored.adjustments.length,3)
  assert.equal(concernStage(restored),'重点关注')
  await assert.rejects(store.revise('other',item.id,next.updatedAt,{action:'resolve',reason:'完成'}),/没有此关注/)
  await assert.rejects(store.revise('c',item.id,item.updatedAt,{action:'resolve',reason:'完成'}),/已变化/)
})

test('explicit watches survive low attention and silence; user pin and stop cannot be overridden',async t=>{
  const {store}=await fixture(t)
  const item=await store.createExplicit('c','*','用户交代的长期问题')
  let next=await store.revise('c',item.id,item.updatedAt,{action:'update',priority:.05,reason:'正在等待发布，减少检查频率'})
  assert.equal(next.state,'watching')
  await store.due('c','*',{now:Date.now()+365*86400000})
  assert.equal((await store.list('c'))[0].priority,.05)
  await assert.rejects(store.revise('c',item.id,next.updatedAt,{action:'archive',reason:'很久没有提及'}),/仅在已解决/)
  await store.act('c',item.id,'prioritize')
  next=(await store.list('c'))[0]
  await assert.rejects(store.revise('c',item.id,next.updatedAt,{action:'update',priority:.2,reason:'不再重要'}),/置顶/)
  await store.act('c',item.id,'ignore')
  next=(await store.list('c',undefined,true))[0]
  await assert.rejects(store.revise('c',item.id,next.updatedAt,{action:'restore',reason:'再次关注'}),/已停止/)
  await store.applyCandidates('c','*',[{...candidate,subject:item.subject}],'implicit')
  assert.equal((await store.list('c',undefined,true))[0].control,'stopped')
  await store.act('c',item.id,'watch')
  next=(await store.list('c'))[0]
  await store.revise('c',item.id,next.updatedAt,{action:'archive',conclusion:'resolved',reason:'实际核验已修复'})
  assert.equal((await store.archived('c')).items[0].state,'archived')
})

test('in-flight observations cannot resurrect an archived concern',async t=>{
  const {store}=await fixture(t)
  const item=await store.createExplicit('c','*','正在检查的问题')
  await store.act('c',item.id,'ignore')
  await store.recordObservations([item],[{concernId:item.id,changed:true,event:'新的进展',evidence:'已核实',source:'test',relevance:1,confidence:1,actionability:1}])
  assert.equal((await store.list('c',undefined,true))[0].state,'archived')
  assert.equal((await store.pendingNotifications('c','*')).length,0)
})

test('reflection can lower attention and cannot override stopped controls',async t=>{
  const {store}=await fixture(t)
  const [item]=await store.applyCandidates('c','*',[candidate],'implicit',100)
  await store.applyCandidates('c','*',[{...candidate,priority:.3,reason:'已启用替代方案，仅作观察'}],'implicit',200)
  assert.equal((await store.list('c'))[0].priority,.3)
  await store.act('c',item.id,'ignore')
  await store.applyCandidates('c','*',[candidate],'implicit')
  assert.equal((await store.list('c',undefined,true))[0].state,'archived')
})

test('management tool edits from companion context without user-message authorization and hides deletion',async t=>{
  const {store}=await fixture(t)
  const item=await store.createExplicit('c','*','跟进项目')
  const tool=concernManagementTool({snapshot:()=>({sessions:[{sessionId:'s',companionId:'c'}],companions:[{id:'c',automation:{memory:{enabled:false}}}]})},store)
  assert.ok(!tool.parameters.properties.action.enum.includes('delete'))
  const result=JSON.parse(await tool.execute({action:'update',concernId:item.id,expectedUpdatedAt:item.updatedAt,priority:.4,reason:'等待外部评审，暂缓检查'}, {agent:{session:{id:'s'}}}))
  assert.equal(result.priority,.4)
})
