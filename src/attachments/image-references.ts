import {localConversationRoute,webMessageRoute} from '../channels/question-origin.js'
import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import {appendPluginRecord,pluginRecordOf,type SessionEvent} from '@deepseek-ai/dsh-session'
import type { ChannelSession } from '../domain.js'
import type { PartnerState } from '../domain.js'
import {isIdleContactNotice} from '../character/idle-contact.js'
import type { PartnerStore } from '../store.js'
import { inputOrigins } from '../conversation-history-recall.js'
import { runtimeSnapshot } from '../companions/runtime-policy.js'
import { backgroundToolScope } from '../execution/background-scope.js'
import { backgroundSourceAllowed,backgroundRunRoute } from '../execution/background-routing.js'
import { channelReplyAllowed } from '../channels/reply-access.js'
import { isInternalTaskNotice } from '../channels/delivery-policy.js'
import { memoryTerms } from '../memory-retrieval.js'
import { qqIdentityRelation } from '../channels/qq/identity-binding.js'
import { qqGroupPeer } from '../channels/qq/settings.js'

const MAX_REFERENCE_BYTES = 20 * 1024 * 1024
const missingReference = '当前会话找不到指定的参考图。请引用原消息、提供图片编号，或发一次原图。'
const referenceIntent = /(?:参考图|图生图|照片作参考|(?:参考|沿用|基于|照着|用|根据)(?:一下)?(?:上(?:次|面|一张)|之前|前面|刚才|我发|原图|[这那](?:张|些|几张))|[这那](?:张|几张)(?:图|图片|照|改|换|做)|上一(?:张|组)|刚(?:刚|才)(?:发|传)的|(?:继续|重新|接着)(?:改|编辑).{0,8}(?:图片|原图))/iu
const continuation = /(?:重来|再(?:画|做|改|来|生成)|接着|继续|重做|重新(?:画|生|改|做)|换(?:个|成|一下|背景|姿势|配色|风格)|改(?:成|一下|个|背景|配色|风格)|之前|上次|刚才|刚刚|沿用|同款|原图|this image|previous image)/iu
const withoutReferences = /(?:不(?:要|用|必|需要)(?:再)?(?:用)?(?:任何)?(?:参考(?:图|照)?|原图)|文生图|纯文字生图)/iu

export function imageRouteScope(state:PartnerState,route:ChannelSession):string|undefined{
  const channel=state.channels.find(c=>c.id===route.channelId&&c.companionId===route.companionId)
  return route.kind==='local'?'local':channel?JSON.stringify([channel.accountId,channel.direct?.baseUrl??'',channel.direct?.targetId??'']):undefined
}

export function imageReferenceId(ref: ImageAttachmentRef): string {
  return 'IMG-' + createHash('sha256').update(ref.attachmentId).digest('hex').slice(0, 20).toUpperCase()
}

interface GeneratedImage { path:string; digest:string; bytes:number; mediaType:string }
type ImageReference = { id:string; name:string; caption?:string; drawingPath?:string } & ({ref:ImageAttachmentRef} | {generated:GeneratedImage})
export interface ImageReferencePlan {
  selected: ImageReference[]
  inputId?: string
  explicit?: true
  handedOff?: true
  files?: { root: string; paths: string[] }
  issue?: string
  choices?: ImageReference[]
  available?: ImageReference[]
  drawingChoices?: string[]
  requested?: boolean
}

function attachments(event: SessionEvent): ImageReference[] {
  if (event.type !== 'user/message' || event.data.source.kind !== 'user') return []
  return event.data.content.flatMap(part => {
    if (part.type !== 'image' || typeof part.attachment?.attachmentId !== 'string') return []
    return [{ id: imageReferenceId(part.attachment), ref: part.attachment, name: basename(part.attachment.name ?? '图片') }]
  })
}

