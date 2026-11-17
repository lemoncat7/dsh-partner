type Kind = 'ordered' | 'direct' | 'ambient' | 'delivery'
interface Job<T> { kind:Kind; scope?:string|undefined; run:()=>Promise<T>; skip:()=>T; resolve:(value:T)=>void; reject:(error:unknown)=>void }
interface Lane<T> { jobs:Job<T>[]; active?:Job<T>|undefined; protected?:string|undefined; done:Promise<void>; release:()=>void }
/** Optional group chatter is a current opportunity, never a durable FIFO obligation. */
export class ReplyQueue<T> {
 private readonly lanes=new Map<string,Lane<T>>()
 enqueue(key:string,kind:Kind,scope:string|undefined,run:()=>Promise<T>,skip:()=>T):Promise<T> {
  let lane=this.lanes.get(key)
  if(!lane){let release!:()=>void;const done=new Promise<void>(r=>{release=r});lane={jobs:[],done,release};this.lanes.set(key,lane);void Promise.resolve().then(()=>this.drain(key,lane!))}
  if(kind==='ambient'&&scope&&(lane.protected===scope||lane.active?.kind==='direct'&&lane.active.scope===scope||lane.jobs.some(j=>j.kind==='direct'&&j.scope===scope)))return Promise.resolve(skip())
  if(kind!=='ordered'&&scope)this.dropAmbient(lane,scope)
  return new Promise((resolve,reject)=>lane!.jobs.push({kind,scope,run,skip,resolve,reject}))
 }
 private dropAmbient(lane:Lane<T>,scope:string):void {
  const obsolete=lane.jobs.filter(j=>j.kind==='ambient'&&j.scope===scope)
  lane.jobs=lane.jobs.filter(j=>!obsolete.includes(j));for(const j of obsolete)j.resolve(j.skip())
 }
 protect(key:string):void {const lane=this.lanes.get(key),scope=lane?.active?.scope;if(lane&&scope){lane.protected=scope;this.dropAmbient(lane,scope)}}
 idle(key:string):Promise<void> {return this.lanes.get(key)?.done??Promise.resolve()}
 busy(key:string):boolean {return this.lanes.has(key)}
 private async drain(key:string,lane:Lane<T>):Promise<void> {
  try{while(lane.jobs.length){
   const delivery=lane.jobs.findIndex(j=>j.kind==='delivery'),priority=delivery<0?lane.jobs.findIndex(j=>j.kind!=='ambient'):delivery,job=lane.jobs.splice(priority<0?0:priority,1)[0]!
   lane.active=job;lane.protected=undefined
   try{job.resolve(await job.run())}catch(error){job.reject(error)}finally{lane.active=undefined;lane.protected=undefined}
  }}finally{if(this.lanes.get(key)===lane)this.lanes.delete(key);lane.release()}
 }
}
