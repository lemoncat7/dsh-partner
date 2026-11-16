import type {ToolDefinition} from '@deepseek-ai/dsh-tools'
import type {PartnerStore} from '../store.js'
import {questionOrigin} from '../channels/question-origin.js'
import {currentAffectionAudience} from '../character/affection-context.js'
import type {ContinuousService} from './service.js'

export const CONTINUOUS_GUIDANCE='陪看文字直播、持续留意一个正在变化的网页，用 partner_continuous_task start 建立持续任务；仅打开标签页或记录临时约定不等于后台观察。先用浏览器确认 tabId 和正文，start 提供 title、instruction、until、可选 selector 与用户原话 evidence；由系统绑定当前会话。后台去重、合并新增内容，受 token 预算约束，只在值得聊时唤起原会话。list/status 查看真实状态；用户明确不看了/结束陪伴时 stop，不把一轮回复结束或暂时沉默当作任务结束。不支持视频/音频理解。'
export function continuousTool(owner:string,store:PartnerStore,service:ContinuousService):ToolDefinition {
 return {name:'partner_continuous_task',description:CONTINUOUS_GUIDANCE,
 parameters:{type:'object',additionalProperties:false,required:['action'],properties:{action:{type:'string',enum:['list','status','start','pause','resume','stop']},id:{type:'string'},title:{type:'string',maxLength:100},instruction:{type:'string',maxLength:400},until:{type:'string',maxLength:200},tabId:{type:'string',maxLength:200},selector:{type:'string',maxLength:500},evidence:{type:'string',maxLength:400}}},
 presentCall:()=>({card:'generic',title:'持续任务'}),output:{schema:{type:'object'},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},
 async execute(raw,exec){
  const agent=exec.agent;if(!agent)throw Error('需要当前会话')
  const state=store.snapshot(),events=agent.session.snapshotEvents(),route=questionOrigin(agent.session.id,events,state.sessions)??state.sessions.find(r=>r.companionId===owner&&r.sessionId===agent.session.id&&r.kind==='local')
  if(!route||route.companionId!==owner||!currentAffectionAudience(state,owner,agent.session.id,events))throw Error('持续任务仅允许归属账号或本地会话管理')
  const args=raw as Record<string,unknown>,listed=service.list(owner),tasks=listed.tasks.filter(t=>t.routeId===route.id)
  if(args.action==='list'||args.action==='status')return {...listed,tasks}
  const user=[...events].reverse().find(e=>e.type==='user/message'&&(e.data.source.kind==='user'||e.data.source.kind==='plugin:@lemoncat7/dsh-partner'&&'form'in e.data.source&&e.data.source.form==='notice'))
  if(user?.type!=='user/message'||user.data.source.kind!=='user')throw Error('只能根据当前用户要求创建或调整持续任务')
  if(typeof args.evidence!=='string'||args.evidence.trim().length<2||!user.data.content.filter(b=>b.type==='text').map(b=>b.text).join('\n').replace(/\s/g,'').includes(args.evidence.replace(/\s/g,'')))throw Error('请提供当前用户原话 evidence，不能用自己的承诺建立任务')
  exec.signal.throwIfAborted()
  if(args.action==='start'){const created=await service.create(owner,{...args,routeId:route.id},args.evidence,exec.signal);return {task:service.list(owner).tasks.find(t=>t.id===created.id)}}
  if(!['pause','resume','stop'].includes(String(args.action))||!tasks.some(t=>t.id===args.id))throw Error('任务不属于当前会话或操作无效')
  await service.control(owner,String(args.id),args.action as 'pause'|'resume'|'stop','根据用户要求：'+args.evidence)
  return {task:service.list(owner).tasks.find(t=>t.id===args.id)}
 }}
}