const textOf = (event: Extract<SessionEvent, {type:'user/message'}>) => event.data.content.flatMap(p => p.type === 'text' ? [p.text] : []).join('\n')
const unique = (images: ImageReference[]) => [...new Map(images.map(image => [image.id, image])).values()]
const imageIdFromArgument = (value:string) => basename(value).match(/^(IMG-[A-F0-9]{20})(?:\.(?:png|jpe?g|webp|gif))?$/i)?.[1]?.toUpperCase()
const imageIdsInText = (text:string) => [...new Set((text.match(/\bIMG-[A-F0-9]{20}\b/gi)??[]).map(id=>id.toUpperCase()))]

function receivedGroupReferences(events:readonly SessionEvent[],route:ChannelSession,before:number,scope:string|undefined):ImageReference[] {
  const room=qqGroupPeer(route.userId)?.groupId
  if(route.kind!=='channel'||!room||!scope)return []
  const origins=new Set(inputOrigins(events).filter(entry=>entry.channelId===route.channelId&&entry.imageScope===scope&&qqGroupPeer(entry.userId)?.groupId===room).map(entry=>entry.messageId))
  return events.flatMap(event=>event.seq<=before&&event.type==='user/message'&&origins.has(event.data.id)?attachments(event):[])
}

/** The owning input and exact channel route are the authority. Quote bodies and task prompts never grant access. */
export function planImageReferences(events: readonly SessionEvent[], route: ChannelSession, inputId: string, options: {
  privateFiles: boolean; root?: string|undefined; shared: boolean; scope?: string|undefined; autonomous?: boolean
}): { plan: ImageReferencePlan; recent: ImageReference[] } {
  const origins = new Map(inputOrigins(events).map(origin => [origin.messageId, origin]))
  const current = events.find(e => e.type === 'user/message' && e.data.id === inputId)
  if (current?.type !== 'user/message' || !(options.autonomous ? isIdleContactNotice(current) : current.data.source.kind === 'user')) return { plan: { selected: [] }, recent: [] }
  const owns = (id: string) => {
    const origin = origins.get(id)
    if (origin) return origin.routeId === route.id && origin.channelId === route.channelId && origin.userId === route.userId && (!origin.imageScope || origin.imageScope===options.scope)
    return route.kind === 'channel' ? route.inboundMessageIds?.includes(id) === true : !options.shared
  }
  if (!options.autonomous&&!owns(inputId)) return { plan: { selected: [], issue: missingReference }, recent: [] }
  const batches = events.flatMap(e => {
    if(e.type!=='user/message'||e.seq>current.seq||!owns(e.data.id))return []
    const images=attachments(e)
    return images.length?[{seq:e.seq,images}]:[]
  })
  const currentImages = unique(attachments(current))
  const origin = origins.get(inputId)
  const text = options.autonomous?'':route.kind === 'local' ? textOf(current) : origin?.imageRequest ?? ''
  const history=events.flatMap(e=>{
    if(e.seq>current.seq)return []
    const record=pluginRecordOf(e)
    if(record?.type!=='plugin:dsh-partner/image-use')return []
    const usage=record.data as ImageUse|undefined
    if(!usage||usage.routeId!==route.id||usage.scope!==options.scope||!Array.isArray(usage.images))return []
    return [{...usage,seq:e.seq}]
  })
  const used=history.filter(row=>row.images.length).map(row=>row.images)
  const recent = unique([...history.slice().reverse().flatMap(row=>[...row.generated??[],...row.images]),...batches.slice().reverse().flatMap(batch=>batch.images)])
  const terms=memoryTerms(text.replace(/(?:参考图?|用过|上次|之前|继续|刚才|重新|图片|生图|照片)/gu,''))
  const choices=()=>recent.map(image=>({image,hits:terms.filter(term=>(image.name+' '+(image.caption??'')).toLowerCase().includes(term)).length}))
    .sort((a,b)=>b.hits-a.hits).slice(0,8).map(item=>item.image)
  if(options.autonomous)return {plan:{selected:[],...(recent.length?{available:choices()}:{})},recent}
  // Only the exact user-authored path in this request can approve a workspace file.
  const fileLines = text.split('\n').map(line => line.match(/^\s*本次允许使用(?:私照|私有照片)[：:]\s*(.+?)\s*$/u)?.[1]).filter((path): path is string => Boolean(path))
  if (fileLines.length) {
    if (!options.privateFiles || !options.root) return { plan: { selected: [], explicit: true, issue: '私照只能由归属账号在私聊或本地会话为本次任务明确授权。' }, recent }
    return { plan: { selected: [], files: { root: options.root, paths: [...new Set(fileLines)] }, requested: true }, recent }
  }
  const ids = imageIdsInText(text)
  if (withoutReferences.test(text)) return { plan: { selected: [], requested: true, explicit: true }, recent }
  if (ids.length) {
    const byId = new Map(recent.map(image => [image.id, image]))
    const images = ids.map(id => byId.get(id))
    if (images.some(image => !image)) return { plan: { selected: [], explicit: true, issue: missingReference }, recent }
    return { plan: { selected: images as ImageReference[], requested: true, explicit: true }, recent }
  }
  if (origin?.imageMissing) return { plan: { selected: [], issue: missingReference }, recent }
  if (currentImages.length) return { plan: { selected: currentImages, requested: true }, recent }
  const prior=history.at(-1)
  const uploaded=batches.at(-1)
  const recentUpload=uploaded?.images
  const previous=/(?:用过|参考)/u.test(text)?used.at(-1):uploaded&&uploaded.seq>(prior?.seq??-1)?recentUpload:prior?.generated?.length?prior.generated:used.at(-1)
  const asksUpload=/(?:我(?:刚)?(?:发|传)|刚(?:发|传)的|上传|附件)/u.test(text)
  const last=asksUpload?recentUpload:previous??recentUpload
  if (/(?:不(?:要|用|准|许)|禁止)(?:再)?(?:用)?(?:私照|私有照片)/u.test(text))return {plan:{selected:[],requested:true},recent}
  if (/(?:私照|私有照片)/u.test(text)) return { plan: { selected: [], explicit: true, issue: '请明确指定本次允许使用的私照。' }, recent }
  if (referenceIntent.test(text)) {
    // A vague subject or an ambiguous singular reference must not pick an arbitrary image.
    if (last?.length && /(?:刚才|刚刚|刚发|上一(?:张|组)|前一张|上面|前面|[这那](?:张|几张)|我(?:刚)?发)/u.test(text) &&
      (unique(last).length === 1 || /(?:几张|这些|那些|一组|全部|两张|三张|四张)/u.test(text)))
      return { plan: { selected: unique(last), requested: true }, recent }
    if(last?.length===1&&/(?:上次(?:用过|的参考)|上一(?:张|组)|刚才|刚刚)/u.test(text))
      return {plan:{selected:last,requested:true},recent}
    return recent.length ? {plan:{selected:[],choices:choices(),requested:true},recent} : { plan: { selected: [], issue: missingReference }, recent }
  }
  // A follow-up may continue prior image work without a QQ quote or a number.
  // Present available IDs for selection; no unrelated or private workspace file enters this list.
  if(/(?:重来|重做|重新做|重新生成|按原来|再琢磨|没(?:按|笑)|背景.{0,8}假)/u.test(text)&&used.at(-1)?.length)
    return {plan:{selected:used.at(-1)!,requested:true},recent}
  if(continuation.test(text)&&recent.length) {
    const edit=/(?:改成|改一下|改个|改背景|换成|换一下|换个|换配色|换背景|换姿势|换风格|再改|接着改|继续改|同款)/u.test(text)
    return {plan:previous?.length===1&&edit?{selected:previous,requested:true}:{selected:[],choices:choices(),requested:edit},recent}
  }
  return { plan: { selected: [],...(recent.length?{available:choices()}:{}) }, recent }
}

