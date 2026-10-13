import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {validateConcernResources} from '../lib/concern-resources.js'
import {validateConcernSuggestion} from '../lib/concern-tool.js'
import {concernManagementTool} from '../lib/concern-management-tool.js'
import {PartnerConcernStore} from '../lib/concern-store.js'
import {extractConcernResources} from '../lib/concern-domain.js'
import {concernNoteSourceTool} from '../lib/concern-note-source.js'

test('note tokens remain note references and source tool is scoped, paginated, read-only',async()=>{
  assert.deepEqual(extractConcernResources('检查 @笔记[note-1]'),[{kind:'note',locator:'note-1',label:'note-1'}])
  let reads=0
  const tool=concernNoteSourceTool([{id:'c',resources:[{kind:'note',locator:'note-1',label:'说明'}]}],()=>({version:1,read:async()=>{reads++;return {id:'note-1',name:'说明',revision:'r1',content:'x'.repeat(6100)}}}))
  assert.equal(tool.parameters.properties.operation,undefined)
  let result=JSON.parse(await tool.execute({concernId:'c',noteId:'note-1'},{}))
  assert.equal(result.content.length,6000);assert.equal(result.nextOffset,6000)
  result=JSON.parse(await tool.execute({concernId:'c',noteId:'note-1',offset:6000},{}))
  assert.equal(result.content.length,100);assert.equal(result.nextOffset,null)
  await assert.rejects(tool.execute({concernId:'c',noteId:'other'},{}),/不是当前关注/)
  await assert.rejects(tool.execute({concernId:'other',noteId:'note-1'},{}),/不是当前关注/)
  await assert.rejects(tool.execute({concernId:'c',noteId:'note-1',offset:-1},{}),/offset/)
  assert.equal(reads,2)
})

test('checking sources validate structure and relative paths without silent truncation',()=>{
  for(const input of [null,{},[{kind:'unknown',locator:'x'}],[{kind:'file',locator:'../x'}],[{kind:'file',locator:'C:\\x'}],[{kind:'file',locator:'.partner/concerns/x'}],[{kind:'file',locator:'/etc/passwd'}],Array(9).fill({kind:'knowledge',locator:'base'})]) assert.throws(()=>validateConcernResources(input))
  assert.deepEqual(validateConcernResources([{kind:'knowledge',locator:'团队/说明'}]),[{kind:'knowledge',locator:'团队/说明',label:'团队/说明'}])
  const result=validateConcernSuggestion({subject:'版本更新',reason:'持续留意',evidence:'帮我关注版本更新',watchKind:'knowledge',watchQuery:'版本',priority:.8,confidence:1,resources:[]},'帮我关注版本更新')
  assert.deepEqual(result.resources,[])
})

test('tool edits persist sources: omit preserves, list replaces, [] clears, stale revision rejects',async t=>{
  const root=await mkdtemp(join(tmpdir(),'concern-resources-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const store=new PartnerConcernStore(root)
  let item=await store.createExplicit('c','*','持续检查版本')
  const tool=concernManagementTool({snapshot:()=>({sessions:[{sessionId:'s',companionId:'c'}],companions:[{id:'c'}]})},store)
  const exec={agent:{session:{id:'s'}}}
  const update=async extra=>JSON.parse(await tool.execute({action:'update',concernId:item.id,expectedUpdatedAt:item.updatedAt,reason:'调整检查依据',...extra},exec))
  item=await update({resources:[{kind:'note',locator:'note-1',label:'更新说明'}]})
  assert.equal(item.resources[0].locator,'note-1')
  assert.equal((await new PartnerConcernStore(root).list('c'))[0].resources[0].kind,'note')
  item=await update({priority:.4});assert.equal(item.resources.length,1)
  const old=item.updatedAt
  item=await update({resources:[]});assert.deepEqual(item.resources,[])
  assert.deepEqual((await new PartnerConcernStore(root).list('c'))[0].resources,[])
  await assert.rejects(update({resources:[],expectedUpdatedAt:old}),/已变化/)
})

test('creation merge supports an explicit empty list without changing legacy omission behavior',async t=>{
  const root=await mkdtemp(join(tmpdir(),'concern-resources-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const store=new PartnerConcernStore(root)
  const candidate={subject:'持续检查版本',reason:'留意更新',operation:'upsert',priority:.8,confidence:1,watchKind:'knowledge',watchQuery:'版本',resources:[{kind:'knowledge',locator:'团队/更新',label:'更新'}]}
  await store.ingestCandidates('c','*',[candidate],'explicit')
  await store.ingestCandidates('c','*',[{...candidate,resources:[]}],'explicit')
  assert.equal((await store.list('c'))[0].resources.length,1)
  await store.ingestCandidates('c','*',[{...candidate,resources:[],replaceResources:true}],'explicit')
  assert.deepEqual((await store.list('c'))[0].resources,[])
})
