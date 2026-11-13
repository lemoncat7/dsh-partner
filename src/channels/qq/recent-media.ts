import type {DirectMessage} from '../direct/transport.js'

const TTL=120_000
const mentionsMedia=/(?:图|照片|截图|相片|这张|那张|上面|刚发|附件|文件|视频|工作流|json|image|picture|photo|screenshot|file|video)/iu
/** Ephemeral references only. Bystander attachments are never downloaded or written to memory. */
export class QqRecentMedia {
 private readonly lanes=new Map<string,{at:number;messages:DirectMessage[]}>()
 constructor(private readonly now=()=>Date.now()){}
 private key(channel:string,event:DirectMessage){return JSON.stringify([channel,event.qqGroup?.groupId,event.sender])}
 private prune(){for(const [key,value] of this.lanes)if(this.now()-value.at>TTL)this.lanes.delete(key)}
 observe(channel:string,event:DirectMessage):void {
  this.prune()
  if(!event.qqGroup)return
  const key=this.key(channel,event)
  if(event.qqGroup.otherMention||event.qqGroup.replyTo==='other'){this.lanes.delete(key);return}
  const media=event.media?.filter(m=>['image','video','file'].includes(m.kind??'')&&Boolean(m.source||m.fileId||m.qq)&&m.source.length<=8192).slice(0,4)
  if(!media?.length)return
  const now=this.now(),at=event.timestamp??event.receivedAt??now
  if(!Number.isFinite(at)||at>now||now-at>TTL)return
  const previous=this.lanes.get(key)
  if(previous&&at<previous.at)return
  const messages=previous&&at-previous.at<=3000?previous.messages.filter(m=>m.id!==event.id):[]
  messages.push({id:event.id,sender:event.sender,...(event.targetId?{targetId:event.targetId}:{}),text:'',timestamp:at,qqGroup:{...event.qqGroup},media:structuredClone(media)})
  this.lanes.delete(key);this.lanes.set(key,{at,messages:messages.slice(-4)})
  if(this.lanes.size>256)this.lanes.delete(this.lanes.keys().next().value!)
 }
 select(channel:string,event:DirectMessage,events:readonly DirectMessage[]):DirectMessage[] {
  this.prune()
  if(!event.qqGroup||!event.text.trim()||events.some(e=>e.media?.length||e.qqReplyId||e.qqGroup?.hasReply||e.qqGroup?.otherMention||e.qqGroup?.replyTo==='other'))return []
  const entry=this.lanes.get(this.key(channel,event))
  const at=event.timestamp??event.receivedAt??this.now()
  if(!entry||at<entry.at||at-entry.at>TTL||at-entry.at>30_000&&!mentionsMedia.test(event.text))return []
  let remaining=4
  return entry.messages.filter(m=>!events.some(e=>e.id===m.id)).slice().reverse().map(m=>{
   const media=remaining>0?m.media!.slice(-remaining):[];remaining-=media.length
   return {...m,media}
  }).filter(m=>m.media.length).reverse()
 }
 submitted(channel:string,events:readonly DirectMessage[]):void {
  for(const event of events){
   const key=this.key(channel,event),entry=this.lanes.get(key)
   if(!entry)continue
   const index=entry.messages.findIndex(m=>m.id===event.id)
   if(index<0)continue
   // Submitting the latest batch also retires older attachments; do not trickle
   // omitted old attachments into unrelated subsequent replies.
   entry.messages=entry.messages.slice(index+1)
   if(!entry.messages.length)this.lanes.delete(key)
  }
 }
}
