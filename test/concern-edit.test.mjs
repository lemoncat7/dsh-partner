import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PartnerConcernStore} from '../lib/concern-store.js'

test('editing preserves identity and state, updates references, clears destination and checks revision',async t=>{
  const root=await mkdtemp(join(tmpdir(),'concern-edit-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const store=new PartnerConcernStore(root)
  const old=await store.createExplicit('c','*','旧事项 @old.md','说明',{kind:'note',locator:'n1',label:'旧笔记'})
  const input={subject:'新事项',reason:'按优先级整理表格',sources:'@知识库[开发/访问说明]',expectedUpdatedAt:old.updatedAt}
  const edited=await store.editExplicit('c',old.id,input)
  assert.equal(edited.id,old.id);assert.equal(edited.state,old.state);assert.equal(edited.createdAt,old.createdAt)
  assert.equal(edited.recordTarget,undefined);assert.equal(edited.resources[0].locator,'开发/访问说明')
  assert.equal(edited.reason,input.reason);assert.equal(edited.nextCheckAt,old.nextCheckAt)
  assert.deepEqual(old.recordTarget,{kind:'note',locator:'n1',label:'旧笔记'},'inflight snapshot unchanged')
  await assert.rejects(store.editExplicit('c',old.id,input),/发生变化/)
  await assert.rejects(store.editExplicit('other',old.id,{...input,expectedUpdatedAt:edited.updatedAt}),/不存在/)
  const cleared=await store.editExplicit('c',old.id,{...input,sources:'',expectedUpdatedAt:edited.updatedAt})
  assert.deepEqual(cleared.resources,[])
  const [restored]=await new PartnerConcernStore(root).list('c');assert.equal(restored.id,old.id)
  const archived=await store.createExplicit('c','*','归档名称')
  await store.act('c',archived.id,'ignore')
  const renamed=await store.editExplicit('c',old.id,{...input,subject:'归档名称',expectedUpdatedAt:cleared.updatedAt})
  assert.equal(renamed.id,old.id)
  const all=await store.list('c',undefined,true)
  assert.equal(all.find(item=>item.id===archived.id).state,'archived')
  assert.equal(all.find(item=>item.id===archived.id).subject,'归档名称')
  assert.ok(renamed.updatedAt>cleared.updatedAt)
})
