import type {ReplyActivity} from '../execution/reply-progress.js'
import type {ProgressTransport} from './direct/progress-transport.js'

type Tool={name:string;started:number;ended?:number;failed?:boolean}
/** Protocol-independent ordered blocks. Only the current tool block is editable.
 * Intermediate delivery is best effort; uncertain POSTs are never replayed. */
export class ReplyBlocks {
  private tools=new Map<string,Tool>()
  private id:string|undefined
  private last=''
  private disabled=false
  private queued=0
  private tail:Promise<void>=Promise.resolve()
  constructor(private transport:ProgressTransport,private allowed:()=>boolean,private signal:AbortSignal){}
  private enqueue(action:()=>Promise<void>):Promise<void>{
    if(this.queued>=64){this.disabled=true;return this.tail}
    this.queued++
    this.tail=this.tail.then(async()=>{if(!this.disabled&&this.allowed()&&!this.signal.aborted)await action()}).catch(()=>{this.disabled=true}).finally(()=>{this.queued--})
    return this.tail
  }
  private requestSignal(){
    this.signal.throwIfAborted()
    if(!this.allowed())throw Error('渠道或联系人授权已撤销')
    return AbortSignal.any([this.signal,AbortSignal.timeout(3000)])
  }
  update(activity:ReplyActivity):void{
    const now=Date.now()
    void this.enqueue(async()=>{
      if(activity.kind==='text'){
        await this.seal()
        await this.transport.send(activity.text,this.requestSignal())
      }else if(activity.kind==='tool-start'){
        if(this.tools.has(activity.id))return
        if(this.tools.size>=32)await this.seal('后续工具将在下一块继续。')
        this.tools.set(activity.id,{name:activity.name,started:now})
        if(!this.id)await this.render()
      }else{
        const tool=this.tools.get(activity.id)
        if(tool&&tool.ended===undefined){tool.ended=now;tool.failed=activity.failed}
      }
    })
  }
  private async render(note=''){
    if(!this.tools.size)return
    const lines=[...this.tools.values()].map(tool=>`- \`${tool.name}\` · ${tool.ended===undefined?(note?'未确认完成':'执行中'):tool.failed?'失败':'完成'} · ${Math.max(0,Math.round(((tool.ended??Date.now())-tool.started)/1000))} 秒`)
    const text=['**工具过程**',...lines,note].filter(Boolean).join('\n')
    if(!this.id)this.id=await this.transport.create(text,this.requestSignal())
    else if(text!==this.last)await this.transport.edit(this.id,text,this.requestSignal())
    this.last=text
  }
  private async seal(note=''){
    await this.render(note)
    this.id=undefined;this.last='';this.tools.clear()
  }
  flush():Promise<void>{return this.enqueue(()=>this.render())}
  boundary(note:string):Promise<void>{return this.enqueue(()=>this.seal(note))}
  async finish(text:string):Promise<void>{
    await this.boundary('本轮处理已结束。')
    this.signal.throwIfAborted()
    if(!this.allowed())throw Error('渠道或联系人授权已撤销')
    await this.transport.send(text||'本次处理已结束，未生成文字回复。',AbortSignal.any([this.signal,AbortSignal.timeout(35000)]))
  }
}
