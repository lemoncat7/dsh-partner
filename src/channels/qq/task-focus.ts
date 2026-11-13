import type {DirectMessage} from '../direct/transport.js'
import {routeGroupReply} from './reply-rules.js'
import {actualAction} from '../../chat/action-obligation.js'
import {needsTaskPreamble} from '../../execution/task-preamble.js'

export interface GroupTaskFocus {userId:string;startedAt:number;working:boolean;sentAt?:number}
export function taskTool(name:string,args:unknown):boolean {
 const action=actualAction(name,args)
 return needsTaskPreamble(action.name,action.args)||action.name==='partner_chat_say'&&action.args.beforeTools===true||action.name==='partner_chat_progress'
}
/** Routing only: no model call, role text or durable conversation mutation. */
export function groupTaskInput(event:DirectMessage,focus:GroupTaskFocus|undefined,name:string,now=Date.now()):'normal'|'steer'|'queue'|'observe' {
 if(!event.qqGroup||!focus)return 'normal'
 const group=event.qqGroup,text=event.text.replace(/^\[对方 @ 了你\]\s*/u,'').trim()
 if(group.otherMention||group.replyTo==='other')return 'observe'
 const addressed=routeGroupReply(event,{name,owner:false,affection:0,now,seed:''})?.route==='direct'
 const owner=event.sender===focus.userId
 const request=text.startsWith(name)&&name?text.slice(name.length).replace(/^[\s，,:：]+/u,''):text
 // Explicit changes from the task author remain interruptible even after minutes of work.
 const control=/^(?:等等[，,\s]*)?(?:先)?(?:别做|别画|别生成|停(?:一下|下|止|止执行|止任务)?|取消(?:任务|这个任务)?|别做了|不用做了|不用了|别画了|别生成了|算了|暂停(?:任务|执行)?)[\s。.!！]*$/iu.test(request)||/^(?:补充(?:一下)?[：:，,\s]|(?:刚才|刚刚|这个|这次|那张|图片|任务|要求).{0,16}(?:改成|改为|换成|不要|不用)|(?:改成|改为|换成|改用|加上|不要用|别用|我说的是|不用.{0,8}了|不是.{1,30}是)|(?:背景|颜色|尺寸|风格|构图|比例|格式|数量|参考图).{0,8}(?:用|保持|要|不要|改|换|设|按))/u.test(request)||/^(?:stop|cancel|pause)(?:\s+(?:it|the task))?[.!\s]*$/iu.test(request)
 if(owner&&(control||group.replyTo==='self'&&Boolean(event.media?.length)))return 'steer'
 if(focus.working)return addressed?'queue':'observe'
 // Another member may offer a new shared topic; use normal selective judgment, never steer their words into this speaker's reply.
 if(!owner)return addressed?'queue':'normal'
 // Before the first confirmed reply, keep joining the same speaker's chat fragments.
 // Once one part is sent, finish that reply instead of repeatedly reopening it.
 if(owner&&focus.sentAt===undefined&&(event.media?.length||text&&!/^[\s\p{P}\p{S}]+$/u.test(text)))return 'steer'
 return addressed?'queue':'observe'
}
