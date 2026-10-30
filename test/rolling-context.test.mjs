import test from 'node:test'
import assert from 'node:assert/strict'
import {Session} from '@deepseek-ai/dsh-session'
import {createUserMessage,createSystemMessage,createAssistantMessage,createToolResultMessage} from '@deepseek-ai/dsh-llm'
import {rollConversationContext} from '../lib/rolling-context.js'
import {recallConversationHistory,recordInputOrigin} from '../lib/conversation-history-recall.js'
import {normalizeAutomation,DEFAULT_AUTOMATION} from '../lib/domain.js'
import {DailyReviewScheduler} from '../lib/daily-review.js'
const settings={rollingContextEnabled:true,rollingContextTurns:2,rollingContextMaxChars:48000}
const user=(s,text)=>s.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text}]}),{surfaceOp:'append'})
const assistant=(s,text)=>s.append('assistant/message',{turn:1,step:1,stream:[],message:createAssistantMessage({source:{provider:'p',model:'m'},content:[{type:'text',text}]})},{surfaceOp:'append'})
function fixture(){const s=Session.create('rolling');s.append('system/message',{turn:0,step:0,message:createSystemMessage('protected persona')},{surfaceOp:'append'});return s}
function round(s,n,text='question-'+n){s.append('turn/start',{turn:n});const u=user(s,text);assistant(s,'answer-'+n);s.append('turn/end',{turn:n,reason:{kind:'completed'}});return u}
const text=s=>JSON.stringify(s.deriveMessages())
test('rolling keeps complete recent rounds, protected system snapshots, immutable log and replay',()=>{
 const s=fixture();round(s,1);s.append('system/message',{turn:1,step:1,message:createSystemMessage('new system')},{surfaceOp:'append'});round(s,2);round(s,3);round(s,4)
 const before=s.snapshotEvents(),protectedSeqs=before.filter(e=>e.type==='system/message').map(e=>e.seq)
 assert.ok(rollConversationContext(s,settings)>0)
 assert.doesNotMatch(text(s),/question-1|answer-1|question-2|answer-2/)
 assert.match(text(s),/question-3/);assert.match(text(s),/answer-4/)
 for(const seq of protectedSeqs)assert.ok(s.surface.nodes.includes(seq))
 assert.deepEqual(s.snapshotEvents().slice(0,before.length),before)
 assert.equal(text(Session.create('replay',s.snapshotEvents())),text(s))
 const length=s.snapshotEvents().length;assert.equal(rollConversationContext(s,settings),0);assert.equal(s.snapshotEvents().length,length)
 assert.equal(recallConversationHistory(s.snapshotEvents(),[],s.id,undefined,'question-1')[0].user,'question-1')
})
test('current tool-heavy task and paired results survive, older rounds yield to the character budget',()=>{
 const s=fixture();round(s,1,'old');round(s,2,'middle');round(s,3,'x'.repeat(6000))
 s.append('turn/start',{turn:4});user(s,'current task')
 s.append('assistant/message',{turn:1,step:1,stream:[],message:createAssistantMessage({source:{provider:'p',model:'m'},content:[{type:'tool-call',id:'tool-4',name:'test',arguments:'{}'}]})},{surfaceOp:'append'})
 s.append('tool/result',{message:createToolResultMessage({callId:'tool-4',isError:false,content:[{type:'text',text:'result'.repeat(4000)}]})},{surfaceOp:'append'})
 rollConversationContext(s,{...settings,rollingContextTurns:10,rollingContextMaxChars:4000})
 assert.doesNotMatch(text(s),/middle|xxxx/);assert.match(text(s),/current task/)
 assert.equal(s.deriveMessages().filter(m=>m.role==='tool').length,1)
 assert.equal(s.deriveMessages().filter(m=>m.role==='assistant').flatMap(m=>m.content).filter(b=>b.type==='tool-call').length,1)
})
test('an outstanding old tool call cannot be orphaned by rolling',()=>{
 const s=fixture();s.append('turn/start',{turn:1});user(s,'still needed')
 s.append('assistant/message',{turn:1,step:1,stream:[],message:createAssistantMessage({source:{provider:'p',model:'m'},content:[{type:'tool-call',id:'pending',name:'test',arguments:'{}'}]})},{surfaceOp:'append'})
 s.append('turn/end',{turn:1,reason:{kind:'completed'}});round(s,2);round(s,3);round(s,4)
 rollConversationContext(s,settings);assert.match(text(s),/still needed/)
})
test('disabled rolling is a no-op and validated defaults survive settings roundtrip',()=>{
 const s=fixture();for(let i=1;i<5;i++)round(s,i)
 const seq=s.seq;assert.equal(rollConversationContext(s,{...settings,rollingContextEnabled:false}),0);assert.equal(s.seq,seq)
 assert.equal(normalizeAutomation(DEFAULT_AUTOMATION).memory.rollingContextEnabled,false)
 for(const bad of [{rollingContextTurns:1},{rollingContextTurns:2.5},{rollingContextMaxChars:1},{rollingContextEnabled:'true'}])assert.throws(()=>normalizeAutomation({...DEFAULT_AUTOMATION,memory:{...DEFAULT_AUTOMATION.memory,...bad}}))
 assert.deepEqual(normalizeAutomation({...DEFAULT_AUTOMATION,memory:{...DEFAULT_AUTOMATION.memory,...settings}}).memory,{...DEFAULT_AUTOMATION.memory,...settings})
})
test('raw recall uses durable origins after bounded route ids expire and isolates another channel',()=>{
 const s=fixture(),routes=[{id:'a',kind:'channel',sessionId:s.id,channelId:'qq',userId:'a',inboundMessageIds:[]},{id:'b',kind:'channel',sessionId:s.id,channelId:'qq',userId:'b',inboundMessageIds:[]}]
 for(const [i,route] of routes.entries()){const u=round(s,i+1,'blue-secret-'+route.id);recordInputOrigin(s,{messageId:u.data.id,routeId:route.id,channelId:route.channelId,userId:route.userId})}
 const hits=recallConversationHistory(s.snapshotEvents(),routes,s.id,routes[0],'blue-secret')
 assert.equal(hits.length,1);assert.equal(hits[0].user,'blue-secret-a')
 assert.deepEqual(recallConversationHistory(s.snapshotEvents(),routes,s.id,undefined,'blue-secret'),[])
 const restored=Session.create('replay',s.snapshotEvents());assert.equal(restored.snapshotEvents().filter(e=>e.type==='plugin:dsh-partner/input-origin').length,2)
})
test('rolling pauses renewal without disabling long-term learning or daily review',async()=>{
 const companion={id:'c',automation:{...DEFAULT_AUTOMATION,memory:{...DEFAULT_AUTOMATION.memory,...settings,enabled:true}}}
 const scheduler=new DailyReviewScheduler({}, {snapshot:()=>({companions:[companion]}),isCompanionRemoving:()=>false},{},{},{})
 assert.match((await scheduler.trigger('c',false,true)).reason,/滚动/)
})

