import test from 'node:test'
import assert from 'node:assert/strict'
import {DirectLoginCache} from '../lib/channels/direct/login-cache.js'
import {PartnerAgentRuntime} from '../lib/agent-runtime.js'

test('test, repeated test and save reuse a single login; saved token is not revoked',async()=>{
 let logins=0,logouts=0
 const cache=new DirectLoginCache(30,async()=>{logins++;return 'token'},async()=>{logouts++})
 const config={platform:'matrix',baseUrl:'https://example.invalid',targetId:''}
 const input={username:'user',password:'secret'}
 const [a,b]=await Promise.all([cache.acquire('c',config,input),cache.acquire('c',config,input)])
 assert.equal(a.token,b.token)
 const saved=await cache.acquire('c',config,input);saved.retain()
 await new Promise(r=>setTimeout(r,60))
 assert.equal(logins,1);assert.equal(logouts,0)
})
test('unretained test session expires and is revoked',async()=>{
 let logouts=0
 const cache=new DirectLoginCache(15,async()=> 'token',async()=>{logouts++})
 await cache.acquire('c',{platform:'matrix',baseUrl:'https://example.invalid',targetId:''},{username:'u',password:'p'})
 await new Promise(r=>setTimeout(r,40))
 assert.equal(logouts,1)
})
test('all channel routes reuse local primary session, with different companions isolated',async()=>{
 const state={companions:[{id:'c'},{id:'other'}],sessions:[]}
 const runtime=Object.create(PartnerAgentRuntime.prototype)
 runtime.store={isCompanionRemoving:()=>false,snapshot:()=>structuredClone(state),update:async fn=>fn(state)}
 runtime.ctx={workspaceRegistry:{archivedSessionIds:[]}}
 runtime.defaultCwd='/tmp'
 const local=await runtime.ensureLocalSessionRecord('c')
 const matrix=await runtime.ensureSession(state.companions[0],'matrix','alice')
 const wechat=await runtime.ensureSession(state.companions[0],'weixin','bob')
 const other=await runtime.ensureLocalSessionRecord('other')
 assert.equal(matrix.sessionId,local.sessionId);assert.equal(wechat.sessionId,local.sessionId)
 assert.notEqual(other.sessionId,local.sessionId)
 assert.equal((await runtime.ensureLocalSessionRecord('c')).sessionId,local.sessionId)
})
test('channel replies serialize across all contacts of the same companion',async()=>{
 const runtime=Object.create(PartnerAgentRuntime.prototype);runtime.queues=new Map()
 let active=0,max=0
 runtime.drive=async()=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,10));active--;return {text:'ok',attachments:[]}}
 await Promise.all([runtime.reply({id:'c'},'matrix','a',{}),runtime.reply({id:'c'},'wechat','b',{})])
 assert.equal(max,1)
})
