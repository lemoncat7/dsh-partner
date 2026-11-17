import test from 'node:test'
import assert from 'node:assert/strict'
import {composeBackgroundDelivery,foregroundCompletionText} from '../lib/execution/background-delivery.js'
import {PartnerAgentRuntime} from '../lib/agent-runtime.js'
import {ReplyQueue} from '../lib/core/reply-queue.js'
import {isInternalTaskNotice,channelReplyPartsAfter} from '../lib/channels/delivery-policy.js'
const fixture=(speech='差异整理好了，实时价格还得下单前确认\n\n[对比报告.md](</task/report.md>)')=>{
 const c={id:'c',capabilities:['work'],characterCard:{enabled:true}},route={id:'r',kind:'local',companionId:'c',sessionId:'source'},state={companions:[c],sessions:[route],channels:[],executionRuns:[]}
 const run={id:'task',ownerCompanionId:'c',background:{sourceKind:'local',routeId:'r',sourceSessionId:'source',inputId:'u',label:'型号对比',result:{text:'两款核实完毕，实时价格未确认',files:[]}}};state.executionRuns.push(run)
 const events=[{type:'user/message',data:{id:'u',source:{kind:'user'},content:[{type:'text',text:'比一下这两款'}]}}],hooks=new Map(),guards=new Set();let turns=0,allowTools
 const ctx={llm:{stream(){assert.fail('must use real foreground, never a separate stream')}},on:(name,fn)=>{const set=hooks.get(name)??new Set();hooks.set(name,set);set.add(fn);return()=>set.delete(fn)}}
 const emit=(type,data)=>{const event={type,data,seq:events.length};events.push(event);for(const fn of [...hooks.get('session/event')??[]])fn(agent.session,event)}
 const agent={status:'idle',session:{id:'source',snapshotEvents:()=>events},ctx:{tools:{guard:fn=>{guards.add(fn);return()=>guards.delete(fn)}}},followup:notice=>{
  turns++;agent.status='running';emit('turn/start',{turn:turns});emit('user/message',notice)
 },whenIdle:async()=>{
  for(const fn of hooks.get('system-prompt/assemble')??[]){const value=await fn({}, {agent:{session:{id:'source'}}},async()=>({tools:[{name:'bash'}],sections:[{name:'partner-identity',text:'当前前台人设与上下文'}]}));assert.equal(value.tools.length,0);assert.match(value.sections[0].text,/当前前台/);assert.match(value.sections.at(-1).text,/原前台/)}
  assert.match([...guards][0]({agent:{session:{id:'source'}},name:'bash'}),/不执行/)
  emit('assistant/message',{message:{id:'answer-'+turns,content:[{type:'text',text:speech}]}})
  emit('turn/end',{reason:{kind:'completed'}});allowTools=guards.size===0;agent.status='idle'
 }}
 const store={snapshot:()=>structuredClone(state),isCompanionRemoving:()=>false,update:async cb=>cb(state)},reply={text:run.background.result.text,attachments:[{path:'/task/report.md',name:'对比报告.md',mediaType:'text/markdown',kind:'file'}]}
 return {c,route,state,run,events,agent,store,ctx,reply,hooks,guards,turns:()=>turns,allowTools:()=>allowTools}
}
test('completed task is handed to the real foreground and its answer is durable; no side LLM or tool execution',async()=>{
 const f=fixture(),answer=await composeBackgroundDelivery(f.ctx,f.store,f.run,f.agent,f.reply)
 assert.equal(f.turns(),1);assert.equal(f.events.filter(e=>e.type==='assistant/message').length,1)
 const notice=f.events.find(isInternalTaskNotice);assert.equal(notice.data.source.summary,'伙伴后台任务完成');assert.match(notice.data.content[0].text,/比一下这两款/)
 assert.equal(answer.attachments,f.reply.attachments);assert.match(answer.text,/实时价格/);assert.equal(f.allowTools(),true)
 assert.equal(f.guards.size,0);assert.ok([...f.hooks.values()].every(s=>s.size===0))
 // Generic autonomous/user delivery cannot double-send this internal turn.
 assert.equal(channelReplyPartsAfter(f.events,1).text,'')
})
test('outbound retry reuses the foreground answer rather than generating another turn',async()=>{
 const f=fixture();await composeBackgroundDelivery(f.ctx,f.store,f.run,f.agent,f.reply)
 const answer=await composeBackgroundDelivery(f.ctx,f.store,f.run,f.agent,f.reply);assert.equal(f.turns(),1);assert.match(answer.text,/差异整理/)
})
test('restart after foreground completion recovers the exact answer from main history',async()=>{
 const f=fixture();await composeBackgroundDelivery(f.ctx,f.store,f.run,f.agent,f.reply);delete f.run.background.foregroundReply
 const answer=await composeBackgroundDelivery(f.ctx,f.store,f.run,f.agent,f.reply);assert.equal(f.turns(),1);assert.match(answer.text,/差异整理/)
})
test('failed completion remains pending and unwinds its temporary restrictions',async()=>{
 const f=fixture();f.agent.whenIdle=async()=>{throw Error('model unavailable')}
 await assert.rejects(composeBackgroundDelivery(f.ctx,f.store,f.run,f.agent,f.reply),/model unavailable/)
 assert.equal(f.run.background.foregroundReply,undefined);assert.equal(f.guards.size,0);assert.ok([...f.hooks.values()].every(s=>s.size===0))
})
test('unrelated or interrupted turn cannot be mistaken for this task completion',()=>{
 assert.equal(foregroundCompletionText([{type:'user/message',data:{id:'other'}}],'missing'),undefined)
 const base=[{type:'user/message',data:{id:'n'}},{type:'assistant/message',data:{message:{content:[{type:'text',text:'draft'}]}}}]
 assert.equal(foregroundCompletionText([...base,{type:'turn/end',data:{reason:{kind:'error'}}}],'n'),undefined)
 assert.equal(foregroundCompletionText([...base,{type:'user/message',data:{id:'new',source:{kind:'user'}}},{type:'turn/end',data:{reason:{kind:'completed'}}}],'n'),undefined)
})
test('runtime routes local and channel completions through its priority foreground lane',async()=>{
 const f=fixture(),runtime={ctx:f.ctx,store:f.store,isArchived:()=>false,ensureAgent:async()=>f.agent,replyQueue:new ReplyQueue(),queues:new Map()}
 runtime.prepareBackgroundDelivery=(run,reply)=>PartnerAgentRuntime.prototype.prepareBackgroundDelivery.call(runtime,run,reply)
 await PartnerAgentRuntime.prototype.deliverLocalBackgroundResult.call(runtime,f.run,f.reply)
 assert.equal(f.turns(),1);assert.equal(f.events.filter(e=>e.type==='assistant/message').length,1)
 await runtime.replyQueue.idle('source');assert.equal(runtime.queues.size,0)
})