test('local history in a shared session remains recallable with explicit local provenance',async()=>{
 const {recordLocalInputOrigins}=await import('../lib/conversation-history-recall.js')
 const s=fixture(),routes=[{id:'local',kind:'local',sessionId:s.id,channelId:'@local',userId:'owner'},{id:'channel',kind:'channel',sessionId:s.id,channelId:'qq',userId:'guest',inboundMessageIds:[]}]
 const message=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'local-remembered-project'}]})
 recordLocalInputOrigins(s,[message],routes);s.append('user/message',message,{surfaceOp:'append'})
 const size=s.seq;recordLocalInputOrigins(s,[message],routes);assert.equal(s.seq,size)
 assert.equal(recallConversationHistory(s.snapshotEvents(),routes,s.id,undefined,'local-remembered')[0].user,'local-remembered-project')
 assert.deepEqual(recallConversationHistory(s.snapshotEvents(),routes,s.id,routes[1],'local-remembered'),[])
})

test('rolling replaces superseded runtime snapshots without losing current context or raw history',()=>{
 const s=fixture()
 const snapshot=(kind,sections)=>s.append('user/message',createUserMessage({source:{kind,form:'snapshot',sections},content:[{type:'text',text:sections.map(s=>s.text).join('\n')}]}),{surfaceOp:'append'})
 const old=snapshot('runtime-context',[{name:'memory',text:'old recalled memory'},{name:'tools',text:'tool catalog'}])
 round(s,1)
 snapshot('time-context',[{name:'time-context',text:'yesterday'}])
 snapshot('runtime-context',[{name:'memory',text:'current recalled memory'},{name:'tools',text:'tool catalog'}])
 snapshot('time-context',[{name:'time-context',text:'today'}])
 round(s,2)
 const before=s.snapshotEvents()
 assert.ok(rollConversationContext(s,{...settings,rollingContextTurns:20})>0)
 assert.doesNotMatch(text(s),/old recalled memory|yesterday/)
 assert.match(text(s),/current recalled memory/);assert.match(text(s),/tool catalog/);assert.match(text(s),/today/)
 assert.match(text(s),/protected persona/);assert.match(text(s),/question-1/)
 assert.deepEqual(s.snapshotEvents().slice(0,before.length),before)
 assert.ok(s.snapshotEvents().some(e=>e.seq===old.seq))
 assert.equal(text(Session.create('snapshot-replay',s.snapshotEvents())),text(s))
 assert.equal(rollConversationContext(s,settings),0)
})

