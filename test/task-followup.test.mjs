import test from 'node:test'
import assert from 'node:assert/strict'
import {taskFollowup,renderTaskFollowup,checkTaskReview} from '../lib/chat/task-followup.js'
import {ReplyCompletionGuard} from '../lib/chat/reply-completion.js'
import {IDLE_CONTACT_NOTICE} from '../lib/character/idle-contact.js'
import {projectConversationPrompt} from '../lib/character/prompt-projection.js'
function fixture(){
 let seq=0;const events=[],state={sessions:[{id:'r',kind:'channel',sessionId:'s',companionId:'c',channelId:'qq',userId:'12345678',inboundMessageIds:['old','new','next']} ]}
 const add=(type,data)=>events.push({type,data,seq:++seq,time:Date.now()})
 const user=(id,text)=>add('user/message',{id,source:{kind:'user'},content:[{type:'text',text}]})
 const result=(id,name,args={},ok=true,meta)=>{add('tool/call',{callId:id,name,arguments:JSON.stringify(args)});add('tool/result',{message:{toolCallId:id,isError:!ok,content:[{type:'text',text:JSON.stringify({ok})}]},...(meta?{meta}:{})})}
 const chat=(id,meta={})=>result(id,'partner_chat_reply',{},true,{kind:'partner-chat-v1',parts:[{type:'text',text:'四次按键88毫秒'}],originRouteId:'r',...meta})
 add('turn/start',{turn:1});user('old','我觉得你可以试试，怎么加快反应速度');result('old-work','bash');chat('old-reply');add('turn/end',{reason:{kind:'completed'}})
 add('turn/start',{turn:2});user('new','打游戏肯定需要先理解当时在做什么，要做什么，再决定怎么做')
 const context=()=>taskFollowup(state,'c','s',events)
 return {events,state,add,user,result,chat,context}
}
test('recent work is optional context; claimed progress still needs real evidence',()=>{
 const f=fixture(),c=f.context();assert.equal(c.taskInputId,'old');assert.match(c.request,/加快反应速度/);assert.deepEqual(c.currentResults,[])
 assert.equal(checkTaskReview(c,undefined),undefined)
 assert.throws(()=>checkTaskReview(c,{taskInputId:'old',kind:'completed',reason:'知道应该先看局面',callId:'old-work'}),/本轮实际/)
 f.result('directory','partner_tools',{action:'describe',name:'bash'})
 assert.throws(()=>checkTaskReview(f.context(),{taskInputId:'old',kind:'completed',reason:'查过工具',callId:'directory'}),/本轮实际/)
 f.result('checked-board','bash')
 const r=checkTaskReview(f.context(),{taskInputId:'old',kind:'progress',reason:'已读取当前棋盘并观察操作后的变化',callId:'checked-board'})
 assert.equal(r.inputId,'new');assert.equal(r.request,c.request)
})
for(const kind of ['discussion','cancelled','unrelated'])test('explicit '+kind+' can finish without forcing work',()=>{
 const f=fixture();const r=checkTaskReview(f.context(),{taskInputId:'old',kind,reason:'依当前用户意图处理'})
 assert.equal(r.kind,kind)
 f.chat('new-reply',{taskReview:r,transportCallId:'nested-voice'});f.add('turn/end',{reason:{kind:'completed'}});f.add('turn/start',{turn:3});f.user('next','再说一句')
 assert.equal(f.context(),undefined)
})
test('later progress preserves original task across input turns and voice parent receipts',()=>{
 const f=fixture();f.result('check','bash')
 const r=checkTaskReview(f.context(),{taskInputId:'old',kind:'progress',reason:'当前步骤已核验',callId:'check'})
 f.chat('new-reply',{taskReview:r,transportCallId:'voice-child'});f.add('turn/end',{reason:{kind:'completed'}});f.add('turn/start',{turn:3});f.user('next','继续看看')
 const next=f.context();assert.equal(next.taskInputId,'old');assert.match(next.request,/加快反应速度/);assert.equal(next.results[0].callId,'check');assert.deepEqual(next.currentResults,[])
})
test('failed results cannot count as completion and blocked results must be real',()=>{
 const f=fixture();f.result('fail','bash',{},false)
 assert.throws(()=>checkTaskReview(f.context(),{taskInputId:'old',kind:'completed',reason:'完成',callId:'fail'}),/实际成功/)
 assert.equal(checkTaskReview(f.context(),{taskInputId:'old',kind:'blocked',reason:'实际操作失败',callId:'fail'}).callId,'fail')
 assert.throws(()=>checkTaskReview(f.context(),{taskInputId:'old',kind:'blocked',reason:'服务失败',callId:'invented'}),/不是本轮实际失败/)
})
test('structured failures and successful wrappers around failed children are not work evidence',()=>{
 for(const payload of [{exit_code:1},{result:{status:'failed'}},{dispatch:{isError:true}},{ok:false}]){
  const f=fixture();f.result('bad','bash');f.events.at(-1).data.message.content=[{type:'text',text:JSON.stringify(payload)}]
  assert.equal(f.context().currentResults[0].ok,false)
 }
 const f=fixture()
 f.add('tool/call',{callId:'outer',name:'partner_tools',arguments:JSON.stringify({action:'call',name:'partner_bilibili',argumentsJson:'{}'})})
 f.add('tool/ptc-dispatch',{parentCallId:'outer',subCallId:'child',name:'partner_bilibili',arguments:'{}',isError:true,content:[{type:'text',text:'request failed'}]})
 f.add('tool/result',{message:{toolCallId:'outer',isError:false,content:[{type:'text',text:'request failed'}]}})
 assert.deepEqual(f.context().currentResults.map(r=>r.ok),[false,false])
 assert.throws(()=>checkTaskReview(f.context(),{taskInputId:'old',kind:'completed',reason:'完成',callId:'outer'}),/实际成功/)
})
test('same-session other peers, groups, autonomous and expired work do not inherit tasks',()=>{
 for(const mode of ['other-peer','group','autonomous','expired','unknown','other-owner']){
  const f=fixture();
  if(mode==='other-peer'){f.state.sessions[0].inboundMessageIds=['old'];f.state.sessions.push({...f.state.sessions[0],id:'r2',userId:'87654321',inboundMessageIds:['new']})}
  if(mode==='group')f.state.sessions[0].userId='group:123456:12345678'
  if(mode==='autonomous')f.add('user/message',{id:'idle',source:{kind:'plugin:@lemoncat7/dsh-partner',form:'notice',summary:IDLE_CONTACT_NOTICE},content:[]})
  if(mode==='expired')f.events[1].time-=25*3600000
  if(mode==='unknown')f.state.sessions[0].inboundMessageIds=[]
  if(mode==='other-owner')f.state.sessions[0].companionId='other'
  assert.equal(f.context(),undefined,mode)
 }
})
test('exclusive persona mode keeps task request in runtime context, outside rolling chat messages',()=>{
 const f=fixture();assert.match(renderTaskFollowup(f.context()),/近期任务/);f.result('current-check','bash')
 const text=renderTaskFollowup(f.context()),contexts=[{name:'partner-conversation-memory',text}]
 const assembly=projectConversationPrompt({sections:[{name:'partner-identity',text:'自定义人格'}],contexts,tools:[]},{},{roleEnabled:true,exclusive:true,discovery:true})
 assert.deepEqual(assembly.contexts,contexts);assert.match(assembly.contexts[0].text,/加快反应速度/);assert.match(text,/纠正或延续/)
})
test('ordinary final prose after work never starts a task-review recovery',()=>{
 const f=fixture(),steered=[];f.add('assistant/message',{message:{role:'assistant',content:[{type:'text',text:'对，只按得快不等于会玩'}]}})
 const agent={session:{snapshotEvents:()=>f.events},steer:m=>steered.push(m)}
 const guard=new ReplyCompletionGuard(agent,()=>true),input={agent,signal:new AbortController().signal}
 guard.stop(input);guard.stop(input);guard.stop(input)
 assert.equal(steered.length,0);assert.equal(guard.failed,false)
})
for(const text of ['没关系的','倒也合理','哈哈 你又看岔啦'])test('a conversational answer retires recent work: '+text,()=>{
 const f=fixture();assert.ok(f.context());f.chat('new-reply')
 f.add('turn/end',{reason:{kind:'completed'}});f.add('turn/start',{turn:3});f.user('next',text)
 assert.equal(f.context(),undefined)
})
test('completed review without new work cannot resurrect an old task',()=>{
 const f=fixture();f.chat('new-reply',{taskReview:{inputId:'new',taskInputId:'old',request:'old request',kind:'completed',reason:'legacy review'}})
 f.add('turn/end',{reason:{kind:'completed'}});f.add('turn/start',{turn:3});f.user('next','没关系')
 assert.equal(f.context(),undefined)
})
test('real work after a completed review remains available for a correction',()=>{
 const f=fixture();f.result('fix','bash')
 f.chat('new-reply',{taskReview:checkTaskReview(f.context(),{taskInputId:'old',kind:'completed',reason:'已修正',callId:'fix'})})
 f.add('turn/end',{reason:{kind:'completed'}});f.add('turn/start',{turn:3});f.user('next','第二张也换掉')
 assert.equal(f.context().results[0].callId,'fix')
})

