import test from 'node:test'
import assert from 'node:assert/strict'
import {backgroundOrigin,backgroundRequired} from '../lib/execution/background-routing.js'
import {bindBackgroundScope,backgroundToolScope} from '../lib/execution/background-scope.js'
const user={seq:1,type:'user/message',data:{id:'u',source:{kind:'user'},content:[]}}
const call=(name,args={},id=name)=>({seq:2,type:'tool/call',data:{callId:id,name,arguments:args}})
const result=(id,isError=false)=>({type:'tool/result',data:{message:{toolCallId:id,isError,content:[]}}})
const bili=(operation)=>({action:'call',operation})

test('bounded lookups and their announced tool list stay foreground even after retries',()=>{
 const lookupHistory=[user,
  call('partner_chat_say',{beforeTools:true,expectedTools:['web_fetch','partner_bilibili','web_search']}),
  call('partner_bilibili',{operation:'hot'},'invalid'),result('invalid',true),
  call('partner_tools',{action:'describe',name:'partner_bilibili',operation:'hot'}),
  call('partner_bilibili',bili('search'),'bili'),result('bili'),
  call('web_search',{},'search'),result('search'),
  call('web_fetch',{},'fetch'),result('fetch')]
 const hot=bili('hot')
 assert.equal(backgroundRequired('partner_bilibili',hot,lookupHistory),undefined)
 assert.equal(backgroundRequired('partner_tools',{action:'call',name:'partner_bilibili',argumentsJson:JSON.stringify(hot)},lookupHistory),undefined)
 assert.equal(backgroundRequired('web_search',{},lookupHistory),undefined)
 assert.equal(backgroundRequired('partner_qq',{action:'call',operation:'get_friend_list'},lookupHistory),undefined)
})

test('executable or continuing work must hand off; discovery and failed attempts do not count',()=>{
 for(const name of ['generate_image','edit_image','bash','write','partner_browser'])assert.match(backgroundRequired(name,{action:'open'},[user]),/后台/)
 assert.equal(backgroundRequired('partner_browser',{action:'recent'},[user]),undefined)
 assert.match(backgroundRequired('partner_tools',{action:'call',name:'partner_browser',argumentsJson:'{"action":"open"}'},[user]),/后台/)
 const wrappedFailure=call('partner_tools',{action:'call',name:'custom_work',argumentsJson:'{}'},'wrapped')
 const attempts=[user,call('custom_work',{},'failed'),result('failed',true),wrappedFailure,{type:'tool/ptc-dispatch',data:{parentCallId:'wrapped',isError:true}},result('wrapped'),call('custom_work',{},'ok'),result('ok')]
 assert.equal(backgroundRequired('custom_work',{},attempts),undefined)
 assert.match(backgroundRequired('custom_work',{},[...attempts,call('custom_work',{},'second'),result('second')]),/后台/)
 assert.equal(backgroundRequired('partner_background_task',{action:'start'},[user]),undefined)
})
test('current dispatch excluded from work count; new input resets workflow',()=>{
 assert.equal(backgroundRequired('web_fetch',{},[user,call('web_search',{},'one'),call('web_fetch',{},'current')],'current'),undefined)
 assert.equal(backgroundRequired('web_search',{},[user,call('web_search'),call('web_fetch'),{...user,seq:4,data:{...user.data,id:'new'}}]),undefined)
})
test('handoff prevents duplicate foreground work',()=>{
 const accepted=[user,call('partner_background_task',{action:'start'},'b'),{seq:3,type:'tool/result',data:{message:{toolCallId:'b',content:[{type:'text',text:JSON.stringify({kind:'partner-background-v1',taskId:'task',status:'running'})}]}}}]
 assert.match(backgroundRequired('web_search',{},accepted),/不能重复/)

})
test('local routes are generic; internal notices cannot launch new tasks',()=>{
 const routes=[{id:'r',companionId:'different-companion',kind:'local',sessionId:'s'}]
 assert.equal(backgroundOrigin('s',[user],routes),routes[0])
 const notice={seq:3,type:'user/message',data:{source:{kind:'plugin:@lemoncat7/dsh-partner',plugin:'@lemoncat7/dsh-partner',form:'notice',summary:'伙伴长任务续接'},content:[]}}
 assert.equal(backgroundOrigin('s',[user,notice],routes),undefined)
})
test('background authority is host-issued, owner-scoped, live and disposable',()=>{
 const store={};let valid=true
 const dispose=bindBackgroundScope(store,'child',{owner:'a',browserScope:'owner',authorize(){if(!valid)throw Error('revoked')}})
 assert.equal(backgroundToolScope(store,'b','child'),undefined)
 assert.equal(backgroundToolScope(store,'a','child').browserScope,'owner')
 valid=false;assert.throws(()=>backgroundToolScope(store,'a','child'),/revoked/)
 dispose();assert.equal(backgroundToolScope(store,'a','child'),undefined)
})

