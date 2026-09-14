import type {ReplyStage} from '../execution/reply-progress.js'
import type {ProgressTransport} from './direct/progress-transport.js'

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
  private lastEdit=0
  private timer:ReturnType<typeof setInterval>|undefined
  private startTimer:ReturnType<typeof setTimeout>|undefined
  private background:Promise<void>=Promise.resolve()
  private readonly aborter=new AbortController()
  private readonly onAbort=()=>{void this.fail()}
  constructor(private transport:ProgressTransport,private allowed:()=>boolean,private signal:AbortSignal,private interval=4000,private delay=1500){}
  start():void {
    if(this.signal.aborted)return
    this.signal.addEventListener('abort',this.onAbort,{once:true})
    this.tick(false)
    this.startTimer=setTimeout(()=>this.tick(true),this.delay)
    this.timer=setInterval(()=>this.tick(true),this.interval)
    this.timer.unref?.();this.startTimer.unref?.()
  }
  update=(stage:ReplyStage):void=>{this.stage=stage}
  private tick(show:boolean):void{
    if(this.closed||this.creating||!this.allowed()||this.signal.aborted)return
    this.creating=true
    this.background=(async()=>{
      const signal=AbortSignal.any([this.aborter.signal,this.signal,AbortSignal.timeout(3000)])
      if(!this.typingDisabled)await this.transport.typing(true,signal).catch(()=>{this.typingDisabled=true})
      if(!show||this.closed||this.disabled||!this.allowed())return
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
    if(this.id&&this.allowed())await this.transport.edit(this.id,'本次处理已中断或未完成，请在 DSH 查看执行结果。',AbortSignal.timeout(3000)).catch(()=>{})
    await this.clearTyping()
  }
  private async clearTyping():Promise<void>{
    this.aborter.abort()
    if(this.allowed())await this.transport.typing(false,AbortSignal.timeout(3000)).catch(()=>{})
  }
}
