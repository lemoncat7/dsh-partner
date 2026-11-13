import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {WebSocketServer} from 'ws'
import {BrowserService} from '../lib/browser/service.js'
import {browserExternalUrl,browserEndpoint} from '../lib/browser/domain.js'
import {browserTool} from '../lib/browser/tool.js'
import {createChannelActivities} from '../lib/channels/activity-defaults.js'
import {PartnerStore} from '../lib/store.js'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'

async function fixture(t) {
  let endpoint,malformed=false;const targets=[{targetId:'tab',type:'page',title:'测试',url:'https://example.com'},{targetId:'worker',type:'worker'}]; const commands=[],sockets=new Set()
  const server=createServer((req,res)=>{assert.equal(req.headers.host,'localhost');res.setHeader('content-type','application/json');res.end(JSON.stringify({webSocketDebuggerUrl:'ws://untrusted.invalid:1/devtools/browser/test'}))})
  const ws=new WebSocketServer({server})
  ws.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('message',data=>{
    const r=JSON.parse(data);commands.push(r)
    if(malformed){socket.send('null');return}
    if(r.method==='Runtime.evaluate'&&r.params.expression==='never')return
    if(r.method==='Runtime.evaluate'&&r.params.expression==='open-popup')targets.push({targetId:'popup',type:'page',title:'注册',url:'https://register.test/?token=secret',openerId:'tab'});
    if(r.method==='Target.createTarget')targets.push({targetId:'new',type:'page',url:r.params.url,title:'new'});
    if(r.method==='Target.closeTarget'){const i=targets.findIndex(t=>t.targetId===r.params.targetId);if(i>=0)targets.splice(i,1)}
    const result=r.method==='Browser.getVersion'?{product:'Chrome/Test',protocolVersion:'1.3'}:r.method==='Target.getTargets'?{targetInfos:targets}:r.method==='Target.getTargetInfo'?{targetInfo:{type:'page'}}:r.method==='Target.attachToTarget'?{sessionId:'session'}:r.method==='Target.createTarget'?{targetId:'new'}:r.method==='Runtime.evaluate'?{result:{value:{title:'页面',text:'外部内容'}}}:r.method==='Page.captureScreenshot'?{data:Buffer.from('image').toString('base64')}:{success:true}
    socket.send(JSON.stringify({id:r.id,result}))
  })})
  await new Promise(r=>server.listen(0,'127.0.0.1',r));endpoint=`http://127.0.0.1:${server.address().port}/`
  const state={companions:[{id:'c'}],sessions:[{companionId:'c',sessionId:'s',kind:'local'}],channels:[],pairings:[]}
  const store={snapshot:()=>structuredClone(state),isCompanionRemoving:()=>false,update:async f=>f(state)}
  const service=new BrowserService(store)
  t.after(async()=>{service.close();for(const socket of sockets)socket.terminate();await new Promise(r=>ws.close(r));await new Promise(r=>server.close(r))})
  const save=(patch={})=>service.save('c',{enabled:true,autonomous:true,endpoint,expectedUpdatedAt:state.companions[0].browser?.updatedAt??0,...patch})
  const run=(input,signal=new AbortController().signal,guard=()=>{},autonomous=false)=>service.run('c',input,signal,guard,autonomous)
  return {endpoint,state,store,service,commands,save,run,targets,malformed:()=>{malformed=true}}
}