test('idle turns between correction inputs preserve the user goal and exclude autonomous evidence',()=>{
 const f=fixture();const pos=f.events.findIndex(e=>e.type==='user/message'&&e.data.id==='new')
 f.events.splice(pos-1,0,{type:'user/message',seq:20,time:Date.now(),data:{id:'idle',source:{kind:'plugin:@lemoncat7/dsh-partner',form:'notice',summary:IDLE_CONTACT_NOTICE},content:[]}},{type:'tool/call',seq:21,time:Date.now(),data:{callId:'idle-op',name:'bash',arguments:'{}'}},{type:'tool/result',seq:22,time:Date.now(),data:{message:{toolCallId:'idle-op',content:[]}}})
 const task=f.context();assert.equal(task.taskInputId,'old');assert.deepEqual(task.results.map(r=>r.callId),['old-work'])
 assert.throws(()=>checkTaskReview(task,undefined,{continuing:false}),/最终回复尚未发送/)
 const repair={taskInputId:'old',kind:'repair',reason:'用户指出原成果遗漏',remaining:'取回已有参考并修正原成果'}
 assert.throws(()=>checkTaskReview(task,repair,{continuing:false}),/不能最终收尾/)
 const receipt=checkTaskReview(task,repair,{continuing:true});f.chat('repair',{intermediate:true,taskReview:receipt})
 f.add('turn/end',{reason:{kind:'aborted'}});f.add('turn/start',{turn:3});f.user('next','对呀 好不开心')
 assert.equal(f.context().pending,repair.remaining);assert.equal(f.context().taskInputId,'old')
 assert.match(renderTaskFollowup(f.context()),/取回已有参考/)
})
test('inspection cannot close a previous execution goal; completed repairs can',()=>{
 const f=fixture();f.result('inspected','read')
 const review={taskInputId:'old',kind:'completed',reason:'查出原因了',callId:'inspected'}
 assert.throws(()=>checkTaskReview(f.context(),review,{continuing:false}),/查明原因/)
 assert.equal(checkTaskReview(f.context(),{taskInputId:'old',kind:'discussion',reason:'用户明确只问原因'},{continuing:false}).kind,'discussion')
 f.result('fixed','generate_image');assert.equal(checkTaskReview(f.context(),{...review,callId:'fixed',reason:'已按纠正完成'},{continuing:false}).kind,'completed')
})
test('progress continues in the same turn while a genuine blocker can end it',()=>{
 const f=fixture();f.result('checked','read');const review={taskInputId:'old',kind:'progress',reason:'已查到来源',remaining:'继续修正',callId:'checked'}
 assert.throws(()=>checkTaskReview(f.context(),review,{continuing:false}),/不能最终收尾/)
 assert.equal(checkTaskReview(f.context(),review,{continuing:true}).remaining,'继续修正')
 assert.equal(checkTaskReview(f.context(),{taskInputId:'old',kind:'blocked',reason:'缺少访问凭据 无法读取原文件',remaining:'取得原文件'},{continuing:false}).kind,'blocked')
})
