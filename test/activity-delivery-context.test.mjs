import test from 'node:test'
import assert from 'node:assert/strict'
import {activityConversation,idleActivityPrompt,activityConversationPosition} from '../lib/character/idle-contact.js'
import {recentAttachmentDeliveries,attachmentDeliveryReceipt} from '../lib/attachments/delivery-receipt.js'
import {recallConversationHistory} from '../lib/conversation-history-recall.js'
const route={id:'r',kind:'channel',companionId:'c',sessionId:'s',channelId:'ch',userId:'peer',inboundMessageIds:['u']}
const companion={id:'c',idleContact:{enabled:true,routeId:'r'},characterCard:{enabled:true},automation:{heartbeat:{enabled:false}}}
const state={companions:[companion],sessions:[route],channels:[],pairings:[]}
const notice=summary=>({type:'user/message',time:3,data:{id:'notice',source:{kind:'plugin:@lemoncat7/dsh-partner',plugin:'@lemoncat7/dsh-partner',form:'notice',summary},content:[{type:'text',text:'internal'}]}})
const chat=(text,extra={})=>({type:'tool/result',time:4,data:{message:{isError:false,content:[]},meta:{kind:'partner-chat-v1',parts:[{type:'text',text}],originRouteId:'r',...extra}}})
const receipt=(id='d',routeId='r',isError=false)=>({type:'tool/ptc-dispatch',time:5,data:{name:'partner_send_attachment',isError,content:[{type:'text',text:JSON.stringify({deliveryId:id,name:'comic.png',channel:'sent',conversation:'attachment_recorded',originRouteId:routeId})}],meta:{kind:'partner-attachment-delivered-v1',originRouteId:routeId}}})
const user={type:'user/message',seq:2,time:2,surfaceOp:'append',data:{id:'u',source:{kind:'user'},content:[{type:'text',text:'画漫画'}]}}
const events=[{type:'turn/start',data:{turn:1}},user,chat('我去画啦'),notice('当前请求答复完整性检查'),receipt(),chat('画好发过来啦'),{type:'turn/end',data:{turn:1,reason:{kind:'completed'}}}]
test('empty-answer recovery notice preserves subsequent real response and confirmed delivery in idle context',()=>{
 const before=structuredClone(events),context=activityConversation(events),prompt=idleActivityPrompt(state,companion,events)
 assert.equal(context.at(-1).text,'画好发过来啦');assert.equal(context.at(-1).origin,'reply')
 assert.match(prompt,/画好发过来啦/);assert.match(prompt,/已确认附件送达/);assert.match(prompt,/comic.png/);assert.match(prompt,/"status":"sent"/)
 assert.deepEqual(events,before)
})
test('only confirmed matching-route receipts qualify, duplicate IDs collapse and bound is retained',()=>{
 const failed=receipt('failed','r',true),unknown=receipt('unknown');unknown.data.content[0].text=unknown.data.content[0].text.replace('"sent"','"unknown"')
 const mismatch=receipt('mismatch');mismatch.data.meta.originRouteId='other'
 const input=[...Array.from({length:10},(_,i)=>receipt('id'+i)),receipt('id9'),receipt('foreign','other'),failed,unknown,mismatch,chat('我发了 comic.png')]
 assert.equal(attachmentDeliveryReceipt(failed),undefined);assert.equal(attachmentDeliveryReceipt(unknown),undefined);assert.equal(attachmentDeliveryReceipt(mismatch),undefined)
 assert.deepEqual(recentAttachmentDeliveries(input,'r').map(r=>r.deliveryId),['id4','id5','id6','id7','id8','id9'])
 const prompt=idleActivityPrompt(state,companion,input,undefined,undefined,'other');assert.match(prompt,/foreign/);assert.doesNotMatch(prompt,/id9/)
})
test('recall returns confirmed attachment evidence alongside conversation and never another audience',()=>{
 const hits=recallConversationHistory(events,[route],'s',route,'comic.png')
 assert.equal(hits.length,1);assert.match(hits[0].assistant,/我去画啦/);assert.match(hits[0].assistant,/画好发过来啦/);assert.equal(hits[0].deliveries[0].deliveryId,'d')
 assert.deepEqual(recallConversationHistory(events,[route,{...route,id:'other',inboundMessageIds:[]}],'s',{...route,id:'other'},'comic.png'),[])
 assert.deepEqual(recallConversationHistory(events,[route],'s',undefined,'comic.png'),[])
})
test('real internal tasks remain excluded; autonomous recovery does not erase unanswered-turn accounting',()=>{
 assert.equal(activityConversation([user,notice('伙伴执行看板任务'),chat('private internal result')]).some(x=>x.text==='private internal result'),false)
 const activity=[user,notice('伙伴闲时主动联系'),notice('当前请求答复完整性检查'),chat('新发现')]
 assert.equal(activityConversationPosition(activity).unansweredAutonomousTurns,1)
})
test('nested voice transport is represented once in context and recalled spoken text',()=>{
 const spoken={type:'tool/ptc-dispatch',time:4,data:{isError:false,meta:{kind:'partner-chat-v1',parts:[],delivered:true,deliveryKind:'voice',spokenText:'我去画啦',originRouteId:'r',inputMessageId:'u',intermediate:true}}}
 const parent={type:'tool/result',time:5,data:{message:{isError:false},meta:{...spoken.data.meta,transportCallId:'voice-child'}}}
 const input=[user,spoken,parent]
 assert.equal(activityConversation(input).filter(x=>x.text==='我去画啦').length,1)
 assert.equal(recallConversationHistory(input,[route],'s',route,'画啦')[0].assistant,'我去画啦')
})