function selectionDescription(plan: ImageReferencePlan): string {
  if (plan.issue) return plan.issue
  if (plan.files) return '本次已由用户明确选定工作区私照；调用 generate_image 时留空 referenceImages，平台会传入本次授权的文件。'
  if(plan.choices?.length)return '可从同一会话先前图片中按编号找回：'+JSON.stringify(plan.choices.map(({id,name,caption})=>({id,name,...(caption?{caption}:{})})))+'。如果本轮延续的是已有图，选对应编号传给 generate_image。无法确认就询问，不要任挑一张。'
  if(!plan.selected.length)return plan.handedOff?'本次不使用参考图。':''
  const ids=plan.selected.map(image=>image.id).join('、')
  if(plan.handedOff)return '前台已随任务传入参考图（按顺序）：'+ids+'。调用 generate_image 时留空 referenceImages，平台会直接带入这些图。'
  return plan.explicit
    ? '用户指定的参考图（按顺序）：'+ids+'。generate_image 可留空，由平台带入。'
    : '本次默认参考图（按顺序）：'+ids+'。generate_image 留空会沿用默认图。'
}

type ImageUse={routeId:string;scope?:string|undefined;images:ImageReference[];generated?:ImageReference[]}
declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {'plugin:dsh-partner/image-use':ImageUse}
}
export function renderBackgroundImageReferences(plan:ImageReferencePlan):string {
  return [selectionDescription(plan),!plan.handedOff&&plan.drawingChoices?.length?drawingPrompt(plan.drawingChoices,'generate_image'):''].filter(Boolean).join('\n')
}