test('host-bound child can use browser with original audience; revocation stops further operation',async()=>{
 const {browserTool}=await import('../lib/browser/tool.js')
 const state={sessions:[],companions:[],channels:[]},store={snapshot:()=>state,isCompanionRemoving:()=>false};let valid=true,operations=0
 const unbind=bindBackgroundScope(store,'worker',{owner:'c',browserScope:'owner',authorize(){if(!valid)throw Error('revoked')}})
 const service={config:()=>({enabled:true,externalUrl:'https://browser.example'}),run:async(_owner,_input,_signal,check)=>{check();operations++;return {available:true}}}
 const tool=browserTool('c',store,service,{}),exec={agent:{session:{id:'worker',snapshotEvents:()=>[]}},signal:new AbortController().signal}
 await tool.execute({action:'open',url:'https://example.com'},exec);assert.equal(operations,1)
 valid=false;await assert.rejects(tool.execute({action:'inspect',tabId:'tab'},exec),/revoked/);assert.equal(operations,1)
 unbind();await assert.rejects(tool.execute({action:'tabs'},exec),/不能使用/)
})


test('publishing prepared space content stays foreground after lookups, but cannot repeat an accepted task',()=>{
 const args={action:'call',operation:'send_qzone_msg',params:{text:'prepared'}}
 const looked=[user,call('web_search'),call('web_fetch')]
 assert.equal(backgroundRequired('partner_qq',args,looked),undefined)
 assert.equal(backgroundRequired('partner_tools',{action:'call',name:'partner_qq',argumentsJson:JSON.stringify(args)},looked),undefined)
 const accepted=[...looked,call('partner_background_task',{action:'start'},'b'),{type:'tool/result',data:{message:{toolCallId:'b',content:[{type:'text',text:JSON.stringify({kind:'partner-background-v1',taskId:'t',status:'running'})}]}}}]
 assert.match(backgroundRequired('partner_qq',args,accepted),/不能重复/)
 assert.match(backgroundRequired('generate_image',{},looked),/后台/)
})

test('single native background commands and job controls stay in the parent without spawning an agent',()=>{
 const busy=[user,call('custom_work',{},'a'),result('a'),call('custom_work',{},'b'),result('b')]
 for(const name of ['bash','terminal_send']){
  assert.equal(backgroundRequired(name,{run_in_background:true},busy),undefined)
  assert.equal(backgroundRequired('partner_tools',{action:'call',name,argumentsJson:'{"run_in_background":true}'},busy),undefined)
 }
 for(const name of ['job_list','job_output','job_kill','terminal_open','terminal_read','terminal_list','terminal_signal','terminal_close'])assert.equal(backgroundRequired(name,{},busy),undefined)
 assert.match(backgroundRequired('bash',{run_in_background:false},[user]),/后台/)
 assert.match(backgroundRequired('generate_image',{run_in_background:true},[user]),/后台/,'an arbitrary flag does not turn other operations into native jobs')
 const accepted=[user,call('partner_background_task',{action:'start'},'start'),{type:'tool/result',data:{message:{toolCallId:'start',content:[{type:'text',text:JSON.stringify({kind:'partner-background-v1',taskId:'t',status:'running'})}]}}}]
 assert.match(backgroundRequired('bash',{run_in_background:true},accepted),/不能重复/)
 assert.equal(backgroundRequired('job_output',{job_id:'existing'},accepted),undefined)
})
