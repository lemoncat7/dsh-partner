import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PartnerConcernStore} from '../lib/concern-store.js'
import {observationBudget} from '../lib/observation-budget.js'

test('recording gets its own bounded phase only with explicit destinations',()=>{
  assert.equal(observationBudget(109000,1,3,true).stageRemainingMs,1000)
  assert.equal(observationBudget(110000,1,3,true).recording,true)
  assert.equal(observationBudget(149000,1,3,true).recording,true)
  assert.equal(observationBudget(150000,1,3,true).recording,false)
  assert.equal(observationBudget(110000,1,3,false).recording,false)
})

test('pending recording survives restart and old execution cannot clear a changed destination',async t=>{
  const root=await mkdtemp(join(tmpdir(),'concern-sync-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const store=new PartnerConcernStore(root)
  const old=await store.createExplicit('c','*','同步测试','',{kind:'note',locator:'n1',label:'笔记一'})
  await store.recordSyncState([old],[{concernId:old.id,state:'pending'}])
  assert.equal((await new PartnerConcernStore(root).list('c'))[0].recordingPending,true)
  const edited=await store.editExplicit('c',old.id,{subject:old.subject,reason:'',sources:'',expectedUpdatedAt:old.updatedAt,recordTarget:{kind:'note',locator:'n2',label:'笔记二'}})
  await store.recordSyncState([old],[{concernId:old.id,state:'synced'}])
  assert.equal((await store.list('c'))[0].recordingPending,true)
  await store.recordSyncState([edited],[{concernId:edited.id,state:'synced'}])
  assert.equal((await store.list('c'))[0].recordingPending,undefined)
})