function drawingPrompt(paths:readonly string[],tool:string):string {
  return '本伙伴已配置角色绘图参考：'+JSON.stringify(paths)+'。画这些角色并需要保持外观时，将对应路径传给 '+tool+' 的 referenceImages；其他题材省略。'
}

function approvedDrawingPaths(state:PartnerState,route:ChannelSession):string[] {
  const companion=state.companions.find(c=>c.id===route.companionId)
  const channel=state.channels.find(c=>c.id===route.channelId&&c.companionId===route.companionId)
  const privateOwner=route.kind==='local'||channel?.platform==='qq'&&!route.userId.startsWith('group:')&&!!qqIdentityRelation(channel.qq,route.userId)?.matched
  return privateOwner&&companion?.characterCard?.enabled?companion.characterCard.drawingReferences??[]:[]
}

type ReferenceUpload = { data: Uint8Array; mediaType: string; name: string; source: string }

async function matchHandoffFile(argument:string,recent:ImageReference[],root:string|undefined,signal:AbortSignal):Promise<ImageReference|undefined> {
  if(!root||!recent.length||!/\.(?:png|jpe?g|webp|gif)$/i.test(argument))return
  const base=await realpath(root).catch(()=>undefined)
  if(!base)return
  const path=await realpath(resolve(base,argument)).catch(()=>undefined)
  if(!path)return
  const within=relative(base,path)
  if(!within||within==='..'||within.startsWith('..'+sep)||isAbsolute(within))return
  const info=await stat(path).catch(()=>undefined)
  if(!info?.isFile()||!info.size||info.size>MAX_REFERENCE_BYTES)return
  const sameSize=recent.filter(image=>('ref' in image?image.ref.bytes:image.generated.bytes)===info.size)
  if(!sameSize.length)return
  const digest=createHash('sha256').update(await readFile(path,{signal})).digest('hex')
  return sameSize.find(image=>'ref' in image?image.ref.attachmentId==='sha256:'+digest:image.generated.digest===digest)
}

