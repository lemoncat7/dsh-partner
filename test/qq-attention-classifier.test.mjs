import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readFile,writeFile,mkdir} from 'node:fs/promises'
import {EventEmitter} from 'node:events'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {setTimeout as pause} from 'node:timers/promises'
import {ManagedAttention} from '../lib/channels/qq/managed-attention.js'
import {scoreGroupReply} from '../lib/channels/qq/reply-rules.js'

async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'partner-attention-test-'))
  const service=new ManagedAttention(directory)
  t.after(async()=>{await service.close();await rm(directory,{force:true,recursive:true})})
  return {directory,service}
}
test('attention is opt-in and disabled mode uses no network or process',async t=>{
  const {directory,service}=await fixture(t)
  await service.restore()
  assert.equal(service.status().phase,'off')
  let diagnostic
  assert.equal(await service.classify('大家好',new AbortController().signal,[],value=>diagnostic=value),undefined)
  assert.deepEqual(diagnostic,{status:'unconfigured',attempts:0})
  assert.equal((await service.details()).model.files,'missing')
  await service.change('disable')
  assert.deepEqual(JSON.parse(await readFile(join(directory,'settings.json'),'utf8')),{enabled:false})
})
test('a cancelled message never becomes a decision to reply',async t=>{
  const {service}=await fixture(t)
  await assert.rejects(service.classify('测试',AbortSignal.abort()),{name:'AbortError'})
})
test('invalid settings do not start an optional process',async t=>{
  const {directory,service}=await fixture(t)
  await writeFile(join(directory,'settings.json'),'{invalid')
  await service.restore()
  assert.equal(service.status().phase,'error')
  assert.equal(service.status().enabled,false)
})
test('disable cancels preparation and persists the disabled state',async t=>{
  const {directory,service}=await fixture(t)
  await mkdir(join(directory,'model'))
  await service.change('enable')
  await service.change('disable')
  await pause(10)
  assert.equal(service.status().phase,'off')
  assert.deepEqual(JSON.parse(await readFile(join(directory,'settings.json'),'utf8')),{enabled:false})
})


test('training cannot start with the local service off',async t=>{
  const {directory,service}=await fixture(t)
  await service.restore()
  await assert.rejects(service.change('train'),/开启本地识别/)
  await assert.rejects(service.changeGroup({scope:'a',samples:{},guard(){}}),/开启本地识别/)
  assert.equal((await service.details()).usable,false)
  await service.change('disable')
  assert.equal((await service.details()).phase,'off')
  assert.deepEqual(JSON.parse(await readFile(join(directory,'settings.json'),'utf8')),{enabled:false})
})

test('group training reports the regressing holdout score and keeps the current classifier',async t=>{
  const {service}=await fixture(t)
  const scope='group-fixture'
  service.settings={enabled:true,groups:{[scope]:{id:'current',heads:{},evaluation:{}}}}
  service.worker={exitCode:0}
  const score=(baseline,correct,total)=>({baseline,correct,total,training:47})
  const results={
    groupIntent:score(7,7,16),groupScene:score(8,7,16),
    intent:score(37,36,40),scene:score(35,34,40),
    personaCalls:score(0,0,0),personaScenes:score(0,0,0),
  }
  service.launch=async training=>{
    assert.equal(training,true)
    return {trained:{intent:{},scene:{}},results}
  }
  await assert.rejects(service.trainGroups([scope],{},()=>{},AbortSignal.timeout(1000)),{
    message:'新分类头未通过留出评估（群历史场景 8/16 → 7/16），继续使用原分类头',
  })
  assert.equal(service.groupStatus(scope).versions.find(version=>version.current).id,'current')
  assert.deepEqual(service.groupStatus(scope).attempt,results)
})

