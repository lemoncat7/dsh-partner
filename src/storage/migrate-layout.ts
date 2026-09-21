import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, rmdir } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { PartnerState } from '../domain.js'
import { PartnerInboxStore } from '../notifications/store.js'
import { AttachmentDeliveryService, type AttachmentDelivery } from '../attachments/service.js'
import { storageLayout } from './layout.js'
import { atomicJson, syncDirectory } from './atomic.js'
import { copyVerified, exists, safeTree, verifyDatabases } from './safe-files.js'
import { SplitStatePersistence, privateStateOwners } from './split-state.js'
import { storageConfigPath, readStorageConfig } from './bootstrap.js'
import { legacyMemoryBackups } from './legacy-backups.js'
import { prepareSourceArchive, cleanupArchivedSources } from './source-archive.js'

interface Journal { id:string; phase:'copying'|'installed'|'committed'; owners:string[] }
export interface MigrationResult { storageVersion:number; backupPath:string; retainedLegacy:boolean; cleanupPending?:number }
export interface LayoutMigrationContext { statePath:string; root:string; state:PartnerState; result?:MigrationResult }
/** Called only after every legacy writer has been stopped and drained. */
export async function migrateLayout(statePath:string,root:string,state:PartnerState):Promise<MigrationResult> {
  statePath=resolve(statePath);root=resolve(root)
  const layout=storageLayout(statePath,root),journalPath=join(layout.legacyPublic,'storage-migration.json')
  const current=await readStorageConfig(statePath,root)
  if(current.storageVersion===1)return {storageVersion:1,backupPath:join(layout.legacyPublic,'migration-backups',current.transactionId),retainedLegacy:true}
  const oldJournal=await exists(journalPath)?JSON.parse(await readFile(journalPath,'utf8')) as Journal:undefined
  if(oldJournal) {
    if(!/^[a-f0-9-]{36}$/.test(oldJournal.id)||!Array.isArray(oldJournal.owners))throw Error('迁移恢复清单无效')
    // Only remove this transaction's uncommitted generated targets, never old data.
    for(const target of [layout.publicRoot,...oldJournal.owners.map(id=>layout.privateRoot(id))]) {
      for(const path of [target,target+'.migrate-'+oldJournal.id])if(await exists(path)) {
        await safeTree(path)
        if(path!==target&&(await readdir(path)).length===0){await rmdir(path);continue}
        const marker=JSON.parse(await readFile(join(path,'migration-owner.json'),'utf8'))
        if(marker.transactionId!==oldJournal.id)throw Error('迁移目标不是当前事务创建，拒绝覆盖')
        await rm(path,{recursive:true,force:false})
      }
    }
  }
  const id=randomUUID(),owners=new Set(privateStateOwners(state))
  const inboxPath=join(layout.legacyPublic,'partner-inbox.sqlite')
  let notices:import('../notifications/domain.js').PartnerNotice[]=[]
  if(await exists(inboxPath)) {
    await safeTree(inboxPath)
    const db=new DatabaseSync(inboxPath,{readOnly:true})
    try{notices=db.prepare('SELECT payload,read_at FROM notices').all().map(row=>({...JSON.parse(String(row.payload)),...(row.read_at===null?{}:{readAt:Number(row.read_at)})}))}finally{db.close()}
    for(const notice of notices)if(notice.kind!=='system')owners.add(notice.companionId)
    if(notices.length>200)throw Error('消息库超出预期保留数量，拒绝截断迁移')
  }
  const deliveryRoot=join(layout.legacyPublic,'attachment-deliveries'),deliveryDb=join(deliveryRoot,'deliveries.sqlite')
  let deliveries:AttachmentDelivery[]=[]
  if(await exists(deliveryDb)) {
    await safeTree(deliveryRoot)
    const db=new DatabaseSync(deliveryDb,{readOnly:true})
    try{deliveries=db.prepare('SELECT payload FROM deliveries').all().map(row=>JSON.parse(String(row.payload)))}finally{db.close()}
    for(const item of deliveries)owners.add(item.companionId)
  }
  for(const owner of owners)layout.privateRoot(owner)
  const targets=[layout.publicRoot,...[...owners].map(owner=>layout.privateRoot(owner))]
  const sources=[layout.legacySkills,deliveryRoot,...[...owners].flatMap(owner=>['memory','concerns','memory-backup'].map(name=>join(layout.legacyCompanion(owner),name)))]
  for(const owner of owners)for(const name of await legacyMemoryBackups(layout.legacyCompanion(owner)))sources.push(join(layout.legacyCompanion(owner),name))
  for(const target of targets)for(const source of sources)if(target===source||target.startsWith(source+sep)||source.startsWith(target+sep))throw Error('迁移源与目标目录重叠，拒绝执行')
  for(const target of targets){await safeTree(target);if(await exists(target))throw Error('目标目录已存在，拒绝覆盖：'+target)}
  const journal:Journal={id,phase:'copying',owners:[...owners]}
  await atomicJson(journalPath,journal)
  const staging=(path:string)=>path+'.migrate-'+id
  const privateStage=(owner:string)=>staging(layout.privateRoot(owner))
  for(const target of targets){await mkdir(staging(target),{recursive:true,mode:0o700});await atomicJson(join(staging(target),'migration-owner.json'),{transactionId:id})}
  const backup=join(layout.legacyPublic,'migration-backups',id)
  await copyVerified(statePath,join(backup,'state.json'))
  await prepareSourceArchive(statePath,root,id,[...owners])
  // Original directories remain untouched and serve as the pre-upgrade backup.
  await atomicJson(join(backup,'sources.json'),{transactionId:id,workspaceRoot:root,retained:targets.slice(1).map((_,i)=>layout.legacyCompanion(journal.owners[i]!)),publicSource:layout.legacyPublic})
  for(const owner of owners) {
    const source=layout.legacyCompanion(owner),target=privateStage(owner)
    await copyVerified(join(source,'memory'),join(target,'memory'))
    await copyVerified(join(source,'concerns'),join(target,'concerns'))
    // Preserve legacy backups opaquely; never merge their contents into live memory.
    for(const name of await legacyMemoryBackups(source))await copyVerified(join(source,name),join(target,'backups','legacy-memory',name))
  }
  await copyVerified(layout.legacySkills,join(staging(layout.publicRoot),'skills'))
  const next=structuredClone(state)
  next.notificationDeliveries ??= []
  next.mcpBindings ??= []
  for(const skill of next.skills) {
    const rel=relative(layout.legacySkills,resolve(skill.rootPath))
    if(isAbsolute(rel)||rel==='..'||rel.startsWith('../')||rel.startsWith('..\\')||resolve(layout.legacySkills,rel)!==resolve(skill.rootPath))throw Error('Skill 不在已登记的公共目录中')
    skill.rootPath=join(layout.publicRoot,'skills',rel)
  }
  const split=new SplitStatePersistence(staging(layout.publicRoot),privateStage)
  await split.write(next)
  if(JSON.stringify(await split.read())!==JSON.stringify(next)) {
    // Field/array order can change during partition; compare canonical state below.
    if(canonical(await split.read())!==canonical(next))throw Error('公共和私有配置拆分校验失败')
  }
  const inbox=await PartnerInboxStore.openPartitioned(join(staging(layout.publicRoot),'indexes','inbox.sqlite'),privateStage)
  try{for(const notice of notices){inbox.append(notice);if(notice.readAt!==undefined)inbox.markRead([notice.id],notice.readAt)}}finally{inbox.close()}
  const attachments=await AttachmentDeliveryService.openPartitioned(join(staging(layout.publicRoot),'indexes','attachments'),privateStage)
  try{for(const item of deliveries){if(!/^[a-f0-9]{64}$/.test(item.id))throw Error('附件迁移标识无效');await safeTree(join(deliveryRoot,item.id));await attachments.importExisting(item,await readFile(join(deliveryRoot,item.id)))}}finally{attachments.close()}
  for(const target of targets)await verifyDatabases(staging(target))
  for(const target of targets){await rename(staging(target),target);await syncDirectory(dirname(target))}
  await atomicJson(journalPath,{...journal,phase:'installed'})
  return {storageVersion:1,backupPath:backup,retainedLegacy:true}
}
export async function verifyInstalledLayout(context:LayoutMigrationContext):Promise<void> {
  const layout=storageLayout(resolve(context.statePath),resolve(context.root))
  const journal=JSON.parse(await readFile(join(layout.legacyPublic,'storage-migration.json'),'utf8')) as Journal
  if(journal.phase!=='installed')throw Error('迁移尚未完成安装')
  await new SplitStatePersistence(layout.publicRoot,layout.privateRoot).read()
  for(const target of [layout.publicRoot,...journal.owners.map(id=>layout.privateRoot(id))]) {
    const marker=JSON.parse(await readFile(join(target,'migration-owner.json'),'utf8'))
    if(marker.transactionId!==journal.id)throw Error('迁移目标标记不一致')
    await verifyDatabases(target)
  }
}
export async function commitLayoutVersion(context:LayoutMigrationContext,expected:number,next:number):Promise<void> {
  if(expected!==0||next!==1)throw Error('布局迁移版本无效')
  const root=resolve(context.root),statePath=resolve(context.statePath),layout=storageLayout(statePath,root)
  const current=await readStorageConfig(statePath,root)
  if(current.storageVersion!==expected)throw Error('迁移版本已被其他操作更新')
  const journalPath=join(layout.legacyPublic,'storage-migration.json')
  const journal=JSON.parse(await readFile(journalPath,'utf8')) as Journal
  if(journal.phase!=='installed')throw Error('没有可提交的迁移')
  await atomicJson(storageConfigPath(statePath),{storageVersion:next,transactionId:journal.id,workspaceRoot:root})
  await atomicJson(journalPath,{...journal,phase:'committed'}).catch(()=>{})
  // Activation is durable. Cleanup failures must not be reported as a rollback.
  try {
    const cleanup=await cleanupArchivedSources(statePath,root,journal.id)
    if(context.result){context.result.retainedLegacy=cleanup.pending>0;context.result.cleanupPending=cleanup.pending}
  } catch {
    if(context.result){context.result.retainedLegacy=true;context.result.cleanupPending=1}
  }
}
function canonical(value:unknown):string {
  const normalize=(v:unknown):unknown=>Array.isArray(v)?v.map(normalize).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).filter(([,x])=>x!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,normalize(x)])):v
  return JSON.stringify(normalize(value))
}