test('CDP addresses accept container HTTP and browser WS, reject secrets and incorrect paths',()=>{
  assert.equal(browserEndpoint('http://chromium:9222'),'http://chromium:9222/')
  assert.equal(browserEndpoint('wss://browser.test/devtools/browser/a-b'),'wss://browser.test/devtools/browser/a-b')
  for(const value of ['file:///tmp/a','http://u:p@host','http://host/?token=secret','http://host/path','ws://host/devtools/page/a','not a URL'])assert.throws(()=>browserEndpoint(value))
})
test('connection test reaches configured server despite advertised foreign host, without saving settings',async t=>{
  const f=await fixture(t)
  assert.deepEqual(await f.service.test('c',f.endpoint,new AbortController().signal),{connected:true,browser:'Chrome/Test',protocol:'1.3'})
  assert.equal(f.state.companions[0].browser,undefined)
})
test('configuration survives store reload; stale saves cannot overwrite it',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'partner-browser-'));t.after(()=>rm(dir,{recursive:true,force:true}))
  const path=join(dir,'state.json'),store=await PartnerStore.open(path),id=store.snapshot().companions[0].id,service=new BrowserService(store)
  const saved=await service.save(id,{enabled:true,autonomous:false,endpoint:'http://chromium:9222',externalUrl:'https://help.test/',expectedUpdatedAt:0})
  assert.deepEqual((await PartnerStore.open(path)).snapshot().companions[0].browser,saved)
  await assert.rejects(service.save(id,{...saved,enabled:false,expectedUpdatedAt:0}),/变化/)
})
test('disabled and autonomous switches are enforced, ordinary public browsing still works',async t=>{
  const f=await fixture(t)
  await assert.rejects(f.run({action:'tabs'}),/未开启/)
  await f.save({autonomous:false})
  await assert.rejects(f.run({action:'tabs'},undefined,undefined,true),/未开启/)
  assert.equal((await f.run({action:'tabs'})).tabs.length,1)
  await f.save({enabled:false});await assert.rejects(f.run({action:'tabs'}),/未开启/)
})
test('tab targeting, remote session commands and URL restrictions use actual CDP transport',async t=>{
  const f=await fixture(t);await f.save()
  assert.equal((await f.run({action:'open',url:'https://example.com'})).tabId,'new')
  await assert.rejects(f.run({action:'open',url:'file:///etc/passwd'}),/HTTP/)
  await assert.rejects(f.run({action:'inspect'}),/标签页/)
  const r=await f.run({action:'inspect',tabId:'tab'});assert.equal(r.title,'页面')
  assert.equal(f.commands.find(c=>c.method==='Runtime.evaluate').sessionId,'session')
  await f.run({action:'press',tabId:'tab',key:'Enter'})
  assert.deepEqual(f.commands.filter(c=>c.method==='Input.dispatchKeyEvent').map(c=>c.params.type),['keyDown','keyUp'])
})
test('cancel interrupts pending CDP commands, rejects concurrent work and frees next request',async t=>{
  const f=await fixture(t);await f.save();const abort=new AbortController()
  const pending=f.run({action:'evaluate',tabId:'tab',expression:'never'},abort.signal)
  const rejected=assert.rejects(pending,/取消|超时/)
  while(!f.commands.some(c=>c.method==='Runtime.evaluate'))await new Promise(r=>setTimeout(r,5))
  await assert.rejects(f.run({action:'tabs'}),/另一项/)
  abort.abort();await rejected
  assert.equal((await f.run({action:'tabs'})).tabs.length,1)
})
test('saved revocation aborts in-flight operations without repeating writes',async t=>{
  const f=await fixture(t);await f.save()
  const pending=f.run({action:'evaluate',tabId:'tab',expression:'never'}),rejected=assert.rejects(pending,/取消|变化|超时/)
  while(!f.commands.some(c=>c.method==='Runtime.evaluate'))await new Promise(r=>setTimeout(r,5))
  await f.save({enabled:false});await rejected
  assert.equal(f.commands.filter(c=>c.method==='Runtime.evaluate').length,1)
})
test('public browser tool checks companion ownership and renders screenshots as images',async t=>{
  const f=await fixture(t);await f.save()
  const tool=browserTool('c',f.store,f.service,{attachments:{saveImage:async data=>({id:'image-ref',mediaType:data.mediaType})}})
  const exec={signal:new AbortController().signal,agent:{session:{id:'s',snapshotEvents:()=>[]}}}
  const result=await tool.execute({action:'screenshot',tabId:'tab'},exec)
  assert.equal(tool.output.render({},result)[1].type,'image');assert.equal(result.attachment.id,'image-ref')
  exec.agent.session.id='other';await assert.rejects(tool.execute({action:'tabs'},exec),/当前会话/)
})
test('activity discovery follows live browser settings, without a private capability requirement',async t=>{
  const f=await fixture(t);f.state.channels=[{id:'q',companionId:'c',platform:'qq',enabled:true}]
  const registry=createChannelActivities(undefined,()=>f.store.snapshot())
  const browse=()=>registry.describe(f.store.snapshot(),'c').flatMap(s=>s.activities).filter(a=>a.tool==='partner_browser')
  assert.equal(browse().length,0);await f.save();assert.equal(browse()[0].visibility,'public');await f.save({autonomous:false});assert.equal(browse().length,0)
})

test('malformed CDP messages fail the request without crashing the plugin',async t=>{
 const f=await fixture(t);f.malformed()
 await assert.rejects(f.service.test('c',f.endpoint,new AbortController().signal),/断开|取消/)
})