test('returning to built-in heads archives the previous custom heads without starting the service',async t=>{
  const {directory,service}=await fixture(t)
  const scope='group-fixture'
  const first={id:'one',createdAt:100,heads:{intent:'one'},evaluation:{}}
  const second={id:'two',createdAt:200,heads:{intent:'two'},evaluation:{}}
  await writeFile(join(directory,'settings.json'),JSON.stringify({enabled:false,groups:{
    [scope]:{...second,previous:[first]},
  }}))
  await service.restore()
  await service.changeGroup({scope,guard(){}})
  assert.equal(service.groupStatus(scope).selected,false)
  assert.equal(service.groupStatus(scope).versions.length,2)
  await service.changeGroup({scope,version:'one',guard(){}})
  const selected=service.groupStatus(scope)
  assert.equal(selected.active,false)
  assert.equal(selected.selected,true)
  assert.deepEqual(service.settings.groups[scope].heads,{})
  assert.deepEqual(service.settings.groups[scope].previous[0].heads,{})
  assert.equal(selected.versions.find(version=>version.current).id,'one')
  const stored=JSON.parse(await readFile(join(directory,'settings.json'),'utf8'))
  assert.deepEqual(stored.groups[scope].heads,first.heads)
  assert.deepEqual(stored.groups[scope].previous[0].heads,second.heads)
  assert.equal(stored.enabled,false)
})

test('managed inference receives interests and scoped relationship clauses beyond the first two settings',async()=>{
 const attention=new ManagedAttention('/unused')
 const worker=new EventEmitter()
 let sent
 worker.send=message=>{
  sent=message.input
  queueMicrotask(()=>worker.emit('message',{id:message.id,result:{label:'engage',confidence:.7,margin:.5}}))
 }
 attention.worker=worker
 const profile=Array.from({length:14},(_,index)=>'设定 '+index)
 await attention.classify('刚找到一台旧相机',AbortSignal.timeout(500),[],undefined,{profile})
 assert.deepEqual(sent.profile,profile.slice(0,11))
})

test('a current learned name works for all group members, including with weak model scores',async()=>{
 const attention=new ManagedAttention('/unused')
 const worker=new EventEmitter()
 worker.send=message=>queueMicrotask(()=>worker.emit('message',{id:message.id,result:{
  label:'address',confidence:.46,margin:.08,scene:{label:'question',confidence:.45,margin:.1},
  recipient:{label:'member',confidence:.9,margin:.6},
 }}))
 attention.worker=worker
 attention.settings={enabled:true,groups:{g:{profile:{role:{revision:'role',aliases:['小舟']},relationship:{revision:'bound',aliases:['搭档']}}}}}
 const frame={groupScope:'g',roleRevision:'role',relationshipRevision:'bound',boundRelationship:'这个账号称呼我搭档'}
 const signal=AbortSignal.timeout(1000)
 const classify=(text,profile=frame)=>attention.classify(text,signal,[],undefined,profile)
 const text='搭档 你去看看最近的部署'
 const call=await classify(text)
 assert.equal(call.learnedCall,'relationship')
 const score=(semantic,route={})=>scoreGroupReply({text,qqGroup:route},{name:'伙伴',now:1,seed:'probe',semantic})
 assert.equal(score(call).reply,true)
 assert.equal(score(call,{replyTo:'other'}).reply,false)
 assert.equal((await classify('搭档！')).learnedCall,'relationship')
 assert.equal((await classify('搭档的文件我看过了')).learnedCall,undefined)
 assert.equal((await classify('理论上搭档应该能看到')).learnedCall,undefined)
 const publicFrame={...frame,boundRelationship:undefined}
 const publicCall=await classify(text,publicFrame)
 assert.equal(publicCall.learnedCall,'relationship')
 assert.equal(score(publicCall).reply,true)
 assert.equal(score(publicCall,{replyTo:'other'}).reply,false)
 assert.equal((await classify('大家都认识搭档吗',publicFrame)).learnedCall,undefined)
 assert.equal((await classify(text,{...publicFrame,relationshipRevision:undefined})).learnedCall,undefined)
 assert.equal((await classify(text,{...frame,relationshipRevision:'changed'})).learnedCall,undefined)
 assert.equal((await classify('小舟，你在吗',{...frame,boundRelationship:undefined})).learnedCall,'role')
 attention.settings.groups.g.disabled=true
 assert.equal((await classify(text,publicFrame)).learnedCall,undefined)
 attention.settings.groups['default:owner']={profile:attention.settings.groups.g.profile}
 assert.equal((await classify(text,{...publicFrame,defaultScope:'default:owner'})).learnedCall,'relationship')
 assert.equal((await classify(text,{...publicFrame,defaultScope:'default:other'})).learnedCall,undefined)
})