test('foreground handoff is not claimed by an old interest or continuous activity',()=>{
 const id='main',old={type:'user/message',data:{id:'interest',source:{kind:'plugin:@lemoncat7/dsh-partner',plugin:'@lemoncat7/dsh-partner',form:'notice',summary:'伙伴自主联系'},content:[]}},notice={type:'user/message',data:{id:'completion',source:{kind:'plugin:@lemoncat7/dsh-partner',plugin:'@lemoncat7/dsh-partner',form:'notice',summary:'伙伴后台任务完成'},content:[]}}
 let canceled=0;const agent={session:{id,snapshotEvents:()=>[old,notice]},status:'running',cancel:()=>{canceled++}}
 const runtime={restoredCompositions:new Map([[id,{agent}]]),configurations:{routesForSession:()=>[{idleContactState:{planSnapshot:{trigger:'interest'},messageId:'interest'}}]},inputEvents:()=>[old,notice],continuousClaims:new Map([[id,{agent,messageId:'interest'}]])}
 assert.equal(PartnerAgentRuntime.prototype.interestClaim.call(runtime,id),undefined)
 assert.equal(PartnerAgentRuntime.prototype.continuousClaim.call(runtime,id),undefined)
 PartnerAgentRuntime.prototype.stopInterest.call(runtime,id,'interest');assert.equal(canceled,0)
})

