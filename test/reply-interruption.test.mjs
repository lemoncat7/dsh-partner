import test from 'node:test'
import assert from 'node:assert/strict'
import {ReplyTurns,ReplySupersededError} from '../lib/channels/reply-turn.js'
import {ChannelManager} from '../lib/channels/manager.js'
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}

test('steering fences old send tickets, resumes the active response, and isolates sender/room/channel',async()=>{
 const turns=new ReplyTurns(),first=turns.begin('q','group:1:2'),other=turns.begin('q','group:1:3'),room=turns.begin('q','group:9:2'),channel=turns.begin('other','group:1:2')
 const old=first.capture(),settle=turns.interrupt('q','group:1:2')
 assert.throws(old,ReplySupersededError);assert.throws(()=>first.capture(),ReplySupersededError)
 other.capture()();room.capture()();channel.capture()()
 let ready=false;const waiting=first.ready().then(()=>{ready=true});await Promise.resolve();assert.equal(ready,false)
 settle(true);await waiting;first.capture()();assert.throws(old,ReplySupersededError)
 const next=turns.interrupt('q','group:1:2');next(false);await assert.rejects(first.ready(),ReplySupersededError)
 const replacement=turns.begin('q','group:1:2');replacement.capture()()
 for(const t of [first,other,room,channel,replacement])t.finish()
 assert.equal(turns.active.size,0)
})

test('an acknowledged first part is kept; admitted input suppresses unsent parts without errors or restart replay',async()=>{
 const channel={id:'qq',platform:'qq',accountId:'12345678',companionId:'c',enabled:true,updatedAt:1,direct:{baseUrl:'ws://local',targetId:''},qq:{groupReplies:true,groupIds:['99887766'],autonomousGroupIds:['99887766']}}
 const peer='group:99887766:22345678',companion={id:'c',name:'伙伴',characterCard:{enabled:true}},route={id:'r',kind:'channel',channelId:'qq',userId:peer,companionId:'c',sessionId:'s',cwd:'/tmp'}
 let state={companions:[companion],channels:[channel],sessions:[route],pairings:[],recentReceipts:[],notificationDeliveries:[]}
 const firstAck=deferred(),release=deferred(),steered=deferred();let paused=false
 const store={snapshot:()=>structuredClone(state),isCompanionRemoving:()=>false,subscribe:()=>()=>{},update:async fn=>{
  fn(state)
  if(!paused&&state.notificationDeliveries[0]?.targets[0]?.sentParts.includes(0)){paused=true;firstAck.resolve();await release.promise}
  return structuredClone(state)
 }}
 const sent=[],agents={groupReplyFocus:()=>undefined,steer:async()=>{steered.resolve();return false},replyDelivered:async()=>{},reply:async(c,ch,user,input,progress)=>{
  progress('working')
  return {text:'',attachments:[],chatParts:(input.text.includes('new-question')?['new-answer']:['old-first','old-second','old-third']).map(text=>({type:'text',text}))}
 }}
 const manager=new ChannelManager({logger:{info(){},warn(){}}},store,{read:async()=>({baseUrl:'ws://local',botToken:''})},agents,'/tmp')
 manager.sender=(_c,_credentials,_user,validate)=>({sendText:async(user,text)=>{validate?.();sent.push(text)}})
 const api={config:{targetId:''},progress:()=>undefined},event=(id,text)=>({id,text,sender:peer,targetId:'group:99887766',receivedAt:Date.now(),qqGroup:{groupId:'99887766',userId:'22345678',senderName:'tester',mentioned:true}})
 const first=event('old','old-question'),second=event('new','new-question')
 const running=manager.handleDirect(channel,api,first,new AbortController().signal,[first],()=>{})
 await firstAck.promise
 assert.deepEqual(sent,['old-first'])
 const replacing=manager.handleDirect(channel,api,second,new AbortController().signal,[second],()=>{})
 await steered.promise
 release.resolve();await Promise.all([running,replacing])
 assert.deepEqual(sent,['old-first','new-answer'])
 const record=state.notificationDeliveries.find(r=>r.id.includes('chat:qq:old'))
 assert.ok(record.supersededAt);assert.ok(record.completedAt)
 assert.deepEqual(record.targets[0].sentParts,[0]);assert.equal(record.targets[0].lastError,undefined)
 assert.equal(record.targets[0].retrySafe,undefined);assert.deepEqual(record.reply,{text:'',attachments:[]})
 assert.equal(manager.replyTurns.active.size,0)
})
