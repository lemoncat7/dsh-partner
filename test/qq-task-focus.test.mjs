import test from 'node:test'
import assert from 'node:assert/strict'
import {groupTaskInput,taskTool} from '../lib/channels/qq/task-focus.js'
import {PartnerAgentRuntime} from '../lib/agent-runtime.js'
const event=(text,extra={})=>({id:'m',sender:'group:12345678:22334455',text,qqGroup:{groupId:'12345678',userId:'22334455',mentioned:false,...extra}})
const focus={userId:'group:12345678:22334455',startedAt:1000,working:true}
test('work isolates ambient talk while explicit author corrections remain live',()=>{
 for(const text of ['？','干活中不会发消息的','NB','看看写实咋样'])assert.equal(groupTaskInput(event(text),focus,'伙伴',2000),'observe')
 for(const text of ['取消任务','停一下','别做了','改成写实','补充一下：背景用蓝色','图片改成方形','伙伴，停一下','背景也保持原样','等等先别做'])assert.equal(groupTaskInput(event(text),focus,'伙伴',2000),'steer',text)
 assert.equal(groupTaskInput(event('帮我再查点别的',{mentioned:true}),focus,'伙伴',2000),'queue')
 assert.equal(groupTaskInput({...event('取消任务'),sender:'group:12345678:99887766'},focus,'伙伴',2000),'observe')
 assert.equal(groupTaskInput(event('取消任务',{otherMention:true}),focus,'伙伴',2000),'observe')
 assert.equal(groupTaskInput(event('伙伴，另外查下这个'),focus,'伙伴',2000),'queue')
 assert.equal(groupTaskInput(event('补充一下'),undefined,'伙伴',2000),'normal')
})
test('unsent chat keeps joining fragments; confirmed reply closes admission and chat tools do not mark work',()=>{
 const chatting={...focus,working:false}
 assert.equal(groupTaskInput(event('蓝色的'),chatting,'伙伴',2000),'steer')
 assert.equal(groupTaskInput(event('再加点'),chatting,'伙伴',7000),'steer')
 assert.equal(groupTaskInput(event('？'),chatting,'伙伴',2000),'observe')
 assert.equal(groupTaskInput(event('还有一点'),{...chatting,sentAt:2000},'伙伴',3000),'observe')
 assert.equal(groupTaskInput(event('取消任务'),{...chatting,sentAt:2000},'伙伴',3000),'steer')
 assert.equal(groupTaskInput(event('还有个问题',{mentioned:true}),{...chatting,sentAt:2000},'伙伴',3000),'queue')
 assert.equal(taskTool('partner_tools',{action:'call',name:'generate_image',argumentsJson:'{}'}),true)
 assert.equal(taskTool('partner_chat_say',{beforeTools:true}),true)
 assert.equal(taskTool('partner_chat_reply',{continueTurn:true}),false)
 assert.equal(taskTool('partner_stickers',{action:'list'}),false)
})
test('runtime focus is isolated by room and channel and returns a copy',()=>{
 const routes=[{id:'r',channelId:'q',userId:focus.userId,sessionId:'s'}]
 const runtime=new PartnerAgentRuntime({}, {snapshot:()=>({sessions:routes,companions:[]}),subscribe:()=>()=>{}},'/tmp')
 runtime.channelReplyOwners.set('s','r');runtime.channelReplyFocus.set('s',focus)
 const view=runtime.groupReplyFocus('q','group:12345678:99887766');assert.deepEqual(view,focus);view.working=false;assert.equal(focus.working,true)
 assert.equal(runtime.groupReplyFocus('other',focus.userId),undefined)
 assert.equal(runtime.groupReplyFocus('q','group:87654321:22334455'),undefined)
 runtime.channelReplyOwners.clear();assert.equal(runtime.groupReplyFocus('q',focus.userId),undefined)
})

test('other members can enter selective chat judgment, but never interrupt a working task',()=>{
 const other={...event('这个透视也太离谱了'),sender:'group:12345678:99887766',qqGroup:{groupId:'12345678',userId:'99887766'}}
 assert.equal(groupTaskInput(other,{...focus,working:false,sentAt:1200},'伙伴',2000),'normal')
 assert.equal(groupTaskInput(other,focus,'伙伴',2000),'observe')
 assert.equal(groupTaskInput(event('又有一点'),{...focus,working:false,sentAt:1200},'伙伴',2000),'observe')
})