test('foreground handoff and native answer remain visible through DSH session replay',async()=>{
 const {Session}=await import('@deepseek-ai/dsh-session'),{createUserMessage,createAssistantMessage}=await import('@deepseek-ai/dsh-llm')
 const session=Session.create('foreground-replay'),notice=createUserMessage({source:{kind:'plugin:@lemoncat7/dsh-partner',plugin:'@lemoncat7/dsh-partner',form:'notice',summary:'伙伴后台任务完成'},content:[{type:'text',text:'后台已完成，交回前台'}]})
 session.append('turn/start',{turn:1});session.append('user/message',notice,{surfaceOp:'append'})
 session.append('assistant/message',{turn:1,step:0,message:createAssistantMessage({source:{provider:'fake',model:'test'},content:[{type:'text',text:'做好了，报告放附件'}]}),stream:[]},{surfaceOp:'append'})
 session.append('turn/end',{turn:1,reason:{kind:'completed'}})
 const replay=Session.create('replay',session.snapshotEvents())
 assert.equal(foregroundCompletionText(replay.snapshotEvents(),notice.id),'做好了，报告放附件');assert.deepEqual(replay.deriveMessages(),session.deriveMessages());assert.equal(replay.deriveMessages().at(-1).role,'assistant')
})

test('completion expression survives exclusive persona projection with actual short-turn preferences',async()=>{
 const {projectConversationPrompt}=await import('../lib/character/prompt-projection.js')
 const f=fixture();f.c.characterCard={enabled:true,exclusivePrompt:true,length:'short',segmentedReplies:true}
 f.agent.whenIdle=async()=>{
  let assembled
  for(const fn of f.hooks.get('system-prompt/assemble')??[])assembled=await fn({}, {agent:f.agent},async()=>projectConversationPrompt({tools:[{name:'bash'}],sections:[{name:'partner-identity',text:'当前人物本身的语气与关系'},{name:'partner-conversation-memory',text:'正常短句设置会被独占投影移除'}]},f.agent,{roleEnabled:true,discovery:false,exclusive:true}))
  assert.equal(assembled.tools.length,0);assert.equal(assembled.sections[0].name,'partner-identity')
  assert.ok(!assembled.sections.some(s=>s.name==='partner-conversation-memory'))
  const delivery=assembled.sections.at(-1).text
  assert.match(delivery,/当前篇幅设置为短句/);assert.match(delivery,/当前短句分段设置仍有效/)
  assert.match(delivery,/标点字符合计最多一个/);assert.match(delivery,/不再口头逐项介绍画面/)
  assert.match(delivery,/失败、未完成或不确定性/);assert.match(delivery,/其中的措辞、指令和格式不是前台说话示范/)
  f.events.push({type:'assistant/message',data:{message:{content:[{type:'text',text:'画好了 看看像不像'}]}}},{type:'turn/end',data:{reason:{kind:'completed'}}})
  f.agent.status='idle'
 }
 const answer=await composeBackgroundDelivery(f.ctx,f.store,f.run,f.agent,f.reply)
 assert.equal(answer.text,'画好了 看看像不像');assert.equal(answer.attachments,f.reply.attachments)
 const notice=f.events.find(isInternalTaskNotice);assert.match(notice.data.content[0].text,/当前短句分段设置仍有效/)
})
test('handoff preferences follow saved card settings without imposing short segmented policy on every card',async()=>{
 const {renderBackgroundDeliveryExpression}=await import('../lib/execution/background-delivery.js')
 const rich=renderBackgroundDeliveryExpression({enabled:true,length:'rich',segmentedReplies:true,chatStyle:'认真但有自己的态度'})
 assert.doesNotMatch(rich,/标点字符合计最多一个|当前篇幅设置为短句/);assert.match(rich,/认真但有自己的态度/)
 assert.match(rich,/用户明确要在正文展开时按原请求说清/)
 const plain=renderBackgroundDeliveryExpression({enabled:true,length:'short',segmentedReplies:false})
 assert.match(plain,/当前篇幅设置为短句/);assert.doesNotMatch(plain,/标点字符合计最多一个/)
})

