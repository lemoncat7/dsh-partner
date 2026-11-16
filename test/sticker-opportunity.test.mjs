import test from 'node:test'
import assert from 'node:assert/strict'
import {renderStickerOpportunity} from '../lib/chat/sticker-opportunity.js'
const fixture=()=>{
 const state={companions:[{id:'c',characterCard:{enabled:true,stickersEnabled:true}}],sessions:[{id:'r',kind:'channel',companionId:'c',sessionId:'s',channelId:'qq',userId:'12345678',inboundMessageIds:['u']}],channels:[{id:'qq',companionId:'c',enabled:true,platform:'qq',qq:{enabledActions:['add_custom_face','modify_custom_face']}}],pairings:[{channelId:'qq',userId:'12345678',status:'approved'}]}
 const events=[{type:'user/message',data:{id:'u',source:{kind:'user'},content:[{type:'image',attachment:{}},{type:'text',text:'渠道图片已保存：/work/inbound/a.gif'}]}}]
 return {state,events,render:()=>renderStickerOpportunity(state,'c','s',events)}
}
test('an authorized image input exposes collection directly without uploading or enumerating the library',()=>{
 const f=fixture(),text=f.render();assert.match(text,/add_custom_face/);assert.match(text,/channelId="qq"/);assert.match(text,/GIF 原文件/);assert.match(text,/modify_custom_face/)
 assert.doesNotMatch(text,/qq-custom-|https:\/\/|必[须需].*收藏/)
 f.state.channels[0].qq.enabledActions=['add_custom_face'];assert.doesNotMatch(f.render(),/modify_custom_face/)
})
test('public group collection needs no private capability switch',()=>{
 const f=fixture();f.state.pairings=[];f.state.sessions[0].userId='group:99887766:12345678';Object.assign(f.state.channels[0].qq,{groupReplies:true,groupIds:['99887766'],autonomousGroupIds:['99887766'],autonomousActions:false});assert.match(f.render(),/add_custom_face/)
})
for(const kind of ['disabled','revoked','blocked','other-owner','unknown','text-only','notice','new-input'])test('collection opportunity is absent for '+kind,()=>{
 const f=fixture();
 if(kind==='disabled')f.state.companions[0].characterCard.stickersEnabled=false
 if(kind==='revoked')f.state.channels[0].qq.enabledActions=[]
 if(kind==='blocked')f.state.pairings[0].status='blocked'
 if(kind==='other-owner')f.state.sessions[0].companionId='other'
 if(kind==='unknown')f.state.sessions[0].inboundMessageIds=[]
 if(kind==='text-only')f.events[0].data.content=[{type:'text',text:'渠道图片已保存：/work/inbound/a.gif'}]
 if(kind==='notice')f.events[0].data.source.kind='runtime-context'
 if(kind==='new-input')f.events.push({type:'user/message',data:{id:'v',source:{kind:'user'},content:[{type:'text',text:'别收了'}]}})
 assert.equal(f.render(),'')
})
test('collection attempt retires the hint even before a receipt or on failure; discovery does not',()=>{
 const f=fixture();f.events.push({type:'tool/call',data:{name:'partner_tools',arguments:JSON.stringify({action:'describe',name:'partner_qq',operation:'add_custom_face'})}});assert.ok(f.render())
 f.events.push({type:'tool/call',data:{name:'partner_tools',arguments:JSON.stringify({action:'call',name:'partner_qq',argumentsJson:JSON.stringify({action:'call',operation:'add_custom_face'})})}});assert.equal(f.render(),'')
})

test('runtime context snapshots do not hide the current image',()=>{
 const f=fixture();f.events.push({type:'user/message',data:{source:{kind:'runtime-context'},content:[]}});assert.match(f.render(),/add_custom_face/)
})
