import test from 'node:test'
import assert from 'node:assert/strict'
import {chatTools} from '../lib/chat/tools.js'
import {IDLE_CONTACT_NOTICE, ACTIVITY_PROTOCOL_PROMPT} from '../lib/character/idle-contact.js'
import {idleActivityFinishTool} from '../lib/character/activity-tool.js'
import {channelReplyPartsAfter} from '../lib/channels/delivery-policy.js'
import {normalizeCharacterCard,emptyCharacterCard} from '../lib/character/domain.js'
import {renderConversationTurn,renderConversationBehavior} from '../lib/character/conversation-behavior.js'
import {ChannelManager} from '../lib/channels/manager.js'

function fixture(){
 const card={enabled:true,segmentedReplies:true,length:'short'},c={id:'c',updatedAt:1,characterCard:card,idleContact:{enabled:true,routeId:'target'}}
 const route={id:'target',sessionId:'s',kind:'channel',companionId:'c',channelId:'qq',userId:'12345678',idleContactState:{kind:'autonomous',messageId:'idle',userMessageId:'u',policyRevision:1}}
 const state={companions:[c],sessions:[{id:'local',kind:'local',companionId:'c',sessionId:'s'},route],channels:[{id:'qq',platform:'qq',enabled:true,companionId:'c',qq:{privateReplies:true,identityBinding:{enabled:true,qqIds:['12345678']}}}],pairings:[{channelId:'qq',userId:'12345678',status:'approved'}]}
 const store={snapshot:()=>state,isCompanionRemoving:()=>false,update:async fn=>fn(state)}
 const events=[{seq:1,type:'user/message',data:{id:'u',source:{kind:'user'},content:[]}},{seq:2,type:'turn/start',data:{turn:1}},{seq:3,type:'user/message',data:{id:'idle',content:[],source:{kind:'plugin:@lemoncat7/dsh-partner',form:'notice',summary:IDLE_CONTACT_NOTICE}}}]
 let ended=0;const controller=new AbortController(),exec={agent:{session:{id:'s',snapshotEvents:()=>events}},signal:controller.signal,concludeTurn:()=>ended++}
 const sent=[],manager=Object.create(ChannelManager.prototype);manager.store=store;manager.agents={idleContactDeliveryCurrent:async()=>!c.sleepState&&!route.idleContactState.cancelled}
 manager.queueProactive=async(r,receipt,reply,valid,exact)=>{assert.equal(valid(),true);assert.equal(exact,true);assert.equal(r.id,'target');sent.push({receipt,reply})}
 const tool=chatTools('c',store,{},{},{},'/api',undefined,(...args)=>manager.sendIdleIntermediate(...args)).find(t=>t.name==='partner_chat_reply')
 return {c,route,store,events,exec,sent,tool,controller,ended:()=>ended}
}
test('autonomous speech reaches only claimed destination before sleep and is never sent again at turn end',async()=>{
 const f=fixture(),result=await f.tool.execute({messages:[{text:'先去睡啦'}],continueTurn:true},f.exec)
 assert.equal(f.sent.length,1);assert.equal(f.ended(),0);assert.equal(result.delivered,true);assert.equal(result.originRouteId,'target')
 assert.equal(f.sent[0].reply.idleContactOrigin.messageId,'idle')
 f.events.push({seq:4,type:'tool/result',data:{message:{isError:false},meta:result}})
 f.c.sleepState={episode:{wakeAt:Date.now()+60000}}
 const finish=await idleActivityFinishTool('c',f.store).execute({reason:'休息'},f.exec)
 assert.equal(finish.kind,'partner-activity-silent-v1');assert.equal(f.ended(),1)
 f.events.push({seq:5,type:'tool/result',data:{message:{isError:false},meta:finish}},{seq:6,type:'turn/end',data:{reason:{kind:'completed'}}})
 assert.equal(channelReplyPartsAfter(f.events,0,true).text,'');assert.equal(f.sent.length,1)
})
for(const change of ['new-input','revoked','cancelled','sleep'])test('autonomous intermediate rejects '+change,async()=>{
 const f=fixture()
 if(change==='new-input')f.events.push({seq:4,type:'user/message',data:{id:'new',source:{kind:'user'}}})
 if(change==='revoked')f.c.idleContact.enabled=false
 if(change==='cancelled')f.controller.abort()
 if(change==='sleep')f.c.sleepState={episode:{wakeAt:Date.now()+60000}}
 await assert.rejects(f.tool.execute({messages:[{text:'过时告别'}],continueTurn:true},f.exec));assert.equal(f.sent.length,0);assert.equal(f.ended(),0)
})
test('voice preference survives settings roundtrip and exclusive context without changing persona',()=>{
 const card=normalizeCharacterCard({...emptyCharacterCard(),enabled:true,roleText:'只用此人格',length:'short',shortVoiceReplies:true,exclusivePrompt:true})
 assert.equal(normalizeCharacterCard(JSON.parse(JSON.stringify(card))).shortVoiceReplies,true)
 assert.match(renderConversationTurn(card,1),/短句优先语音，长句用文字/)
 assert.doesNotMatch(renderConversationTurn({...card,length:'rich'},1),/短句优先语音/)
 assert.doesNotMatch(renderConversationTurn({...card,shortVoiceReplies:false},1),/短句优先语音/)
 assert.throws(()=>normalizeCharacterCard({...card,shortVoiceReplies:'true'}))
 assert.match(ACTIVITY_PROTOCOL_PROMPT,/确认送达，再调用 partner_sleep/)
 assert.doesNotMatch(renderConversationBehavior(card),/partner_sleep sleep|准备休息的话/)
})


test('local autonomous chat preserves its local audience without channel pairing',async()=>{
 const f=fixture();f.route.kind='local';f.route.channelId='';f.route.userId='';
 const result=await f.tool.execute({messages:[{text:'想到了另一个玩法'}]},f.exec)
 assert.equal(result.parts[0].text,'想到了另一个玩法');assert.equal(f.ended(),1);assert.equal(f.sent.length,0)
})