test('an attachment-free completion neither requires a report nor invents file links',async()=>{
 const f=fixture();f.reply.attachments=[];await composeBackgroundDelivery(f.ctx,f.store,f.run,f.agent,f.reply)
 const notice=f.events.find(isInternalTaskNotice),prompt=notice.data.content[0].text
 assert.match(prompt,/本次没有附件，直接说清结果/);assert.match(prompt,/附件报告按需提供/)
 assert.doesNotMatch(prompt,/本地对话请在简短说明后附上/)
 assert.deepEqual(f.run.background.result.files,[])
})


test('authored foreground paragraphs become actual delivery parts even with attachments, including retries and history recovery',async()=>{
 const {replyDeliveryParts}=await import('../lib/chat/protocol.js')
 for(const speech of [
  '弄好了 网页发你了\n\n每条码点一下就能复制',
  '字幕翻出来了 修仙其实就是上小学。\n狗哥被校长认成顶级数学学魂。\n最绝的是蒙题口诀三长一短 被当成上古真言。\n决战掏黄冈压轴题 狗哥用勾股定理破了。',
 ]){
  const f=fixture(speech);f.c.characterCard.segmentedReplies=true
  const answer=await composeBackgroundDelivery(f.ctx,f.store,f.run,f.agent,f.reply)
  const parts=replyDeliveryParts(answer),expected=speech.split(/\n/).filter(Boolean)
  assert.deepEqual(parts.filter(p=>p.type==='text').map(p=>p.text),expected)
  assert.equal(parts.at(-1).attachment,f.reply.attachments[0]);assert.equal(answer.text,speech)
  assert.deepEqual((await composeBackgroundDelivery(f.ctx,f.store,f.run,f.agent,f.reply)).chatParts,answer.chatParts)
  delete f.run.background.foregroundReply
  assert.deepEqual((await composeBackgroundDelivery(f.ctx,f.store,f.run,f.agent,f.reply)).chatParts,answer.chatParts)
  assert.equal(f.turns(),1)
 }
})
test('attachment-free paragraphs split, single speech stays single, and disabled segmentation is respected',async()=>{
 for(const [speech,enabled,expected] of [
  ['弄好了\n\n点一下就能复制',true,['弄好了','点一下就能复制']],
  ['弄好了 点一下就能复制',true,['弄好了 点一下就能复制']],
  ['弄好了\n\n点一下就能复制',false,['弄好了\n\n点一下就能复制']],
 ]){
  const f=fixture(speech);f.c.characterCard.segmentedReplies=enabled;f.reply.attachments=[]
  const answer=await composeBackgroundDelivery(f.ctx,f.store,f.run,f.agent,f.reply)
  assert.deepEqual(answer.chatParts.map(p=>p.text),expected);assert.equal(answer.text,speech)
 }
})
test('structured documents and code retain formatting; excess short bubbles merge without losing text',async()=>{
 for(const speech of ['好了\n\n[报告.md](</task/report.md>)','示例\n```js\nconsole.log(1)\n```','# 结论\n\n- 第一条\n- 第二条','长结果'.repeat(300)+'\n补充']){
  const f=fixture(speech);f.c.characterCard.segmentedReplies=true
  const answer=await composeBackgroundDelivery(f.ctx,f.store,f.run,f.agent,f.reply)
  assert.deepEqual(answer.chatParts.filter(p=>p.type==='text'),[{type:'text',text:speech}])
 }
 const speech='第一条\n第二条\n第三条\n第四条\n第五条',f=fixture(speech);f.c.characterCard.segmentedReplies=true
 const answer=await composeBackgroundDelivery(f.ctx,f.store,f.run,f.agent,f.reply),parts=answer.chatParts.filter(p=>p.type==='text')
 assert.equal(parts.length,4);assert.equal(parts.map(p=>p.text).join('\n'),speech);assert.equal(answer.text,speech)
})


test('disabling role chat delivers full original task output without a persona turn or tool restrictions',async()=>{
 const f=fixture()
 await f.store.update(s=>{s.companions[0].characterCard={enabled:false,length:'short',segmentedReplies:true,chatStyle:'旧语气'}})
 const text='完整结果与限制。\n'.repeat(500)
 f.reply.text=text
 const result=await composeBackgroundDelivery(f.ctx,f.store,f.run,f.agent,f.reply)
 assert.equal(result,f.reply);assert.equal(result.text,text);assert.equal(f.turns(),0);assert.equal(f.guards.size,0)
})

