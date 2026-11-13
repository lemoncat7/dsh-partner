import test from 'node:test'
import assert from 'node:assert/strict'
import {browserAudience,browserAssistance,recentBrowserReceipts,renderBrowserContext} from '../lib/browser/context.js'
import {observeBrowserChange,browserIdentity} from '../lib/browser/observation.js'
const config={enabled:true,autonomous:true,endpoint:'http://chrome:9222/',externalUrl:'https://help.test/',updatedAt:1}
const user=id=>({type:'user/message',data:{id,source:{kind:'user'}}})
const state={sessions:[{companionId:'c',sessionId:'s',kind:'local',channelId:'@local',userId:'owner'},{companionId:'c',sessionId:'s',kind:'channel',channelId:'qq',userId:'group:123:456',inboundMessageIds:['g']}],channels:[{id:'qq',companionId:'c',platform:'qq'}]}
const receipt=(scope='owner',callId='r')=>({type:'tool/ptc-dispatch',data:{name:'partner_browser',isError:false,meta:{kind:'partner-browser-v1',owner:'c',scope,callId,action:'open',observation:observeBrowserChange(config.endpoint,'open','tab',[],[{id:'tab',title:'2048',url:'https://game.test/'}])}}})
test('browser receipt projection survives history serialization without exposing other conversations or identities',()=>{
 const owner=browserAudience('c','s',[user('owner')],state),group=browserAudience('c','s',[user('g')],state)
 assert.equal(owner,'owner');assert.notEqual(group,owner)
 const events=JSON.parse(JSON.stringify([user('owner'),receipt(owner),receipt(group,'g')]))
 assert.equal(recentBrowserReceipts('c',owner,config,events).length,1)
 assert.equal(recentBrowserReceipts('another',owner,config,events).length,0)
 assert.equal(recentBrowserReceipts('c',owner,{...config,enabled:false},events).length,0)
 assert.equal(recentBrowserReceipts('c',owner,{...config,endpoint:'http://different:9222'},events).length,0)
 assert.equal(browserAssistance(config,group),undefined)
 assert.equal(browserAssistance(config,owner).url,'https://help.test/')
 assert.equal(recentBrowserReceipts('c',owner,config,[{...receipt(),data:{...receipt().data,isError:true}}]).length,0)
 assert.equal(recentBrowserReceipts('c',owner,config,events,8,Date.now()+49*3600000).length,0)
})
test('browser context is bounded, labels stale observations, and never mutates raw history',()=>{
 const events=[user('owner'),...Array.from({length:40},(_,i)=>receipt('owner',String(i)))],before=JSON.stringify(events)
 const text=renderBrowserContext('c','s',events,state,config,'刚才网页呢')
 assert.match(text,/2048/);assert.match(text,/页面可能已变化/);assert.match(text,/https:\/\/help.test/)
 assert.ok(text.length<5000);assert.equal(JSON.stringify(events),before)
 assert.equal(renderBrowserContext('c','s',[...events,user('g')],state,config,'网页呢'),'')
})
test('opener links are observed provenance, never assumed to be a successful user interaction',()=>{
 const before=[{id:'game',title:'game',url:'https://game.test/'}],after=[...before,{id:'ad',title:'register',url:'https://ad.test/',openerId:'game'},{id:'unknown',title:'manual',url:'https://manual.test/'}]
 const r=observeBrowserChange(config.endpoint,'press','game',before,after)
 assert.equal(r.changes[0].source,'page-opened');assert.equal(r.changes[1].source,'unknown');assert.equal(r.related[0].id,'ad')
 assert.equal(observeBrowserChange(config.endpoint,'press','game',before,undefined).available,false)
 assert.equal(r.browserId,browserIdentity(config.endpoint))
})
