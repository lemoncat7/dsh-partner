import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PartnerStore } from '../lib/store.js'
import { migrateLayout, verifyInstalledLayout, commitLayoutVersion } from '../lib/storage/migrate-layout.js'
import { cleanupArchivedSources } from '../lib/storage/source-archive.js'
import { isLegacyMemoryBackup } from '../lib/storage/legacy-backups.js'
import { readStorageConfig } from '../lib/storage/bootstrap.js'

async function fixture(fn){
 const root=await mkdtemp(join(tmpdir(),'partner-archive-'))
 try{
  const statePath=join(root,'public','state.json'),store=await PartnerStore.open(statePath),state=store.snapshot(),owner=state.companions[0].id
  const privateDir=join(root,'partners',owner)
  await mkdir(join(privateDir,'memory','empty'),{recursive:true});await writeFile(join(privateDir,'memory','journal.txt'),'keep')
  await writeFile(join(privateDir,'work.md'),'USER_WORK')
  await fn({root,statePath,state,owner,privateDir})
 }finally{await rm(root,{recursive:true,force:true})}
}
test('legacy backup recognition is bounded to known memory backup naming families',()=>{
 for(const name of ['memory-backup','memory_back','memory_backup','memory-backup-before-sqlite-20260825-192843'])assert.ok(isLegacyMemoryBackup(name))
 for(const name of ['memory','memory_backend','memory-backup/../../work','notes-backup','memory-backup.md'])assert.equal(isLegacyMemoryBackup(name),false)
})
test('all recognized backups are archived, empty directories and user work survive; old paths are cleaned only after commit',async()=>fixture(async c=>{
 const names=['memory-backup-before-sqlite-20260825-192843','memory_back','memory_backup']
 for(const name of names){await mkdir(join(c.privateDir,name));await writeFile(join(c.privateDir,name,'saved.txt'),name)}
 c.result=await migrateLayout(c.statePath,c.root,c.state)
 await verifyInstalledLayout(c)
 await assert.rejects(cleanupArchivedSources(c.statePath,c.root,(await readFile(join(c.root,'public','storage-migration.json'),'utf8')).match(/"id":"([^"]+)"/)[1]))
 assert.equal(await readFile(join(c.privateDir,'memory','journal.txt'),'utf8'),'keep')
 await commitLayoutVersion(c,0,1)
 assert.equal(c.result.cleanupPending,0)
 for(const name of names){await assert.rejects(stat(join(c.privateDir,name)),{code:'ENOENT'});assert.equal(await readFile(join(c.privateDir,'.partner','backups','legacy-memory',name,'saved.txt'),'utf8'),name)}
 assert.ok((await stat(join(c.privateDir,'.partner','memory','empty'))).isDirectory())
 assert.equal(await readFile(join(c.privateDir,'work.md'),'utf8'),'USER_WORK')
 const config=await readStorageConfig(c.statePath,c.root)
 assert.equal((await cleanupArchivedSources(c.statePath,c.root,config.transactionId)).pending,0)
 const archive=JSON.parse(await readFile(join(c.result.backupPath,'archive.json'),'utf8'))
 const i=archive.entries.findIndex(e=>e.source.kind==='private'&&e.source.name==='memory')
 assert.equal(await readFile(join(c.result.backupPath,'originals',String(i),'journal.txt'),'utf8'),'keep')
}))
test('changed source is retained, version stays committed and cleanup reports pending',async()=>fixture(async c=>{
 c.result=await migrateLayout(c.statePath,c.root,c.state);await verifyInstalledLayout(c)
 await writeFile(join(c.privateDir,'memory','journal.txt'),'changed outside plugin')
 await commitLayoutVersion(c,0,1)
 assert.equal((await readStorageConfig(c.statePath,c.root)).storageVersion,1)
 assert.equal(c.result.cleanupPending,1)
 assert.equal(await readFile(join(c.privateDir,'memory','journal.txt'),'utf8'),'changed outside plugin')
}))
test('damaged backup prevents removal and can be retried after backup repair',async()=>fixture(async c=>{
 c.result=await migrateLayout(c.statePath,c.root,c.state);await verifyInstalledLayout(c)
 const archive=JSON.parse(await readFile(join(c.result.backupPath,'archive.json'),'utf8'))
 const i=archive.entries.findIndex(e=>e.source.kind==='private'&&e.source.name==='memory')
 const saved=join(c.result.backupPath,'originals',String(i),'journal.txt')
 await writeFile(saved,'damaged');await commitLayoutVersion(c,0,1)
 assert.equal(c.result.cleanupPending,1);assert.equal(await readFile(join(c.privateDir,'memory','journal.txt'),'utf8'),'keep')
 await writeFile(saved,'keep')
 const config=await readStorageConfig(c.statePath,c.root)
 assert.equal((await cleanupArchivedSources(c.statePath,c.root,config.transactionId)).pending,0)
 await assert.rejects(stat(join(c.privateDir,'memory')),{code:'ENOENT'})
}))
test('dated backup symlinks are not followed or deleted',async()=>fixture(async c=>{
 const outside=join(c.root,'outside');await mkdir(outside);await writeFile(join(outside,'data'),'USER')
 await symlink(outside,join(c.privateDir,'memory-backup-before-test'))
 await assert.rejects(migrateLayout(c.statePath,c.root,c.state),/符号链接/)
 assert.equal((await readStorageConfig(c.statePath,c.root)).storageVersion,0)
 assert.equal(await readFile(join(outside,'data'),'utf8'),'USER')
}))