const channelFixture=speech=>{
 const f=fixture(speech)
 f.run.background.sourceKind='channel';f.run.background.cwd='/workspace/.partner-background/task';f.run.background.sourceCwd='/workspace'
 f.route.kind='channel';f.c.characterCard.segmentedReplies=true
 f.reply.attachments=[{path:'/workspace/.partner-background/task/artifacts/copied.png',name:'四格漫画.png',mediaType:'image/png',kind:'file'}]
 return f
}
test('channel background image delivery omits the generated local Markdown bubble, including retries and history recovery',async()=>{
 const speech='画好了 两升就倒还敢喊最大啊\n\n![四格漫画](/workspace/generated/original.png)'
 const f=channelFixture(speech)
 const check=answer=>{
  assert.equal(answer.text,'画好了 两升就倒还敢喊最大啊')
  assert.deepEqual(answer.chatParts.filter(p=>p.type==='text'),[{type:'text',text:answer.text}])
  assert.equal(answer.chatParts.at(-1).attachment,f.reply.attachments[0]);assert.equal(answer.attachments,f.reply.attachments)
 }
 check(await composeBackgroundDelivery(f.ctx,f.store,f.run,f.agent,f.reply))
 check(await composeBackgroundDelivery(f.ctx,f.store,f.run,f.agent,f.reply))
 delete f.run.background.foregroundReply
 check(await composeBackgroundDelivery(f.ctx,f.store,f.run,f.agent,f.reply))
 assert.equal(f.turns(),1)
 assert.ok(f.events.some(e=>e.type==='assistant/message'&&e.data.message.content.some(p=>p.text===speech)),'native session history keeps its original answer')
 assert.match(f.events.find(isInternalTaskNotice).data.content[0].text,/不要输出本地文件路径/)
 assert.doesNotMatch(f.events.find(isInternalTaskNotice).data.content[0].text,/文件 Markdown 链接单独保留完整格式/)
})
test('local generated references are omitted while public URLs, technical code and unrelated paths survive',async()=>{
 for(const reference of ['![图](<file:///workspace/generated/a%20b.png>)','![图](sandbox:generated/a.png)','![图](generated/a.png)','`/workspace/generated/a.png`','/workspace/generated/a.png','/workspace/.partner-background/task/artifacts/copied.png']){
  const f=channelFixture('看看这张\n\n'+reference),answer=await composeBackgroundDelivery(f.ctx,f.store,f.run,f.agent,f.reply)
  assert.equal(answer.text,'看看这张',reference)
 }
 for(const reference of ['![图](https://example.com/a.png)','[外部链接](https://example.com/a)','```md\n![示例](/workspace/generated/a.png)\n```','配置目录 /etc/app/config.yaml','版本 v2.6']){
  const f=channelFixture(reference),answer=await composeBackgroundDelivery(f.ctx,f.store,f.run,f.agent,f.reply)
  assert.equal(answer.text,reference)
 }
 const f=channelFixture('![图](/workspace/generated/a.png)'),answer=await composeBackgroundDelivery(f.ctx,f.store,f.run,f.agent,f.reply)
 assert.equal(answer.text,'');assert.equal(answer.chatParts.length,1);assert.equal(answer.chatParts[0].type,'image','image-only results never invent an empty text bubble')
})
test('native/local file links, missing attachments and ordinary non-persona execution are preserved',async()=>{
 const speech='画好了\n\n![四格漫画](/workspace/generated/a.png)'
 const f=fixture(speech),answer=await composeBackgroundDelivery(f.ctx,f.store,f.run,f.agent,f.reply)
 assert.equal(answer.text,speech)
 const missing=channelFixture(speech);missing.reply.attachments=[]
 assert.equal((await composeBackgroundDelivery(missing.ctx,missing.store,missing.run,missing.agent,missing.reply)).text,speech)
 const normal=channelFixture(speech);normal.c.characterCard.enabled=false
 assert.equal(await composeBackgroundDelivery(normal.ctx,normal.store,normal.run,normal.agent,normal.reply),normal.reply)
})
