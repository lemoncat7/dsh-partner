import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {authenticatedObservationHosts,observationAuthDenial,observationHttpHint,observationSignature,redactProgress,resumeObservation} from '../lib/observation-progress.js'
import {PartnerConcernStore} from '../lib/concern-store.js'

test('explicit authentication binding blocks anonymous web tools without granting command access',()=>{
 const hosts=authenticatedObservationHosts('令牌 abcdefghijklmnop，仅在程序内部读取并用于 api.example.com Authorization。参考 https://docs.example.com')
 assert.deepEqual([...hosts],['api.example.com'])
 assert.match(observationAuthDenial('web_fetch',{url:'https://api.example.com/items'},hosts),/认证/)
 assert.equal(observationAuthDenial('web_fetch',{url:'https://docs.example.com'},hosts),undefined)
 assert.equal(observationAuthDenial('bash',{command:'existing authorized command'},hosts),undefined)
 assert.equal(authenticatedObservationHosts('token 文档 https://example.com').size,0)
 assert.match(observationHttpHint('HTTP 403'),/不能仅凭状态码定性/)
 assert.equal(observationHttpHint('HTTP 200'), '')
})
test('progress redacts credentials, query strings and URL userinfo',()=>{
 const s=redactProgress('abcSECRET123 https://user:pass@example.com/path?token=xyz\nAuthorization: Bearer sensitive\nghp_abcdef123456',['abcSECRET123'])
 for(const secret of ['abcSECRET123','user:pass','token=xyz','sensitive','ghp_abcdef123456'])assert.equal(s.includes(secret),false)
 assert.ok(s.includes('https://example.com/path'))
})
test('structured progress preserves evidence after credentials and URL punctuation',()=>{
 const raw={token:'private',content:'Access token: private\n规范内容\n- 回调：`https://example.com/path`\n- 来源：https://example.com/x；下一项',other:'保留'}
 const safe=JSON.parse(redactProgress(JSON.stringify(raw),[]))
 assert.equal(safe.token,'[凭据字段已隐藏]')
 assert.equal(safe.content.includes('private'),false)
 assert.match(safe.content,/规范内容\n- 回调：`https:\/\/example.com\/path`\n- 来源：https:\/\/example.com\/x；下一项/)
 assert.equal(safe.other,'保留')
})
test('progress survives restart, expires, clears and rejects changed configuration',async t=>{
 const root=await mkdtemp(join(tmpdir(),'observation-progress-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const store=new PartnerConcernStore(root)
 const item=await store.createExplicit('c','*','关注对象')
 const p={signature:observationSignature(item),savedAt:Date.now(),steps:[{tool:'read',error:false,text:'已读取一部分，后续尚未核验'}]}
 await store.saveObservationProgress(item,p)
 const restored=(await new PartnerConcernStore(root).list('c'))[0]
 assert.deepEqual(resumeObservation(restored),p)
 assert.equal(resumeObservation({...restored,reason:'changed'}),undefined)
 assert.equal(resumeObservation(restored,p.savedAt+86400001),undefined)
 await store.saveObservationProgress(item,null)
 assert.equal((await store.list('c'))[0].observationProgress,undefined)
 await store.saveObservationProgress({...item,updatedAt:item.updatedAt-1},p)
 assert.equal((await store.list('c'))[0].observationProgress,undefined)
})
