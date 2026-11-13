import test from 'node:test'
import assert from 'node:assert/strict'
import {renderConversationTurn, renderChatDeliveryGuidance, renderExpressionPreferences} from '../lib/character/conversation-behavior.js'
import {chatTools} from '../lib/chat/tools.js'

test('short expression is a preference; normal direct reply has no mandatory pre-speech round trip',()=>{
 const card={enabled:true,length:'short',segmentedReplies:true}
 const text=renderConversationTurn(card,1)
 assert.match(text,/简短/);assert.doesNotMatch(text,/20字|48字/)
 assert.match(renderChatDeliveryGuidance(card),/聊天最终回复用 partner_chat_reply/)
 assert.doesNotMatch(renderChatDeliveryGuidance(card),/普通短句私聊先用/)
})
test('ordinary short reply over twenty characters preserves facts and finishes without rewrite or model call',async()=>{
 const card={enabled:true,length:'short',segmentedReplies:true,stickersEnabled:false}
 const state={companions:[{id:'a',characterCard:card}],sessions:[{sessionId:'s',companionId:'a'}]}
 const store={snapshot:()=>state,isCompanionRemoving:()=>false}
 let concluded=0
 const events=[{type:'turn/start',seq:1,data:{turn:1}},{type:'user/message',seq:2,data:{id:'u',source:{kind:'user'},content:[{type:'text',text:'处理好了没有'}]}}]
 const exec={signal:new AbortController().signal,concludeTurn:()=>concluded++,agent:{session:{id:'s',snapshotEvents:()=>events}}}
 const tool=chatTools('a',store,{}, {}, {llm:{stream(){throw Error('No second model call for direct replies')}}},'/unused')[1]
 const text='文件保存好了，在 /Backup/CaseA.csv；没上传，原文件也没删。'
 const out=await tool.execute({messages:[{text}]},exec)
 assert.equal(out.parts[0].text,text);assert.equal(concluded,1)
 await assert.rejects(tool.execute({messages:[{text:'字'.repeat(181)}]},exec),/180/)
 assert.equal(concluded,1,'long-content delivery guard still enforced')
})


test('segmented chat shares short-bubble rules with optional expression generation',()=>{
 const card={enabled:true,segmentedReplies:true,length:'short'}
 for(const prompt of [renderChatDeliveryGuidance(card),renderExpressionPreferences(card)]){
  assert.match(prompt,/半句到两句/);assert.match(prompt,/所有中英文标点符号合计最多一个/);assert.match(prompt,/连续标点逐个计数/);assert.match(prompt,/允许超过三条消息/);assert.match(prompt,/代码、逐字引用、列表、完整文档/)
 }
})


test('other reply rhythms do not inherit the short-conversation bubble limits',()=>{
 for(const length of ['natural','rich']){
  const card={enabled:true,segmentedReplies:true,length}
  assert.doesNotMatch(renderChatDeliveryGuidance(card),/半句到两句|合计最多一个/)
  assert.doesNotMatch(renderExpressionPreferences(card),/半句到两句|合计最多一个/)
 }
})
