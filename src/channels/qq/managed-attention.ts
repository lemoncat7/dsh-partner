import type {AttentionProfileCues,LearnedAttentionProfile} from './attention-profile-training.js'
import {scenes,type AttentionAliases,type GroupTraining} from './attention-samples.js'
import {execFile,fork,type ChildProcess} from 'node:child_process'
import {createHash, randomUUID} from 'node:crypto'
import {createReadStream,createWriteStream} from 'node:fs'
import {mkdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises'
import {dirname,join} from 'node:path'
import {pipeline} from 'node:stream/promises'
import {Transform} from 'node:stream'
import {fileURLToPath} from 'node:url'
import type {AttentionClassifier, AttentionPrediction} from './attention-classifier.js'
import {explicitAttentionCall} from './attention-persona.js'

const assets=fileURLToPath(new URL('../../../ops/attention/',import.meta.url))
const workerFile=fileURLToPath(new URL('../../../resources/attention/worker.mjs',import.meta.url))
const runtimeVersion='ort-1.31.1-tokenizers-0.2.0'
type Phase='off'|'preparing'|'ready'|'training'|'error'
type Step='checking'|'download'|'install'|'train'|'start'
type Evaluation=Record<string,{total:number;correct:number;baseline:number;training:number}>
function groupEvaluationFailure(evaluation:Evaluation):string|undefined {
  const {groupIntent,groupScene,intent,scene,personaCalls,personaNonCalls,personaScenes}=evaluation
  if(!groupIntent||!groupScene||!intent||!scene)return '有效留出样本不足或类别过于单一'
  const persona=[['称呼呼唤',personaCalls],['排除称呼误触发',personaNonCalls],['设定相关场景',personaScenes]] as const
  const personaChecks=persona.flatMap(([name,row])=>row&&row.total>=3?[{name,row,tolerance:0}]:[])
  const checks=[
    {name:'群历史接话意图',row:groupIntent,tolerance:0},
    {name:'群历史场景',row:groupScene,tolerance:0},
    ...personaChecks,
    {name:'通用接话意图',row:intent,tolerance:2},
    {name:'通用场景',row:scene,tolerance:2},
  ]
  const regressions=checks.flatMap(({name,row,tolerance})=>row.correct<row.baseline-tolerance
    ?[`${name} ${row.baseline}/${row.total} → ${row.correct}/${row.total}`]:[])
  if(regressions.length)return regressions.join('，')
  if(groupIntent.correct+groupScene.correct===groupIntent.baseline+groupScene.baseline&&
    !personaChecks.some(({row})=>row.correct>row.baseline))return '留出样本上的识别没有提升'
}
type Heads=Record<string,unknown>
interface GroupHead {id?:string;createdAt?:number;heads:Heads;evaluation:Evaluation;relationshipAliases?:string[];profile?:LearnedAttentionProfile}
interface GroupModel extends GroupHead {disabled?:boolean;previous?:GroupHead[]}
interface Settings {enabled:boolean;heads?:Heads;evaluation?:Evaluation;groups?:Record<string,GroupModel>}
type GroupChange={scope:string;scopes?:string[];samples?:GroupTraining;profile?:AttentionProfileCues;trainDefaults?:true;defaultScope?:string;version?:string;guard:()=>void;signal?:AbortSignal;allowStart?:boolean}
const retainedVersions=4
function groupVersion(model:GroupHead):GroupHead {
  return {id:model.id??'legacy',createdAt:model.createdAt??0,heads:model.heads,evaluation:model.evaluation,...(model.relationshipAliases?{relationshipAliases:model.relationshipAliases}:{}),...(model.profile?{profile:model.profile}:{})}
}
function groupVersions(model:GroupModel|undefined):GroupHead[]{
  return model?[groupVersion(model),...(model.previous??[])]:[]
}
function selectGroupVersion(model:GroupModel,version:string|undefined):GroupModel{
  if(version===undefined)return {...model,disabled:true}
  const versions=groupVersions(model)
  const choice=versions.find(item=>item.id===version)
  if(!choice)throw Error('这版分类头已不存在，请刷新')
  return {...choice,previous:versions.filter(item=>item.id!==version)}
}
function withoutWeights(settings:Settings):Settings{
  const stripProfile=(profile:LearnedAttentionProfile)=>({
    role:{...profile.role,vectors:profile.role.vectors.map(()=>[])},
    relationship:{...profile.relationship,vectors:profile.relationship.vectors.map(()=>[])},
  })
  const strip=(model:GroupHead)=>({...model,heads:{},...(model.profile?{profile:stripProfile(model.profile)}:{})})
  const groups=settings.groups&&Object.fromEntries(Object.entries(settings.groups).map(([scope,model])=>
    [scope,{...strip(model),...(model.previous?{previous:model.previous.map(strip)}:{})}]))
  return {...settings,...(groups?{groups}:{}),...(settings.heads?{heads:{}}:{})}
}
interface ModelFile {path:string;remotePath:string;bytes:number;sha256:string}
interface ModelManifest {repository:string;revision:string;files:ModelFile[];npm?:{name:string;version:string}}
async function readManifest():Promise<ModelManifest>{
  return JSON.parse(await readFile(join(assets,'model-manifest.json'),'utf8'))
}

async function validFile(path:string,entry:ModelFile):Promise<boolean>{
  const hash=createHash('sha256')
  let size=0
  try{for await(const chunk of createReadStream(path)){size+=chunk.length;hash.update(chunk)}}catch(error){
    if((error as NodeJS.ErrnoException).code==='ENOENT')return false
    throw error
  }
  return size===entry.bytes&&hash.digest('hex')===entry.sha256
}

async function saveJson(path:string,value:unknown){
  const temp=path+'.'+randomUUID()+'.tmp'
  try{await writeFile(temp,JSON.stringify(value),{flag:'wx',mode:0o600});await rename(temp,path)}
  finally{await rm(temp,{force:true})}
}

const stopping=new WeakMap<ChildProcess,Promise<void>>()
function stopWorker(child:ChildProcess):Promise<void>{
  const existing=stopping.get(child)
  if(existing)return existing
  if(child.exitCode!==null||child.signalCode!==null)return Promise.resolve()
  const done=new Promise<void>(resolve=>{
    const timer=setTimeout(()=>child.kill('SIGKILL'),2000)
    timer.unref()
    child.once('close',()=>{clearTimeout(timer);resolve()})
    child.kill('SIGTERM')
  })
  stopping.set(child,done)
  return done
}

export class ManagedAttention {
  private settings:Settings={enabled:false}
  private phase:Phase='off'
  private step:Step|undefined
  private failure:string|undefined
  private worker:ChildProcess|undefined
  private candidate:ChildProcess|undefined
  private readonly children=new Set<ChildProcess>()
  private restart:ReturnType<typeof setTimeout>|undefined
  private restartDelay=1000
  private setup:AbortController|undefined
  private running:Promise<void>|undefined
  private readonly groupAttempts=new Map<string,Evaluation>()
  private active=0
  private sequence=0
  private closed=false
  private disabling=false
  private lifecycle:Promise<void>=Promise.resolve()
  constructor(private readonly directory:string){}

  async restore(){
    try{
      const value=await this.readSettings()
      this.settings=value.enabled?value:withoutWeights(value)
    }catch{this.failure='本地识别配置无法读取'}
    if(this.settings.enabled)this.start()
    else if(this.failure)this.phase='error'
  }

  status(){return {phase:this.phase,enabled:this.settings.enabled&&!this.disabling,custom:!!this.settings.heads,
    evaluation:this.settings.evaluation,error:this.failure,step:this.step,usable:!!this.worker}}

  async details(){
    const manifest=await readManifest()
    const available=await Promise.all(manifest.files.map(async(entry)=>{
      try{
        const file=await stat(join(this.models,entry.path))
        return file.isFile()&&file.size===entry.bytes
      }catch(error){
        if((error as NodeJS.ErrnoException).code==='ENOENT')return false
        throw error
      }
    }))
    const present=available.filter(Boolean).length
    return {...this.status(),model:{
      name:manifest.repository.split('/').at(-1),
      files:present===available.length?'present':present?'partial':'missing',
    }}
  }

  groupStatus(scope:string){
    const model=this.settings.groups?.[scope]
    return {active:!!model&&!model.disabled&&!!this.worker,saved:!!model,selected:!!model&&!model.disabled,
      evaluation:model?.disabled?undefined:model?.evaluation,attempt:this.groupAttempts.get(scope),
      versions:groupVersions(model).map(version=>({id:version.id,createdAt:version.createdAt,
        current:!model?.disabled&&version.id===(model?.id??'legacy'),
        profile:version.profile?{roleAliases:version.profile.role.aliases.length,roleScenes:version.profile.role.vectors.length,
          relationshipAliases:version.profile.relationship.aliases.length,relationshipScenes:version.profile.relationship.vectors.length}:undefined,
        sceneCoverage:scenes.flatMap(scene=>{
          const score=version.evaluation['scene.'+scene]
          return score?[{scene,training:score.training,holdout:score.total}]:[]
        }),
        persona:version.evaluation.personaCalls?{calls:version.evaluation.personaCalls,
          nonCalls:version.evaluation.personaNonCalls,scenes:version.evaluation.personaScenes,
          relationshipAliases:version.relationshipAliases?.length??0}:undefined}))}
  }

  trainGroups(scopes:string[],samples:GroupTraining,guard:()=>void,signal:AbortSignal,defaultScope?:string):Promise<void>{
    return this.learnGroups(scopes,{samples,...(defaultScope?{defaultScope}:{})},guard,signal)
  }

  trainProfile(scopes:string[],profile:AttentionProfileCues,guard:()=>void,signal:AbortSignal):Promise<void>{
    return this.learnGroups(scopes,{profile},guard,signal)
  }

  trainDefault(scope:string,profile:AttentionProfileCues,guard:()=>void,signal:AbortSignal):Promise<void>{
    return this.learnGroups([scope],{profile,trainDefaults:true},guard,signal)
  }

  private async learnGroups(scopes:string[],input:Pick<GroupChange,'samples'|'profile'|'trainDefaults'|'defaultScope'>,guard:()=>void,signal:AbortSignal):Promise<void>{
    const scope=scopes[0]
    if(!scope)throw Error('请选择要训练的群')
    const previous=this.settings.groups?.[scope]?.id
    await this.changeGroup({scope,scopes,...input,guard,signal,allowStart:true})
    await this.running
    const version=this.settings.groups?.[scope]?.id
    if(version&&version!==previous&&scopes.every(key=>this.settings.groups?.[key]?.id===version))return
    signal.throwIfAborted()
    throw Error(this.failure??'本次训练未启用新模型')
  }

  changeGroup(change:GroupChange):Promise<void>{
    const operation=this.lifecycle.then(async()=>{
      if(this.closed||this.running)throw Error('本地识别正在准备或训练')
      if(change.samples&&!this.settings.enabled&&!change.allowStart)throw Error('请先开启本地识别')
      change.signal?.throwIfAborted()
      change.guard()
      const scopes=[...new Set(change.scopes??[change.scope])]
      const known=this.settings.groups??{}
      for(const scope of scopes)this.groupAttempts.delete(scope)
      if(change.samples||change.profile){
        const groupScopes=new Set([...Object.keys(known),...scopes].filter(scope=>!scope.startsWith('default:')))
        if(groupScopes.size>24&&!change.trainDefaults)throw Error('最多保存 24 个群的分类头')
      }else{
        for(const scope of scopes){
          const current=known[scope]
          if(current)selectGroupVersion(current,change.version)
          else if(change.version)throw Error('这版分类头已不存在，请刷新')
        }
        if(!scopes.some(scope=>known[scope]))return
      }
      await mkdir(this.directory,{mode:0o700,recursive:true})
      if(!change.samples&&!change.profile&&!this.settings.enabled){
        const stored=await this.readSettings(),groups={...stored.groups}
        for(const scope of scopes)if(groups[scope])groups[scope]=selectGroupVersion(groups[scope],change.version)
        await this.persist({...stored,groups})
        return
      }
      this.beginReplace(change.samples||change.trainDefaults?'train':change.profile?'profile':'reset',change)
    })
    this.lifecycle=operation.catch(()=>{})
    return operation
  }

  change(action:'enable'|'disable'|'train'|'reset'):Promise<void>{
    const operation=this.lifecycle.then(async()=>{
      if(this.closed)throw Error('本地识别正在关闭')
      await mkdir(this.directory,{mode:0o700,recursive:true})
      if(action==='enable'||action==='disable'){
        if(action==='disable'){
          this.disabling=true
          try{
            await this.stop()
            const stored=await this.readSettings()
            await this.persist({...stored,enabled:false})
            this.groupAttempts.clear()
            this.phase='off';this.failure=undefined;this.step=undefined
          }finally{this.disabling=false}
        }else{
          if(this.running)return
          const stored=this.settings.enabled?this.settings:await this.readSettings()
          await this.persist({...stored,enabled:true})
          if(!this.worker){this.clearRestart();this.start()}
        }
        return
      }
      if(this.running)throw Error('本地识别正在准备或训练')
      if(!this.settings.enabled)throw Error('请先开启本地识别')
      if(action==='reset'&&!this.worker)throw Error('请先开启本地识别')
      this.beginReplace(action)
    })
    this.lifecycle=operation.catch(()=>{})
    return operation
  }

  private beginReplace(action:'train'|'profile'|'reset',change?:GroupChange){
    this.failure=undefined
    this.phase='training'
    const controller=this.setup=new AbortController()
    const signal=change?.signal?AbortSignal.any([controller.signal,change.signal]):controller.signal
    const running=this.running=this.replace(action,signal,change)
    void running.finally(()=>{if(this.running===running){this.running=undefined;this.setup=undefined}}).catch(()=>{})
  }

  async close(){
    this.closed=true
    await this.lifecycle
    await this.stop()
  }

  private async readSettings():Promise<Settings>{
    try{
      const value=JSON.parse(await readFile(join(this.directory,'settings.json'),'utf8')) as Settings
      if(typeof value.enabled!=='boolean')throw Error('本地识别配置无效')
      return value
    }catch(error){
      if((error as NodeJS.ErrnoException).code==='ENOENT')return {enabled:false}
      throw error
    }
  }

  private async persist(next:Settings){
    await saveJson(join(this.directory,'settings.json'),next)
    this.settings=next.enabled?next:withoutWeights(next)
  }

  private start(restarting=false){
    this.phase='preparing';this.failure=undefined
    const controller=this.setup=new AbortController()
    const running=this.running=this.prepare(controller.signal).then(async()=>{
      this.step='start'
      const result=await this.launch(false,this.settings.heads,controller.signal)
      controller.signal.throwIfAborted()
      this.adopt(result.worker)
    }).catch(error=>{
      if(!controller.signal.aborted){this.phase='error';this.step=undefined;this.failure=error instanceof Error?error.message:'本地识别初始化失败';if(restarting)this.restartIfEnabled()}
    })
    void running.finally(()=>{if(this.running===running){this.running=undefined;this.setup=undefined}}).catch(()=>{})
  }

  private clearRestart(){
    clearTimeout(this.restart);this.restart=undefined
  }

  private restartIfEnabled(){
    if(!this.settings.enabled||this.closed||this.disabling||this.restart)return
    this.restart=setTimeout(()=>{
      this.restart=undefined
      if(!this.settings.enabled||this.closed||this.worker)return
      if(this.running){this.restartIfEnabled();return}
      this.start(true)
    },this.restartDelay)
    this.restart.unref()
    this.restartDelay=Math.min(this.restartDelay*2,60_000)
  }

  private track(child:ChildProcess){
    this.children.add(child)
    child.once('close',()=>this.children.delete(child))
    return child
  }

  private async stop(){
    this.clearRestart()
    this.setup?.abort()
    this.worker=undefined;this.candidate=undefined
    // Keep retired inference, trainer and installer handles until their close events.
    await Promise.allSettled([...this.children].map(stopWorker))
    await this.running?.catch(()=>{})
    await Promise.allSettled([...this.children].map(stopWorker))
    this.clearRestart()
  }

  private get models(){return join(this.directory,'model')}
  private get packages(){return join(this.directory,runtimeVersion)}

  private async prepare(signal:AbortSignal){
    this.step='checking'
    await mkdir(this.models,{mode:0o700,recursive:true})
    const manifest=await readManifest()
    const missing:ModelFile[]=[]
    for(const entry of manifest.files){
      signal.throwIfAborted()
      if(!await validFile(join(this.models,entry.path),entry))missing.push(entry)
    }
    if(missing.length){
      this.step='download'
      let installed=false
      if(manifest.npm){
        try{await this.downloadNpmModel(manifest.npm,missing,signal);installed=true}
        catch{signal.throwIfAborted()}
      }
      if(!installed)for(const entry of missing){
        const file=join(this.models,entry.path)
        if(!await validFile(file,entry))await this.downloadModel(file,entry,
          manifest.repository+'/resolve/'+manifest.revision+'/'+entry.remotePath,signal)
      }
    }
    try{await readFile(join(this.packages,'.ready'));return}catch(error){
      if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error
    }
    this.step='install'
    const stage=this.packages+'-'+randomUUID()
    await mkdir(stage,{mode:0o700})
    try{
      await writeFile(join(stage,'package.json'),'{"private":true}',{mode:0o600})
      await this.installPackages(stage,['onnxruntime-node@1.31.1','@huggingface/tokenizers@0.2.0'],signal,
        'ONNX 运行组件安装失败，请检查 DSH 的 npm、网络和平台支持')
      await writeFile(join(stage,'.ready'),'ok')
      await rename(stage,this.packages)
    }finally{await rm(stage,{recursive:true,force:true})}
  }

  private installPackages(stage:string,specs:string[],signal:AbortSignal,message:string,extra:string[]=[]){
    return new Promise<void>((resolve,reject)=>{
      signal.throwIfAborted()
      const windows=process.platform==='win32'
      const launcher=windows?[join(dirname(process.execPath),'node_modules','npm','bin','npm-cli.js')]:[]
      this.track(execFile(windows?process.execPath:'npm',[
        ...launcher,'install','--prefix',stage,'--omit=dev','--ignore-scripts','--no-audit','--no-fund',
        '--fetch-retries=1','--fetch-timeout=120000',...extra,...specs,
      ],{cwd:stage,signal,timeout:600_000},error=>error?reject(Error(message)):resolve()))
    })
  }

  private async downloadNpmModel(spec:{name:string;version:string},entries:ModelFile[],signal:AbortSignal){
    const stage=join(this.directory,'model-npm-'+randomUUID())
    await mkdir(stage,{mode:0o700})
    try{
      await writeFile(join(stage,'package.json'),'{"private":true}',{mode:0o600})
      await this.installPackages(stage,[spec.name+'@'+spec.version],signal,'npm 模型包下载失败',[
        '--registry=https://registry.npmjs.org','--package-lock=false','--cache',join(stage,'cache'),
      ])
      const root=join(stage,'node_modules',spec.name)
      for(const entry of entries){
        signal.throwIfAborted()
        if(!await validFile(join(root,entry.path),entry))throw Error('npm 模型文件完整性校验失败')
      }
      for(const entry of entries){
        signal.throwIfAborted()
        await rename(join(root,entry.path),join(this.models,entry.path))
      }
    }finally{await rm(stage,{recursive:true,force:true})}
  }

  private async downloadModel(file:string,entry:ModelFile,location:string,signal:AbortSignal){
    const mirrors=['https://huggingface.co/','https://hf-mirror.com/']
    let failure:unknown
    for(const source of [...mirrors,...mirrors]){
      const temp=file+'.'+randomUUID()+'.partial'
      try{
        const deadline=AbortSignal.any([signal,AbortSignal.timeout(600_000)])
        const response=await fetch(source+location,{signal:deadline})
        if(!response.ok||!response.body){
          await response.body?.cancel()
          throw Error('模型下载失败（HTTP '+response.status+'）')
        }
        let size=0
        const hash=createHash('sha256')
        const limit=new Transform({transform(chunk,_,callback){
          size+=chunk.length
          if(size>entry.bytes){callback(Error('模型文件超出预期大小'));return}
          hash.update(chunk);callback(null,chunk)
        }})
        await pipeline(response.body as never,limit,createWriteStream(temp,{mode:0o600,flags:'wx'}),{signal:deadline})
        if(size!==entry.bytes||hash.digest('hex')!==entry.sha256)throw Error('模型文件完整性校验失败')
        await rename(temp,file)
        return
      }catch(error){signal.throwIfAborted();failure=error}
      finally{await rm(temp,{force:true})}
    }
    const detail=failure instanceof Error&&failure.message.startsWith('模型')?'（'+failure.message+'）':''
    throw Error('模型下载或校验失败'+detail+'，请检查 DSH 的网络连接后重试',{cause:failure})
  }

  private launch(training:boolean,custom:Heads|undefined,signal:AbortSignal,groups=this.settings.groups,groupTraining?:{scope:string;scopes?:string[];defaultScope?:string;samples:GroupTraining},profileTraining?:AttentionProfileCues){
    signal.throwIfAborted()
    const worker=this.track(fork(workerFile,[],{stdio:['ignore','ignore','ignore','ipc'],serialization:'advanced',
      execArgv:[],env:{...process.env,OMP_NUM_THREADS:'1'}}))
    this.candidate=worker
    return new Promise<{worker:ChildProcess;trained?:Heads;results?:Evaluation;learnedProfile?:LearnedAttentionProfile}>((resolve,reject)=>{
      const deadline=AbortSignal.timeout(training||profileTraining?600_000:20_000)
      const abort=()=>fail(Error(signal.aborted?'本地识别操作已取消':'本地识别操作超时'))
      const close=(code:number|null,reason:NodeJS.Signals|null)=>fail(Error('本地识别进程退出（'+(reason??code)+'）'))
      const cleanup=()=>{
        signal.removeEventListener('abort',abort);deadline.removeEventListener('abort',abort)
        worker.off('error',fail);worker.off('exit',close);worker.off('message',message)
      }
      const fail=(error:Error)=>{cleanup();void stopWorker(worker);if(this.candidate===worker)this.candidate=undefined;reject(error)}
      const message=(value:{ready?:boolean;trained?:Heads;results?:Evaluation;learnedProfile?:LearnedAttentionProfile})=>{
        if(!value.ready&&!value.trained&&!value.learnedProfile)return
        cleanup()
        if(training||profileTraining){void stopWorker(worker);if(this.candidate===worker)this.candidate=undefined}
        resolve({worker,...value})
      }
      worker.once('error',fail);worker.once('exit',close);worker.on('message',message)
      signal.addEventListener('abort',abort,{once:true});deadline.addEventListener('abort',abort,{once:true})
      const groupModels=Object.fromEntries(Object.entries(groups??{})
        .map(([scope,model])=>[scope,model.disabled?{builtin:true}:{heads:model.heads,relationshipAliases:model.relationshipAliases,profile:model.profile}]))
      worker.send({training,custom,assets,groupModels,groupTraining,profileTraining,packages:this.packages,modelDir:this.models},error=>{if(error)fail(error)})
    })
  }

  private adopt(worker:ChildProcess){
    const previous=this.worker
    this.worker=worker;this.candidate=undefined;this.phase='ready';this.step=undefined;this.restartDelay=1000
    const failed=()=>{if(this.worker===worker){this.worker=undefined;this.phase='error';this.failure='本地识别进程已退出，正在尝试恢复';this.restartIfEnabled()}}
    worker.on('error',failed);worker.once('exit',failed)
    if(previous)void stopWorker(previous)
  }

  private async replace(action:'train'|'profile'|'reset',signal:AbortSignal,change?:GroupChange){
    try{
      const current=this.settings.enabled?this.settings:await this.readSettings()
      if(!this.worker)await this.prepare(signal)
      change?.guard()
      this.step=action==='reset'?'start':'train'
      const trained=action==='train'?await this.launch(true,current.heads,signal,current.groups,
        change?.samples?{scope:change.scope,scopes:change.scopes??[change.scope],samples:change.samples,
          ...(change.defaultScope?{defaultScope:change.defaultScope}:{})}:undefined):undefined
      const heads=trained?.trained,evaluation=trained?.results
      if(action==='train'&&(!heads||!evaluation))throw Error('本地模型没有返回分类头与评估结果')
      if(evaluation&&!change?.samples&&Object.values(evaluation).some(item=>item.correct<item.baseline)){
        throw Error(this.worker?'独立评估低于内置分类头，已保留当前模型':'独立评估低于内置分类头，可以开启内置模型或重试')
      }
      let next:Settings
      if(change){
        const groups={...current.groups}
        const scopes=change.scopes??[change.scope]
        if(change.profile){
          const {learnedProfile}=await this.launch(false,current.heads,signal,groups,undefined,change.profile)
          if(!learnedProfile)throw Error('本地模型没有返回设定特征')
          const id=randomUUID(),createdAt=Date.now()
          for(const scope of scopes){
            const old=groups[scope]
            groups[scope]={id,createdAt,heads:heads??(old?.disabled?{}:old?.heads??{}),evaluation:evaluation??(old?.disabled?{}:old?.evaluation??{}),
              profile:learnedProfile,...(!old?.disabled&&old?.relationshipAliases?{relationshipAliases:old.relationshipAliases}:{}),
              previous:groupVersions(old).slice(0,retainedVersions-1)}
          }
        }else if(heads&&evaluation){
          for(const scope of scopes){
            if(this.groupAttempts.size>=24)this.groupAttempts.delete(this.groupAttempts.keys().next().value!)
            this.groupAttempts.set(scope,evaluation)
          }
          const failure=groupEvaluationFailure(evaluation)
          if(failure)throw Error(`新分类头未通过留出评估（${failure}），继续使用原分类头`)
          const version={id:randomUUID(),createdAt:Date.now(),heads,evaluation,
            ...(change.samples?.relationshipAliases?{relationshipAliases:change.samples.relationshipAliases}:{})}
          for(const scope of scopes){
            const profile=groups[scope]?.profile
            groups[scope]={...version,...(profile?{profile}:{}),previous:groupVersions(groups[scope]).slice(0,retainedVersions-1)}
          }
        }else{
          for(const scope of scopes)if(groups[scope])groups[scope]=selectGroupVersion(groups[scope],change.version)
        }
        next={...current,enabled:true,groups}
      }else{
        next={enabled:true,...(current.groups?{groups:current.groups}:{}),...(heads?{heads}:{}),...(evaluation?{evaluation}:{})}
      }
      this.step='start'
      const {worker}=await this.launch(false,next.heads,signal,next.groups)
      try{
        signal.throwIfAborted()
        change?.guard()
        await this.persist(next)
        if(this.disabling||this.closed)signal.throwIfAborted()
        this.adopt(worker)
      }catch(error){if(this.candidate===worker)this.candidate=undefined;void stopWorker(worker);throw error}
    }catch(error){
      if(!signal.aborted){this.phase=this.worker?'ready':'error';this.step=undefined;this.failure=error instanceof Error?error.message:'训练失败'}
      else if(!this.closed&&!this.disabling&&this.phase==='training'){this.phase=this.worker?'ready':this.settings.enabled?'error':'off';this.step=undefined}
    }
  }

  profileAliases(scope:string|undefined,roleRevision:string|undefined,relationshipRevision:string|undefined,defaultScope?:string):AttentionAliases{
    const group=scope?this.settings.groups?.[scope]:undefined
    const profile=group?.disabled?undefined:group?.profile
    const fallback=defaultScope?this.settings.groups?.[defaultScope]?.profile:undefined
    const current=(cue:LearnedAttentionProfile['role']|undefined,revision:string|undefined)=>
      cue&&cue.revision===revision?cue.aliases:undefined
    return {
      role:current(profile?.role,roleRevision)??current(fallback?.role,roleRevision)??[],
      relationship:current(profile?.relationship,relationshipRevision)??current(fallback?.relationship,relationshipRevision)??[],
    }
  }

  classify:AttentionClassifier=async(text,signal,context=[],report,frame)=>{
    signal.throwIfAborted()
    const worker=this.worker
    if(!worker){report?.({status:'unconfigured',attempts:0});return}
    if(!text.trim()){report?.({status:'empty',attempts:0});return}
    const aliases=this.profileAliases(frame?.groupScope,frame?.roleRevision,frame?.relationshipRevision,frame?.defaultScope)
    const learnedCall=explicitAttentionCall(text,aliases.role)?'role':
      explicitAttentionCall(text,aliases.relationship)?'relationship':undefined
    if(this.active>=4){report?.({status:'busy',attempts:0});return}
    this.active++
    const id=++this.sequence
    const turns=frame?.dialogue??[],offset=Math.max(0,turns.length-6)
    const dialogue=turns.slice(offset).map(({replyTo,...turn},index)=>({...turn,text:turn.text.slice(0,160),
      ...(replyTo!==undefined&&replyTo>=offset&&replyTo<index+offset?{replyTo:replyTo-offset}:{})}))
    const deadline=AbortSignal.timeout(1500)
    const combined=AbortSignal.any([signal,deadline])
    try{
      return await new Promise<AttentionPrediction|undefined>((resolve,reject)=>{
        const finish=()=>{
          combined.removeEventListener('abort',abort);worker.off('message',message);worker.off('exit',exit)
        }
        const abort=()=>{
          finish()
          if(signal.aborted)reject(signal.reason)
          else{report?.({status:'timeout',attempts:1});resolve(undefined)}
        }
        const exit=()=>{finish();report?.({status:'transport',attempts:1});resolve(undefined)}
        const message=(value:{id:number;result?:AttentionPrediction;busy?:boolean})=>{
          if(value.id!==id)return
          finish()
          if(value.result?.link&&value.result.link.index!==null)value.result.link.index+=offset
          report?.({status:value.result?'ok':value.busy?'busy':'invalid',attempts:1})
          resolve(value.result&&learnedCall?{...value.result,learnedCall}:value.result)
        }
        combined.addEventListener('abort',abort,{once:true});worker.on('message',message);worker.once('exit',exit)
        worker.send({id,expiresAt:Date.now()+1500,input:{groupScope:frame?.groupScope,defaultScope:frame?.defaultScope,boundRelationship:frame?.boundRelationship,roleRevision:frame?.roleRevision,relationshipRevision:frame?.relationshipRevision,text:text.slice(0,1200),context:context.slice(-4).map(t=>t.slice(0,48)),
          profile:(frame?.profile??[]).slice(0,11).map(t=>t.slice(0,160)),partnerText:frame?.partnerText?.slice(0,160),dialogue}},error=>{if(error)exit()})
      })
    }finally{this.active--}
  }
}
