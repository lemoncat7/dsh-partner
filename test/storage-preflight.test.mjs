import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { StoragePreflight } from '../lib/storage/preflight.js'
import { storageLayout, storageVersion, companionDirectory } from '../lib/storage/layout.js'
import { resolveConfig } from '../lib/config.js'

test('storage version is separate, missing means legacy and newer formats fail closed', () => {
  assert.equal(storageVersion(undefined),0)
  assert.equal(storageVersion(1),1)
  for(const value of [-1,0.5,NaN,'1',null]) assert.throws(()=>storageVersion(value))
  assert.equal(resolveConfig({statePath:'/tmp/state.json'}).storageVersion,0)
  assert.equal(resolveConfig({statePath:'/tmp/state.json',storageVersion:1}).storageVersion,1)
  assert.throws(()=>resolveConfig({statePath:'/tmp/state.json',storageVersion:99}),/阻止写入/)
})
test('layout rejects escaping IDs and keeps public/private locations separate', () => {
  const layout=storageLayout('/data/partner/state.json','/work')
  assert.equal(layout.publicRoot,'/data/partner/storage-v1')
  assert.equal(layout.privateRoot('companion-one'),'/work/partners/companion-one/.partner')
  for(const id of ['','..','.','a/b','a\\b','C:foo','x\0']) assert.throws(()=>companionDirectory('/work',id))
  assert.throws(()=>storageLayout('state.json','/work'))
})
async function fixture(fn) {
  const root=await mkdtemp(join(tmpdir(),'partner-preflight-'))
  try {
    const statePath=join(root,'public','state.json');await mkdir(join(root,'public'))
    await writeFile(statePath,'{"secret":"DO_NOT_RETURN"}')
    const directory=join(root,'partners','one');await mkdir(join(directory,'memory'),{recursive:true})
    await writeFile(join(directory,'memory','memory.sqlite'),'private_memory')
    await writeFile(join(directory,'memory','memory.sqlite-wal'),'wal')
    const state={companions:[{id:'one',name:'伙伴'}]}
    const service=new StoragePreflight(statePath,root,0,()=>state)
    await fn({root,statePath,directory,service,state})
  } finally {await rm(root,{recursive:true,force:true})}
}
test('preflight inventories WAL and data sizes without creating targets or returning content',async()=>fixture(async({root,statePath,directory,service})=>{
  const before=await readFile(statePath,'utf8')
  const pending=service.inspect();assert.equal(service.inspect(),pending)
  const report=await pending
  assert.equal(report.migrationAvailable,true);assert.equal(report.consistentSnapshot,false)
  assert.deepEqual(report.blockers,[])
  const memory=report.items.find(i=>i.label.endsWith('记忆'));assert.equal(memory.files,2)
  assert.equal(memory.bytes,17)
  assert.equal(JSON.stringify(report).includes('DO_NOT_RETURN'),false)
  assert.equal(await readFile(statePath,'utf8'),before)
  assert.deepEqual(await readdir(directory),['memory'])
  assert.deepEqual(await readdir(join(root,'public')),['state.json'])
}))
test('existing destination blocks migration and legacy backup is preserved opaquely',async()=>fixture(async({directory,service})=>{
  await mkdir(join(directory,'.partner'));await mkdir(join(directory,'memory-backup'))
  const report=await service.inspect()
  assert.ok(report.blockers.some(i=>i.includes('目标目录已存在')))
  assert.ok(report.notices.some(i=>i.includes('原样归档')))
}))
test('symlink ancestors are not traversed and missing legacy sources are harmless',async()=>fixture(async({directory,root,service})=>{
  await mkdir(join(root,'outside'));await writeFile(join(root,'outside','private.txt'),'outside')
  await symlink(join(root,'outside'),join(directory,'concerns'))
  const report=await service.inspect()
  assert.ok(report.blockers.some(i=>i.includes('符号链接')))
  assert.equal(report.items.some(i=>i.source.endsWith('/concerns')),false)
  assert.equal(report.items.find(i=>i.label==='Skill 安装库').exists,false)
}))
test('invalid companion identifiers are reported without traversing outside workspace',async()=>fixture(async({state,service})=>{
  state.companions.push({id:'../outside',name:'invalid'})
  const report=await service.inspect();assert.ok(report.blockers.some(i=>i.includes('ID 无效')))
}))
