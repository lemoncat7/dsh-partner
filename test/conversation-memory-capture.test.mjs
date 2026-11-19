import test from 'node:test'
import assert from 'node:assert/strict'
import {Session} from '@deepseek-ai/dsh-session'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {PartnerAgentRuntime} from '../lib/agent-runtime.js'
import {createDefaultCompanion} from '../lib/domain.js'
import {conversationReplyText,channelReplyPartsAfter} from '../lib/channels/delivery-policy.js'
import {groupMemorySessions} from '../lib/ui/memory/session-groups.js'

function fixture(){
 const session=Session.create('private-memory'),user=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'记住，生图一定使用人物参考图'}]})
 session.append('turn/start',{turn:1});session.append('user/message',user,{surfaceOp:'append'})
 session.append('user/message',createUserMessage({source:{kind:'runtime-context'},content:[{type:'text',text:'private host context'}]}),{surfaceOp:'append'})
 const addVoice=(spokenText='记住了，以后先用参考图',extra={})=>session.append('tool/result',{message:{toolCallId:'voice',isError:false,content:[]},meta:{kind:'partner-chat-v1',parts:[],delivered:true,deliveryKind:'voice',spokenText,originRouteId:'qq-private',...extra}},{surfaceOp:'append'})
 const finish=()=>session.append('turn/end',{turn:1,reason:{kind:'completed'}})
 return {session,user,addVoice,finish}
}
test('confirmed voice speech is archived without becoming outgoing text or host context',()=>{
 const f=fixture();f.addVoice();f.finish();const events=f.session.snapshotEvents()
 assert.equal(conversationReplyText(events),'记住了，以后先用参考图')
 assert.equal(channelReplyPartsAfter(events,-1).text,'');assert.deepEqual(channelReplyPartsAfter(events,-1).chatParts,[])
})
test('failed, unconfirmed and intermediate voice records cannot become final memory replies',()=>{
 for(const extra of [{delivered:false},{intermediate:true},{kind:'other'}]){
  const f=fixture();f.addVoice('不能当作最终答复',extra);f.finish();assert.equal(conversationReplyText(f.session.snapshotEvents()),'')
 }
 const f=fixture();f.addVoice();const events=structuredClone(f.session.snapshotEvents());events.at(-1).data.message.isError=true;assert.equal(conversationReplyText(events),'')
})
test('recovery archives the original completed turn once without replaying tools or notices',async()=>{
 const f=fixture();f.addVoice();f.finish();const companion=createDefaultCompanion();companion.automation.memory.enabled=true
 const route={id:'local',kind:'local',channelId:'@local',userId:'owner:'+companion.id,companionId:companion.id,sessionId:f.session.id}
 const state={companions:[companion],sessions:[route],channels:[]},saved=[]
 const runtime=Object.create(PartnerAgentRuntime.prototype)
 Object.assign(runtime,{store:{snapshot:()=>state,isCompanionRemoving:()=>false},configurations:{companion:()=>companion},
 memory:{unarchivedContext:async(_c,_s,users)=>users.filter(u=>!saved.some(t=>t.userMessageIds.includes(u.id))).map(u=>u.id)},
 reflection:{reflect:async(_c,turn)=>{saved.push(turn);return []}},ensureAgent:async()=>({session:f.session}),isArchived:()=>false,isCompanionBusy:()=>false})
 assert.equal(await runtime.recoverConversationMemory(companion.id),1);assert.equal(saved.length,1)
 assert.equal(saved[0].user,'记住，生图一定使用人物参考图');assert.equal(saved[0].assistant,'记住了，以后先用参考图')
 assert.deepEqual(saved[0].userMessageIds,[f.user.id]);assert.equal(saved[0].at,f.session.snapshotEvents().at(-1).time)
 assert.equal(await runtime.recoverConversationMemory(companion.id),0)
})
test('memory session list groups shared channel aliases while preserving their delivery routes',()=>{
 const rows=[{id:'a',kind:'channel',sessionId:'s',channelId:'qq',userId:'123',lastMessageAt:20},{id:'b',kind:'local',userId:'owner',sessionId:'s',lastMessageAt:10},{id:'c',kind:'channel',sessionId:'g',channelId:'qq',userId:'group:888:123',lastMessageAt:30}]
 const groups=groupMemorySessions(rows,[{id:'qq',platform:'qq'}]);assert.equal(groups.length,2);assert.equal(groups[0].session.id,'b');assert.equal(groups[0].routeCount,2);assert.equal(groups[1].label,'QQ 群 · 888');assert.equal(rows.length,3)
})
