import type { PartnerState } from '../domain.js'
import { StoragePreflight } from './preflight.js'
import { commitLayoutVersion, type LayoutMigrationContext, type MigrationResult } from './migrate-layout.js'
import { runMigrationPath, storageMigrations } from './migrations/index.js'
import { dirname, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { atomicJson } from './atomic.js'
import { readStorageConfig } from './bootstrap.js'
import { archiveRoot, cleanupArchivedSources } from './source-archive.js'

interface Ports { busy():boolean; quiesce():Promise<void>; snapshot():PartnerState; restart():Promise<void>; report(error:unknown):void }
export class StorageCoordinator extends StoragePreflight {
  private migrating=false
  private requests=0
  enterRequest():()=>void {
    if(this.migrating)throw Error('伙伴正在升级迁移，请稍后刷新')
    this.requests++
    return ()=>{this.requests--}
  }
  get running():boolean{return this.migrating}
  constructor(private readonly configPath:string,private readonly workspaceRoot:string,private readonly currentVersion:number,private readonly ports:Ports) {super(configPath,workspaceRoot,currentVersion,ports.snapshot)}
  async status(){
    const config=await readStorageConfig(this.configPath,this.workspaceRoot)
    let cleanupPending=0,backupPath:string|undefined
    if(config.storageVersion===1){
      backupPath=archiveRoot(this.configPath,config.transactionId)
      try{cleanupPending=JSON.parse(await readFile(join(backupPath,'cleanup.json'),'utf8')).pending}catch{cleanupPending=1}
    }
    let lastError:string|undefined
    try{const saved=JSON.parse(await readFile(join(dirname(this.configPath),'storage-last-result.json'),'utf8'));if(saved.version===config.storageVersion)lastError=saved.error}catch{}
    return {currentVersion:config.storageVersion,targetVersion:1,running:this.migrating,backupPath,cleanupPending,lastError}
  }
  private validate(expectedVersion:number):void {
    if(this.migrating)throw Error('升级迁移正在执行，请勿重复提交')
    if(this.requests>1)throw Error('还有页面请求正在处理，请稍后重试')
    if(expectedVersion!==0||this.currentVersion!==expectedVersion)throw Error('迁移版本已变化，请重新检查')
    if(this.ports.busy())throw Error('伙伴仍有会话、记忆整理或任务执行中，请结束后再迁移')
  }
  start(expectedVersion:number):void {
    this.validate(expectedVersion)
    // Return HTTP 202 immediately; the runtime gate owns execution, not the
    // lifetime of the browser/proxy request. Never start a second operation.
    void this.migrate(expectedVersion).catch(error=>this.ports.report(error))
  }
  startCleanup():void {
    if(this.migrating||this.requests>1||this.ports.busy())throw Error('伙伴仍在执行或处理请求，请稍后清理')
    if(this.currentVersion!==1)throw Error('尚未完成目录升级，不能清理')
    this.migrating=true
    void (async()=>{
      await this.ports.quiesce()
      const config=await readStorageConfig(this.configPath,this.workspaceRoot)
      await cleanupArchivedSources(this.configPath,this.workspaceRoot,config.transactionId)
    })().catch(error=>this.ports.report(error)).finally(()=>this.reload())
  }
  private reload():void {setTimeout(()=>{void this.ports.restart().catch(error=>this.ports.report(error))},200)}
  async migrate(expectedVersion:number):Promise<MigrationResult> {
    this.validate(expectedVersion)
    this.migrating=true
    try {
      await this.ports.quiesce()
      const context:LayoutMigrationContext={statePath:this.configPath,root:this.workspaceRoot,state:this.ports.snapshot()}
      await runMigrationPath(storageMigrations,0,1,context,(from,to)=>commitLayoutVersion(context,from,to))
      if(!context.result)throw Error('迁移未返回结果')
      return context.result
    }catch(error){
      const config=await readStorageConfig(this.configPath,this.workspaceRoot).catch(()=>undefined)
      await atomicJson(join(dirname(this.configPath),'storage-last-result.json'),{version:config?.storageVersion??this.currentVersion,error:error instanceof Error?error.message:'迁移执行失败'}).catch(()=>{})
      throw error
    }finally {
      // Reload either the unchanged legacy layout or the committed new layout.
      // Never resume old service objects after any migration failure.
      this.reload()
    }
  }
}
