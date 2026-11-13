// Explicit opt-in against an existing CDP browser; creates and removes only its own fixture tab.
import assert from 'node:assert/strict'
import {CdpConnection} from '../lib/browser/cdp.js'
import {BrowserService} from '../lib/browser/service.js'
const endpoint=process.env.BROWSER_CDP_ENDPOINT
assert.ok(endpoint,'Set BROWSER_CDP_ENDPOINT explicitly')
const signal=AbortSignal.timeout(60000),setup=await CdpConnection.connect(endpoint,signal)
const before=await setup.send('Target.getTargets'),owned=[]
const state={companions:[{id:'test-browser'}]},store={snapshot:()=>structuredClone(state),isCompanionRemoving:()=>false,update:async fn=>fn(state)},service=new BrowserService(store)
try{
 await service.save('test-browser',{endpoint,enabled:true,autonomous:true,expectedUpdatedAt:0})
 const version=await service.test('test-browser',endpoint,signal)
 const {targetId}=await setup.send('Target.createTarget',{url:'about:blank'});owned.push(targetId)
 const {sessionId}=await setup.send('Target.attachToTarget',{targetId,flatten:true})
 const {frameTree}=await setup.send('Page.getFrameTree',{},sessionId)
 await setup.send('Page.setDocumentContent',{frameId:frameTree.frame.id,html:'<!doctype html><meta charset="utf-8"><title>伙伴 CDP 临时验收</title><h1>浏览器功能测试</h1><input id="query" aria-label="测试输入"><button id="apply" onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#query\').value">应用</button><button id="popup" onclick="window.open(\'about:blank\',\'partner-browser-test-popup\')">打开临时页</button><p id="result">尚未操作</p><div style="height:3000px"></div>'},sessionId)
 const run=input=>service.run('test-browser',{tabId:targetId,...input},signal,()=>{})
 assert.ok((await run({action:'tabs'})).tabs.some(t=>t.id===targetId))
 const inspected=await run({action:'inspect'});assert.equal(inspected.title,'伙伴 CDP 临时验收');assert.ok(inspected.elements.some(e=>e.selector==='#query'))
 await run({action:'type',selector:'#query',text:'中文 CDP 测试'})
 await run({action:'click',selector:'#apply'})
 assert.match((await run({action:'inspect'})).text,/中文 CDP 测试/)
 await run({action:'type',selector:'#query',text:'替换完成'})
 await run({action:'press',key:'Tab'});await run({action:'press',key:'Enter'})
 assert.equal((await run({action:'evaluate',expression:'document.querySelector("#result").textContent'})).value,'替换完成')
 await run({action:'type',selector:'#query',text:''})
 assert.equal((await run({action:'evaluate',expression:'document.querySelector("#query").value'})).value,'')
 const shot=await run({action:'screenshot'}),png=Buffer.from(shot.image,'base64');assert.equal(png.subarray(1,4).toString(),'PNG')
 await run({action:'scroll',deltaY:500})
 await new Promise(r=>setTimeout(r,150))
 assert.ok((await run({action:'evaluate',expression:'window.scrollY'})).value>0)
 const popup=await run({action:'click',selector:'#popup'})
 const children=(await setup.send('Target.getTargets')).targetInfos.filter(t=>t.type==='page'&&t.openerId===targetId)
 for(const child of children)owned.push(child.targetId)
 assert.ok(children.length,'Fixture popup did not open')
 assert.ok(popup.browserObservation.changes.some(c=>c.source==='page-opened'&&c.page.openerId===targetId))
 for(const child of children){await setup.send('Target.closeTarget',{targetId:child.targetId});owned.splice(owned.indexOf(child.targetId),1)}
 await run({action:'close'});owned.splice(owned.indexOf(targetId),1)
 const after=await setup.send('Target.getTargets')
 for(const tab of before.targetInfos.filter(t=>t.type==='page'))assert.ok(after.targetInfos.some(t=>t.targetId===tab.targetId),'Existing browser tab removed')
 console.log(JSON.stringify({passed:true,browser:version.browser,protocol:version.protocol,checks:['test connection','tabs','inspect Chinese and selectors','replace text','click','keyboard','clear text','evaluate','PNG screenshot','scroll','close','existing tabs preserved'],screenshotBytes:png.length,existingPages:before.targetInfos.filter(t=>t.type==='page').length}))
}finally{
 service.close()
 for(const targetId of owned)await setup.send('Target.closeTarget',{targetId}).catch(()=>{})
 setup.close()
}