const drawingTypes:Readonly<Record<string,string>>={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif'}
async function matchDrawingFile(argument:string,allowed:readonly string[],root:string|undefined,signal:AbortSignal):Promise<ImageReference|undefined> {
  if(!root)return
  const drawingPath=allowed.find(path=>resolve(root,path)===resolve(root,argument))
  if(!drawingPath)return
  const base=await realpath(root)
  const path=await realpath(resolve(base,drawingPath)).catch(()=>undefined)
  const within=path&&relative(base,path)
  const mediaType=path&&drawingTypes[extname(path).toLowerCase()]
  if(!path||!within||within==='..'||within.startsWith('..'+sep)||isAbsolute(within)||!mediaType)throw Error('配置的角色参考图不在工作区内，或文件不可用：'+basename(drawingPath))
  const info=await stat(path)
  if(!info.isFile()||!info.size||info.size>MAX_REFERENCE_BYTES)throw Error('配置的角色参考图文件大小无效：'+basename(drawingPath))
  const digest=createHash('sha256').update(await readFile(path,{signal})).digest('hex')
  return {id:'IMG-'+digest.slice(0,20).toUpperCase(),name:basename(path),drawingPath,generated:{path,digest,bytes:info.size,mediaType}}
}

async function readApprovedFiles(plan: NonNullable<ImageReferencePlan['files']>, signal: AbortSignal): Promise<ReferenceUpload[]> {
  const root = await realpath(plan.root)
  const files: ReferenceUpload[] = []
  let total = 0
  for (const name of plan.paths) {
    signal.throwIfAborted()
    const path = await realpath(resolve(root,name)).catch(() => undefined)
    const within = path && relative(root,path)
    if (!path || !within || within==='..' || within.startsWith('..'+sep) || isAbsolute(within)) throw Error('本次授权的私照无法在当前工作区内找到。')
    const info = await stat(path)
    total += info.size
    if (!info.isFile() || !info.size || info.size>MAX_REFERENCE_BYTES || total>64*1024*1024) throw Error('所选参考图文件大小无效。')
    files.push({ data:await readFile(path,{signal}),mediaType:'',name:basename(path),source:within })
  }
  return files
}

export class PartnerImageReferences {
  constructor(private readonly ctx: Context, private readonly store: PartnerStore) {}

  managesSession(id:string):boolean {
    const state=this.store.snapshot()
    return state.sessions.some(route=>route.sessionId===id)||state.executionRuns.some(run=>run.sessionId===id&&!!run.background)
  }

  private source(agent: Agent, inputId?: string) {
    const state = runtimeSnapshot(this.store)
    const routes = state.sessions.filter(r => r.sessionId === agent.session.id)
    if (!routes.length) return
    const events = agent.session.snapshotEvents()
    let current:SessionEvent|undefined
    for(let index=events.length-1;index>=0;index--){
      const event=events[index]!
      if(!inputId&&event.type==='turn/end')break
      if(event.type!=='user/message')continue
      if(inputId?event.data.id===inputId:event.data.source.kind==='user'||isInternalTaskNotice(event)||isIdleContactNotice(event)){current=event;break}
    }
    if (current?.type !== 'user/message') return
    const autonomous=isIdleContactNotice(current)
    if(!autonomous&&current.data.source.kind!=='user')return
    const id = current.data.id
    const origin = inputOrigins(events).find(o => o.messageId === id)
    const route = autonomous?routes.find(r=>r.idleContactState?.messageId===id&&!r.idleContactState.cancelled):(origin ? routes.find(r => r.id === origin.routeId && r.channelId === origin.channelId && r.userId === origin.userId) :
      routes.find(r => r.kind === 'channel' && r.inboundMessageIds?.includes(id))) ?? webMessageRoute(agent.session.id,events,routes,id)
    if (!route) return
    const channel = state.channels.find(c => c.id === route.channelId)
    if (route.kind === 'channel' && !channelReplyAllowed(state,route.channelId,route.userId)) return
    const scope=imageRouteScope(state,route)
    if(origin?.imageScope&&origin.imageScope!==scope)return
    const privateFiles = route.kind === 'local' || !!(channel?.platform === 'qq' && !route.userId.startsWith('group:') && qqIdentityRelation(channel.qq,route.userId)?.matched)
    if(autonomous&&!privateFiles)return
    return { events, current, route, drawingPaths:approvedDrawingPaths(state,route), options:{ privateFiles:privateFiles&&!autonomous, autonomous, root:agent.session.header.cwd, shared:routes.some(r => r.kind === 'channel'), scope } }
  }

  async plan(agent: Agent, route: ChannelSession, inputId: string, handoff?:{ references:readonly string[]|undefined; input:string; signal:AbortSignal }): Promise<ImageReferencePlan|undefined> {
    const source = this.source(agent,inputId)
    if (source?.route.id !== route.id) {
      if(handoff?.references?.length)throw Error(missingReference)
      return
    }
    const {plan,recent}=planImageReferences(source.events,route,inputId,source.options)
    if(source.options.autonomous&&handoff&&!withoutReferences.test(handoff.input)&&referenceIntent.test(handoff.input))plan.requested=true
    if(source.drawingPaths.length&&!plan.files&&!plan.explicit&&(plan.requested||handoff&&/(?:图|照|肖像|形象|image|portrait)/iu.test(handoff.input))){
      if(plan.issue===missingReference)delete plan.issue
      if(!plan.issue)plan.drawingChoices=source.drawingPaths
    }
    if(handoff&&(plan.issue===missingReference||!plan.explicit&&!plan.files)){
      const userIds=plan.explicit?imageIdsInText(inputOrigins(source.events).find(origin=>origin.messageId===inputId)?.imageRequest??''):[]
      const fromInput=userIds.length?userIds:imageIdsInText(handoff.input)
      const supplied=userIds.length?userIds:handoff.references
      const byId=new Map(recent.map(image=>[image.id,image]))
      if((supplied??fromInput).some(value=>!byId.has(imageIdFromArgument(value)??value))){
        for(const image of receivedGroupReferences(source.events,route,source.current.seq,source.options.scope))if(!byId.has(image.id))byId.set(image.id,image)
      }
      const references=supplied??(fromInput.length>0&&fromInput.length<=8&&fromInput.every(id=>byId.has(id))?fromInput:undefined)
      if(references){
        const selected:ImageReference[]=[]
        for(const argument of references){
          const id=imageIdFromArgument(argument)
          const image=(id&&byId.get(id))||await matchDrawingFile(argument,source.drawingPaths,source.options.root,handoff.signal)||await matchHandoffFile(argument,[...byId.values()],source.options.root,handoff.signal)
          if(!image)throw Error('前台交接的参考图在原会话中找不到。请用已收到或用过的图片编号。')
          selected.push(image)
        }
        const images=unique(selected)
        if(images.length>8)throw Error('本次参考图最多 8 张。')
        return {selected:images,inputId,requested:true,handedOff:true}
      }
    }
    if(handoff?.references&&plan.explicit&&plan.issue)throw Error(plan.issue)
    if(plan.selected.length>8)throw Error('本次参考图最多 8 张。')
    if(source.options.autonomous&&plan.requested){
      if(plan.available?.length)plan.choices=plan.available
      else if(!plan.drawingChoices?.length)plan.issue='这次自主绘图没有可用参考图。可以使用已配置的角色图或同一私聊中可复用的图片。'
    }
    if(plan.files||plan.explicit&&!plan.issue)return {...plan,inputId,handedOff:true}
    return plan.requested||plan.issue||plan.choices?.length||plan.available?.length||plan.drawingChoices?.length?{...plan,inputId}:undefined
  }

  context(agent: Agent): string {
    const source = this.source(agent)
    if (!source || !(source.options.autonomous&&source.drawingPaths.length) && !source.current.data.content.some(p => p.type==='image'||p.type==='text'&&(/图|照|IMG-|image|photo/iu.test(p.text)||continuation.test(p.text)))) return ''
    const { events,current,route,options } = source
    const { plan,recent } = planImageReferences(events,route,current.data.id,options)
    return [
      '同会话已接收或使用过的图片可按编号或当天归档路径直接引用。找不到指定图时，从当前会话查找相应编号，仍找不到就确认来源；工作区的私照不能拿来补位。用户问图编号时可直接告知。',
      source.drawingPaths.length&&!plan.files&&!plan.explicit?drawingPrompt(source.drawingPaths,'partner_background_task'):'',
      plan.issue===missingReference&&source.drawingPaths.length&&!plan.explicit?'':selectionDescription(plan),
      recent.length ? '本发言人在当前会话的近期图片（新到旧）：'+JSON.stringify(recent.slice(0,6).map(({id,name,caption})=>({id,name,...(caption?{caption}:{})}))) : '',
    ].filter(Boolean).join('\n')
  }

  async resolve(agent: Agent | undefined, requested: string[], signal: AbortSignal): Promise<{uploads:ReferenceUpload[];confirm?(generated:GeneratedImage[]):void} | undefined> {
    if (!agent) return
    const state = runtimeSnapshot(this.store)
    const task = state.executionRuns.find(r => r.sessionId === agent.session.id && r.background)
    const scoped = task ? backgroundToolScope(this.store,task.ownerCompanionId,agent.session.id) : undefined
    const partner = state.sessions.some(r => r.sessionId===agent.session.id)
    if (!partner && !task) return
    if (task && (!scoped || !backgroundSourceAllowed(state,task))) throw Error('后台参考图的原会话授权已失效。')
    const source = partner ? this.source(agent) : undefined
    const plan = task?.background?.imageReferences ?? (source ? planImageReferences(source.events,source.route,source.current.data.id,source.options).plan : { selected: [] })
    if(source?.drawingPaths.length&&!plan.explicit&&!plan.files){
      plan.drawingChoices=source.drawingPaths
      if(plan.issue===missingReference)delete plan.issue
    }
    if (plan.issue) throw Error(plan.issue)
    const requestedIds=plan.handedOff?[]:requested.map(value=>imageIdFromArgument(value)??value)
    let selected=plan.selected
    const defaultIds=new Set(selected.map(image=>image.id))
    const background=task?.background
    const canSelectHistory=!plan.files&&!plan.explicit&&(selected.length?!!background:!plan.requested||!!plan.choices?.length)
    if(!plan.handedOff&&(canSelectHistory||plan.drawingChoices?.length)&&requestedIds.some(id=>!defaultIds.has(id))){
      const candidates=new Map([...selected,...(plan.choices??plan.available??[])].map(image=>[image.id,image]))
      const unmatched=requestedIds.some(id=>!candidates.has(id))
      if(unmatched){
        const parent=background&&this.ctx.agents.get(background.sourceSessionId as Agent['session']['id'])
        const inputId=plan.inputId??background?.supplementInputIds?.at(-1)??background?.resumeInputId??background?.inputId
        const request=background?(parent&&inputId?this.source(parent,inputId):undefined):source
        if(request&&(!background||request.route.id===background.routeId)){
          const {plan:atInput,recent}=planImageReferences(request.events,request.route,request.current.data.id,request.options)
          if(!atInput.explicit&&!atInput.issue)for(const image of recent)candidates.set(image.id,image)
        }
      }
      const root=background?.sourceCwd??source?.options.root
      const chosen=await Promise.all(requested.map((value,index)=>candidates.get(requestedIds[index]!)??matchDrawingFile(value,plan.drawingChoices??[],root,signal)))
      if(chosen.every(image=>!!image))selected=unique(chosen)
    }
    const expected = selected.map(image => image.id)
    if(plan.requested&&(plan.choices?.length||plan.drawingChoices?.length)&&!selected.length)throw Error(missingReference)
    const drawingRoot=background?.sourceCwd??source?.options.root
    if (!plan.handedOff&&requested.some((value,index) => !expected.includes(requestedIds[index]!) && !plan.files?.paths.includes(value) &&
      !(drawingRoot&&selected.some(image=>image.drawingPath&&resolve(drawingRoot,image.drawingPath)===resolve(drawingRoot,value)))))
      throw Error(plan.explicit?'请使用用户本次指定的参考图编号。':'找不到这张图在同一会话里的引用记录，请用同一会话已收到或用过的图片编号。私照请单独指定。')
    const count=plan.files?.paths.length??selected.length
    if(count>8)throw Error('本次参考图最多 8 张，请明确选出要用的图片编号。')
    const routeId=task?.background?.routeId??source?.route.id
    const route=task?backgroundRunRoute(state.sessions,task):source?.route
    const scope=route&&imageRouteScope(state,route)
    const assertCurrent=()=>{
      scoped?.authorize()
      if(!route)return
      const live=runtimeSnapshot(this.store)
      const current=task?backgroundRunRoute(live.sessions,task):route.kind==='local'?localConversationRoute(route.sessionId,live.sessions):live.sessions.find(r=>r.id===route.id&&r.sessionId===route.sessionId&&r.userId===route.userId)
      if(!current||imageRouteScope(live,current)!==scope||current.kind==='channel'&&!channelReplyAllowed(live,current.channelId,current.userId))
        throw Error('当前会话参考图授权已失效。')
      if(plan.files&&current.kind==='channel'){
        const channel=live.channels.find(c=>c.id===current.channelId)
        if(!qqIdentityRelation(channel?.qq,current.userId)?.matched)throw Error('本次私照授权已失效。')
      }
      if(selected.some(image=>image.drawingPath&&!approvedDrawingPaths(live,current).includes(image.drawingPath)))throw Error('角色参考图配置已变化，请重新选图。')
    }
    if (plan.files){const uploads=await readApprovedFiles(plan.files,signal);assertCurrent();return {uploads}}
    let total=0
    const uploads:ReferenceUpload[]=[]
    for(const image of selected){
      signal.throwIfAborted()
      const bytes='ref' in image?image.ref.bytes:image.generated.bytes
      total+=bytes
      if(bytes>MAX_REFERENCE_BYTES||total>64*1024*1024)throw Error('所选参考图超出大小上限，请减少图片。')
      if('generated' in image){
        const generated=image.generated
        const info=await stat(generated.path).catch(()=>undefined)
        if(!info?.isFile()||info.size!==bytes)throw Error(missingReference)
        const data=await readFile(generated.path,{signal})
        if(createHash('sha256').update(data).digest('hex')!==generated.digest)throw Error(missingReference)
        uploads.push({data,mediaType:generated.mediaType,name:image.name,source:image.id})
        continue
      }
      const saved=await this.ctx.attachments.readImage(image.ref,signal).catch(()=>{
        signal.throwIfAborted()
        throw Error('图片 '+image.id+' 的原附件已不可读。'+missingReference)
      })
      uploads.push({ data:saved.data,mediaType:saved.ref.mediaType,name:image.name,source:image.id })
    }
    assertCurrent()
    const peer=task?this.ctx.agents.get(task.background!.sourceSessionId as Agent['session']['id']):agent
    return {uploads,...(route&&peer?{confirm:(outputs:GeneratedImage[])=>{
      try{
        assertCurrent()
        const caption=(task?.background?.label??(source&&textOf(source.current))??'').trim().slice(0,120)
        const generated=outputs.map(file=>({id:'IMG-'+file.digest.slice(0,20).toUpperCase(),name:basename(file.path),generated:file,...(caption?{caption}:{})}))
        const reusable=selected.filter(image=>!image.drawingPath)
        if(reusable.length||generated.length)appendPluginRecord(peer.session,'plugin:dsh-partner/image-use',{routeId:route.id,scope,images:reusable,generated})
      }catch(error){this.ctx.logger.warn('记录已使用图片失败：'+String(error))}
    }}:{})}
  }
}
