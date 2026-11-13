import test from 'node:test'
import assert from 'node:assert/strict'
import {GroupReplyWindows} from '../lib/channels/qq/reply-window.js'
import {groupTaskInput} from '../lib/channels/qq/task-focus.js'
const peer='group:12345678:22334455'
const event=(at,extra={})=>({id:'m',sender:peer,receivedAt:at,text:'还有一点',qqGroup:{groupId:'12345678',userId:'22334455'},...extra})
test('confirmed first part closes admission while final transport is still running; fresh next turn has no cooldown',()=>{
 const windows=new GroupReplyWindows(),w=windows.begin('q',peer,1000)
 const route=e=>groupTaskInput(e,windows.focus('q',e,undefined,10000),'伙伴',10000)
 assert.equal(route(event(9000)),'steer','slow model does not discard supplements just because five seconds elapsed')
 windows.sent(w,10000)
 assert.equal(route(event(10001)),'observe')
 windows.finish(w,11000)
 assert.equal(route(event(10999)),'observe','already-buffered chatter must not become a new reply')
 assert.equal(route(event(11001)),'normal','no permanent or arbitrary cooldown')
 assert.equal(windows.focus('q',event(10999),undefined,700001),undefined)
})
test('failed/empty sends do not close admission; voice/attachment receipts and current work survive runtime finishing',()=>{
 const windows=new GroupReplyWindows(),w=windows.begin('q',peer,1000)
 const live={userId:peer,startedAt:1000,working:false}
 assert.equal(windows.focus('q',event(2000),live,2000).sentAt,undefined)
 windows.focus('q',event(3000),{...live,working:true,sentAt:2500},3000)
 const after=windows.focus('q',event(4000),undefined,4000)
 assert.equal(after.working,true);assert.equal(after.sentAt,2500)
 windows.finish(w,5000)
 const blank=windows.begin('q',peer,6000);windows.finish(blank,7000)
 assert.equal(windows.focus('q',event(6500),undefined,8000),undefined)
})
test('delivery windows stay isolated and clean up without deleting a newer in-flight response',()=>{
 const windows=new GroupReplyWindows(),a=windows.begin('q',peer,1000),b=windows.begin('q',peer,2000)
 windows.sent(a,2100);windows.finish(a,2200)
 assert.equal(windows.focus('q',event(2300),undefined,2300).sentAt,undefined)
 assert.equal(windows.focus('other',event(2300),undefined,2300),undefined)
 assert.equal(windows.focus('q',event(2300,{sender:'group:87654321:22334455'}),undefined,2300),undefined)
 windows.finish(b,2400);assert.equal(windows.active.size,0)
 for(let i=0;i<140;i++){const w=windows.begin('q','group:12345678:'+i,3000);windows.sent(w,3100);windows.finish(w,3200)}
 assert.equal(windows.recent.size,128)
})
