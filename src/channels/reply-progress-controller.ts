import type {ReplyStage,ReplyActivity} from '../execution/reply-progress.js'
import type {ProgressTransport} from './direct/progress-transport.js'
import {ReplyBlocks} from './reply-blocks.js'

const labels:Record<ReplyStage,string>={queued:'已收到，正在等待处理…',working:'正在处理…',tools:'正在执行工具…',composing:'正在整理回复…'}

/** One controller per inbound message. Background feedback is best-effort and bounded. */
export class ReplyProgressController {
  private stage:ReplyStage='queued'
  private lastText=''
  private id:string|undefined
  private closed=false
  private disabled=false
  private typingDisabled=false
  private creating=false
  private rotating=0
  private readonly blocks:ReplyBlocks|undefined
  private deferredActivities:ReplyActivity[]=[]
  private lastEdit=0
  private timer:ReturnType<typeof setInterval>|undefined
  private startTimer:ReturnType<typeof setTimeout>|undefined
  private background:Promise<void>=Promise.resolve()
  private readonly aborter=new AbortController()
  private readonly onAbort=()=>{void this.fail()}
  constructor(private transport:ProgressTransport,private allowed:()=>boolean,private signal:AbortSignal,private interval=4000,private delay=1500){
    if(transport.activityBlocks)this.blocks=new ReplyBlocks(transport,allowed,signal)
  }
  start():void {
    if(this.signal.aborted)return
    this.signal.addEventListener('abort',this.onAbort,{once:true})
    this.tick(false)
    this.startTimer=setTimeout(()=>this.tick(true),this.delay)
    this.timer=setInterval(()=>this.tick(true),this.interval)
    this.timer.unref?.();this.startTimer.unref?.()
  }
  update=(stage:ReplyStage|ReplyActivity):void=>{
    if(this.closed)return
    if(typeof stage==='string'){this.stage=stage;return}
    if(this.rotating){if(this.deferredActivities.length<64)this.deferredActivities.push(stage);return}
    this.blocks?.update(stage)
  }
  /** An accepted steering input starts a new chronological display segment,
   * not a new model execution. Serialize with in-flight placeholder creation. */
  continueAfterInput():Promise<void>{
    return this.prepareInput()(true)
  }
  /** Fence final delivery before awaiting Agent.steer: accepting an input can
   * synchronously release the active reply, before the manager resumes. */
  prepareInput():(accepted:boolean)=>Promise<void>{
    if(this.closed||this.signal.aborted||!this.allowed())return ()=>Promise.resolve()
    let decide!:(accepted:boolean)=>void
    const decision=new Promise<boolean>(resolve=>{decide=resolve})
    this.rotating++
    this.background=this.background.then(async()=>{
      if(!await decision)return
      if(this.blocks){await this.blocks.boundary('已收到后续消息，后续过程将在下方继续。');return}
      const previous=this.id
      this.id=undefined;this.lastText='';this.lastEdit=0;this.disabled=false
      if(previous&&!this.signal.aborted&&this.allowed()){
        const signal=AbortSignal.any([this.signal,AbortSignal.timeout(3000)])
        await this.transport.edit(previous,'已收到后续消息，处理进度与回复将在下方继续。',signal).catch(()=>{})
      }
    }).finally(()=>{
      this.rotating--
      if(!this.rotating){for(const activity of this.deferredActivities)this.blocks?.update(activity);this.deferredActivities=[]}
    })
    const settled=this.background
    return accepted=>{decide(accepted);return settled}
  }
  private tick(show:boolean):void{
    if(this.closed||this.creating||this.rotating||!this.allowed()||this.signal.aborted)return
    this.creating=true
    this.background=(async()=>{
      const signal=AbortSignal.any([this.aborter.signal,this.signal,AbortSignal.timeout(3000)])
      if(!this.typingDisabled)await this.transport.typing(true,signal).catch(()=>{this.typingDisabled=true})
      if(!show||this.closed||this.disabled||!this.allowed())return
      if(this.blocks){await this.blocks.flush();return}
      const text=labels[this.stage]
      try{
        if(!this.id){this.id=await this.transport.create(text,signal);this.lastText=text;this.lastEdit=Date.now()}
        else if(text!==this.lastText&&Date.now()-this.lastEdit>=8000){await this.transport.edit(this.id,text,signal);this.lastText=text;this.lastEdit=Date.now()}
      }catch{this.disabled=true} // No repeated POST after uncertain acknowledgement.
    })().catch(()=>{}).finally(()=>{this.creating=false})
  }
  private async stop():Promise<void>{
    this.closed=true;clearTimeout(this.startTimer);clearInterval(this.timer)
    this.signal.removeEventListener('abort',this.onAbort)
    await this.background
  }
  async finish(text:string):Promise<void>{
    await this.stop()
    try{
      this.signal.throwIfAborted();if(!this.allowed())throw Error('渠道或联系人授权已撤销')
      const signal=AbortSignal.any([this.signal,AbortSignal.timeout(35000)])
      if(this.blocks){await this.blocks.finish(text);return}
      if(this.transport.finalDelivery==='separate'){
        // A progress-card edit must never swallow or replace the actual reply.
        await this.transport.send(text||'本次处理已结束，未生成文字回复。',signal)
        if(this.id&&this.allowed()&&!this.signal.aborted)await this.transport.edit(this.id,'本次处理已完成，回复已单独发送。',AbortSignal.any([this.signal,AbortSignal.timeout(3000)])).catch(()=>{})
        return
      }
      if(this.id){
        try { await this.transport.edit(this.id,text||'本次处理已结束，未生成文字回复。',signal) }
        catch(error) {
          // Definite unsupported/forbidden edit can fall back; ambiguous network failure cannot.
          const status=(error as {status?:number})?.status
          if(status!==undefined&&[403,404,405,501].includes(status)&&this.allowed())await this.transport.send(text,signal)
          else throw error
        }
      }else await this.transport.send(text,signal)
    }finally{await this.clearTyping()}
  }
  async fail():Promise<void>{
    if(this.closed)return
    await this.stop()
    if(this.blocks)await this.blocks.boundary('本次处理已中断或未完成，请在 DSH 查看执行结果。')
    if(this.id&&this.allowed())await this.transport.edit(this.id,'本次处理已中断或未完成，请在 DSH 查看执行结果。',AbortSignal.timeout(3000)).catch(()=>{})
    await this.clearTyping()
  }
  private async clearTyping():Promise<void>{
    this.aborter.abort()
    if(this.allowed())await this.transport.typing(false,AbortSignal.timeout(3000)).catch(()=>{})
  }
}