test('human browser link is optional, independently validated, preserved for old clients and clearable',async t=>{
 const f=await fixture(t)
 assert.equal(browserExternalUrl(' https://chrome.example.test:1443/view '),'https://chrome.example.test:1443/view')
 for(const value of ['javascript:alert(1)','ws://host','https://u:p@host','https://host/?token=secret','invalid',12])assert.throws(()=>browserExternalUrl(value))
 await f.save({externalUrl:'https://chrome.example.test:1443'})
 assert.equal(f.service.config('c').externalUrl,'https://chrome.example.test:1443/')
 await f.save({autonomous:false});assert.equal(f.service.config('c').externalUrl,'https://chrome.example.test:1443/')
 assert.equal(f.service.config('c').endpoint,f.endpoint)
 await f.save({externalUrl:''});assert.equal(f.service.config('c').externalUrl,undefined)
})
test('actual CDP responses distinguish directly opened pages, child popups and closed pages',async t=>{
 const f=await fixture(t);await f.save()
 const opened=await f.run({action:'open',url:'https://open.test/'})
 assert.equal(opened.browserObservation.changes.find(c=>c.page.id==='new').source,'requested')
 const popup=await f.run({action:'evaluate',tabId:'tab',expression:'open-popup'})
 assert.equal(popup.browserObservation.changes[0].source,'page-opened')
 assert.equal(popup.browserObservation.related[0].openerId,'tab')
 assert.doesNotMatch(JSON.stringify(popup.browserObservation),/token|secret/)
 assert.equal((await f.run({action:'tabs'})).tabs.find(t=>t.id==='popup').openerId,'tab')
 const closed=await f.run({action:'close',tabId:'new'})
 assert.equal(closed.browserObservation.changes.find(c=>c.page.id==='new').kind,'closed')
 f.targets.push({targetId:'manual',type:'page',title:'manual',url:'https://manual.test/'})
 const result=await f.run({action:'inspect',tabId:'tab'})
 assert.ok(!result.browserObservation.changes.some(c=>c.page.id==='manual'))
})
test('browser tool stores compact receipt metadata; recent recall is local and help does not navigate',async t=>{
 const f=await fixture(t);await f.save({externalUrl:'https://help.test/'})
 f.state.sessions[0].userId='owner';f.state.sessions[0].channelId='@local'
 const events=[{type:'user/message',data:{id:'u',source:{kind:'user'}}}],agent={session:{id:'s',snapshotEvents:()=>events}}
 const tool=browserTool('c',f.store,f.service,{attachments:{saveImage:async()=>({id:'image-ref'})}})
 const exec={signal:new AbortController().signal,agent,callId:'shot'}
 const result=await tool.execute({action:'screenshot',tabId:'tab'},exec)
 const meta=tool.output.presentationMeta({},result)
 assert.equal(meta.kind,'partner-browser-v1');assert.equal(meta.scope,'owner')
 assert.ok(!JSON.stringify(meta).includes('image-ref'))
 events.push({type:'tool/ptc-dispatch',data:{name:'partner_browser',isError:false,meta}})
 const before=f.commands.length,r=await tool.execute({action:'recent'},exec)
 assert.equal(f.commands.length,before);assert.equal(r.records.length,1)
 assert.equal(r.assistance.url,'https://help.test/')
 assert.equal((await tool.execute({action:'status'},exec)).assistance.url,'https://help.test/')
 assert.equal(f.commands.length,before)
})


test('host pipeline accepts strict JSON browser outputs with and without assistance, preserving receipts',async t=>{
 const {Context}=await import('@deepseek-ai/cordis'),{ToolRuntime}=await import('@deepseek-ai/dsh-tools'),{createScope}=await import('@deepseek-ai/dsh-scope'),{Session}=await import('@deepseek-ai/dsh-session'),{createUserMessage}=await import('@deepseek-ai/dsh-llm'),{dispatchTool}=await import('../lib/compat/tool-dispatch.js')
 const f=await fixture(t);await f.save()
 const root=new Context();root.provide('systemPrompt',{tools:()=>()=>{}});new ToolRuntime(root)
 const agent={session:Session.create('browser-pipeline'),options:{}},scope=createScope(root,agent);agent.ctx=scope.ctx;t.after(()=>scope.dispose())
 Object.assign(f.state.sessions[0],{sessionId:agent.session.id,channelId:'@local',userId:'owner'})
 agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'浏览器验证'}]}),{surfaceOp:'append'})
 t.after(scope.ctx.tools.register(browserTool('c',f.store,f.service,scope.ctx)))
 const run=async(action,args={})=>{const result=await dispatchTool(root.tools,{name:'partner_browser',arguments:{action,...args},callId:'host-'+action,agent,signal:new AbortController().signal});assert.equal(result.isError,false,JSON.stringify(result.content));return result}
 for(const action of ['status','recent'])assert.equal((await run(action)).value.assistance,undefined)
 await f.save({externalUrl:'https://help.test/'})
 assert.equal((await run('status')).value.assistance.url,'https://help.test/')
 const tabs=await run('tabs');assert.equal(tabs.meta.kind,'partner-browser-v1');assert.equal(tabs.meta.scope,'owner')
 assert.ok(!Object.hasOwn(JSON.parse(tabs.content[0].text),'receipt'))
 for(const [action,args] of [['inspect',{tabId:'tab'}],['press',{tabId:'tab',key:'Enter'}],['open',{url:'https://open.test/'}],['close',{tabId:'new'}]])await run(action,args)
 const u=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'群浏览器状态'}]});agent.session.append('user/message',u,{surfaceOp:'append'})
 f.state.sessions.push({companionId:'c',sessionId:agent.session.id,kind:'channel',channelId:'qq',userId:'group:123:456',inboundMessageIds:[u.id]});f.state.channels.push({id:'qq',companionId:'c',platform:'qq'})
 assert.equal((await run('status')).value.assistance,undefined);assert.deepEqual((await run('recent')).value.records,[])
})
