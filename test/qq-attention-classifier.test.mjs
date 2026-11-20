import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readFile,writeFile,mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {setTimeout as pause} from 'node:timers/promises'
import {ManagedAttention} from '../lib/channels/qq/managed-attention.js'

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
