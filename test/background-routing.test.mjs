import test from 'node:test'
import assert from 'node:assert/strict'
import {backgroundOrigin,backgroundRequired} from '../lib/execution/background-routing.js'
import {bindBackgroundScope,backgroundToolScope} from '../lib/execution/background-scope.js'
const user={seq:1,type:'user/message',data:{id:'u',source:{kind:'user'},content:[]}}
const call=(name,args={},id=name)=>({seq:2,type:'tool/call',data:{callId:id,name,arguments:args}})
test('one or two lightweight lookups stay foreground; executable work and continuing research must hand off',()=>{
 assert.equal(backgroundRequired('web_search',{},[user]),undefined)
 assert.equal(backgroundRequired('web_fetch',{},[user,call('web_search')]),undefined)
 assert.match(backgroundRequired('web_search',{},[user,call('web_search',{},'one'),call('web_fetch',{},'two')]),/后台/)
 for(const name of ['generate_image','edit_image','bash','write','partner_browser'])assert.match(backgroundRequired(name,{action:'open'},[user]),/后台/)
 assert.equal(backgroundRequired('partner_browser',{action:'recent'},[user]),undefined)
 assert.match(backgroundRequired('partner_tools',{action:'call',name:'partner_browser',argumentsJson:'{"action":"open"}'},[user]),/后台/)
 assert.match(backgroundRequired('web_search',{},[user,call('partner_chat_say',{beforeTools:true,expectedTools:['web_search','web_fetch']})]),/后台/)
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