test('partial runtime snapshots and third party snapshots are not silently discarded',()=>{
 const s=fixture()
 for(const [kind,sections] of [
  ['runtime-context',[{name:'unique',text:'unique rule'},{name:'shared',text:'earlier'}]],
  ['runtime-context',[{name:'shared',text:'later'}]],
  ['plugin:third-party',[{name:'shared',text:'plugin earlier'}]],
  ['plugin:third-party',[{name:'shared',text:'plugin later'}]],
 ])s.append('user/message',createUserMessage({source:{kind,form:'snapshot',sections},content:[{type:'text',text:sections.map(s=>s.text).join('\n')}]}),{surfaceOp:'append'})
 round(s,1);round(s,2);round(s,3)
 rollConversationContext(s,settings)
 for(const value of ['unique rule','earlier','later','plugin earlier','plugin later'])assert.ok(text(s).includes(value))
})

test('snapshot cleanup works without real user input and stays disabled with the window switch',()=>{
 const s=fixture()
 for(let i=0;i<30;i++)s.append('user/message',createUserMessage({source:{kind:'runtime-context',form:'snapshot',sections:[{name:'memory',text:'snapshot-'+i}]},content:[{type:'text',text:'snapshot-'+i}]}),{surfaceOp:'append'})
 const count=s.seq
 assert.equal(rollConversationContext(s,{...settings,rollingContextEnabled:false}),0);assert.equal(s.seq,count)
 assert.equal(rollConversationContext(s,settings),29)
 const snapshots=s.deriveMessages().filter(m=>m.source?.kind==='runtime-context')
 assert.equal(snapshots.length,1);assert.match(text(s),/snapshot-29/)
 assert.equal(rollConversationContext(s,settings),0)
})

test('input origins survive native persistence validation without entering model or UI surface',async()=>{
 const {validateStoredEvents}=await import('@deepseek-ai/dsh-session-persistence')
 const s=fixture();round(s,1)
 const messages=s.deriveMessages()
 recordInputOrigin(s,{messageId:'message',routeId:'route',channelId:'qq',userId:'contact'})
 const event=s.snapshotEvents().at(-1)
 assert.equal(event.type,'plugin:dsh-partner/input-origin');assert.equal(event.ignorable,true)
 const restored=validateStoredEvents({id:s.id,version:4},structuredClone(s.snapshotEvents()))
 assert.deepEqual(Session.create('restored',restored).deriveMessages(),messages)
 const broken=structuredClone(restored);delete broken.at(-1).ignorable
 assert.throws(()=>validateStoredEvents({id:s.id,version:4},broken),/unknown to this harness/)
})

