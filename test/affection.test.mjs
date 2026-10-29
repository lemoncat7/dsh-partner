import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createDefaultCompanion} from '../lib/domain.js'
import {PartnerStore} from '../lib/store.js'
import {emptyCharacterCard,normalizeCharacterCard} from '../lib/character/domain.js'
import {affectionProgress,affectionEnabled,awardAffection,renderAffection,AFFECTION_INTERVAL} from '../lib/character/affection.js'
import {affectionAudienceAllowed} from '../lib/character/affection-adapter.js'
import {affectionTurnEligible,currentAffectionAudience} from '../lib/character/affection-context.js'
import {idleActivityProbability,IDLE_CONTACT_NOTICE} from '../lib/character/idle-contact.js'
import {applyIdentity} from '../lib/companions/identity.js'
const now=Date.parse('2026-10-29T16:00:00Z')
const user=id=>({type:'user/message',data:{id,content:[{type:'text',text:'我是哥哥'}],source:{kind:'user'}}})
function fixture(){
 const c={...createDefaultCompanion(),id:'c',characterCard:{...emptyCharacterCard(),enabled:true,roleText:'坦率的伙伴'}}
 const other={...structuredClone(c),id:'other'}
 const channels=[{id:'qq',companionId:'c',platform:'qq',enabled:true,qq:{identityBinding:{enabled:true,qqIds:['12345678','22345678']}}}]
 const local={id:'local',kind:'local',sessionId:'s',channelId:'local',userId:'owner',companionId:'c',lastMessageAt:now-60_000}
 const owner={...local,id:'owner',kind:'channel',channelId:'qq',userId:'12345678',inboundMessageIds:['a']}
 const owner2={...owner,id:'owner2',userId:'group:99887766:22345678',inboundMessageIds:['b']}
 const guest={...owner,id:'guest',userId:'group:99887766:33445678',inboundMessageIds:['g']}
 const state={companions:[c,other],channels,sessions:[local,owner,owner2,guest],pairings:[{channelId:'qq',userId:owner.userId,status:'approved'}]}
 return {c,other,state,local,owner,owner2,guest}
}
test('default channels participate; QQ owners share eligibility, guests and group-wide autonomy do not',()=>{
 const f=fixture(),channel=f.state.channels[0]
 assert.equal(affectionAudienceAllowed({route:f.local}),true)
 assert.equal(affectionAudienceAllowed({route:f.owner,channel:{...channel,platform:'matrix'}}),true)
 for(const route of [f.owner,f.owner2])assert.equal(affectionAudienceAllowed({route,channel}),true)
 assert.equal(affectionAudienceAllowed({route:f.guest,channel}),false)
 assert.equal(affectionAudienceAllowed({route:f.owner2,channel,autonomous:true}),false)
 channel.qq.identityBinding.enabled=false
 assert.equal(affectionAudienceAllowed({route:f.owner,channel}),false)
})
test('verified input provenance survives shared sessions, unknown QQ-only input and mixed guest turns fail closed',()=>{
 const f=fixture()
 for(const id of ['a','b','browser'])assert.equal(affectionTurnEligible(f.state,'c','s',[user(id)]),true)
 assert.equal(affectionTurnEligible(f.state,'other','s',[user('a')]),false)
 assert.equal(affectionTurnEligible(f.state,'c','s',[user('g'),user('a')]),false)
 assert.equal(currentAffectionAudience(f.state,'c','s',[user('a'),user('g')]),false)
 f.state.sessions=f.state.sessions.filter(r=>r.kind!=='local')
 assert.equal(affectionTurnEligible(f.state,'c','s',[user('unknown')]),false)
 const notice={type:'user/message',data:{id:'idle',source:{kind:'plugin:@lemoncat7/dsh-partner',form:'notice',summary:IDLE_CONTACT_NOTICE}}}
 f.owner.idleContactState={messageId:'idle'}
 assert.equal(currentAffectionAudience(f.state,'c','s',[notice]),true)
 assert.equal(affectionTurnEligible(f.state,'c','s',[notice]),false)
 delete f.owner.idleContactState;f.owner2.idleContactState={messageId:'idle'}
 assert.equal(currentAffectionAudience(f.state,'c','s',[notice]),false)
})
test('each companion owns one progression; two bound accounts contribute to the same value without increasing each other’s companions',()=>{
 const f=fixture(),originalAt=f.c.updatedAt
 assert.equal(affectionEnabled(f.c),true)
 for(const [i,id] of ['a','b'].entries())if(affectionTurnEligible(f.state,'c','s',[user(id)]))awardAffection(f.c,id,now+i*AFFECTION_INTERVAL)
 assert.equal(f.c.affection.score,22)
 assert.equal(affectionProgress(f.other.affection).score,20)
 assert.equal(f.c.updatedAt,originalAt)
 assert.equal(awardAffection(f.c,'b',now+2*AFFECTION_INTERVAL),false)
 assert.equal(awardAffection(f.c,'retry',now+AFFECTION_INTERVAL+1),false)
 assert.equal(awardAffection(f.c,'old',now-1),false)
 f.c.characterCard.affectionEnabled=false
 assert.equal(awardAffection(f.c,'paused',now+4*AFFECTION_INTERVAL),false)
 assert.equal(renderAffection(f.c,true),'')
 assert.throws(()=>normalizeCharacterCard({...f.c.characterCard,affectionEnabled:'yes'}))
})
test('level boundaries, saturation, pause and higher autonomous probability apply only to eligible audience',()=>{
 const f=fixture()
 for(const [score,level] of [[0,1],[19,1],[20,2],[39,2],[40,3],[60,4],[80,5],[100,5]])assert.equal(affectionProgress({score}).level,level)
 f.c.affection={score:99,updatedAt:1,lastAwardAt:1,lastTurnId:'old'}
 assert.equal(awardAffection(f.c,'full',now),true);assert.equal(f.c.affection.score,100)
 assert.equal(awardAffection(f.c,'more',now+AFFECTION_INTERVAL),false)
 f.c.idleContact={enabled:true,routeId:'owner',idleMinutes:30}
 const last={id:'u',at:now-60_000}
 assert.equal(idleActivityProbability(f.state,f.c,last,now),2/30)
 f.c.characterCard.affectionEnabled=false
 assert.equal(idleActivityProbability(f.state,f.c,last,now),1/30)
 f.c.characterCard.affectionEnabled=true
 f.state.channels[0].qq.identityBinding.enabled=false
 assert.equal(idleActivityProbability(f.state,f.c,last,now),1/30)
 assert.equal(renderAffection(f.c,false),'')
 assert.equal(idleActivityProbability(f.state,f.c,last,now+3600_000),1)
})
test('progress survives persistence and identity editing without becoming an editable identity field',async t=>{
 const root=await mkdtemp(join(tmpdir(),'partner-affection-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const store=await PartnerStore.open(join(root,'state.json')),f=fixture()
 awardAffection(f.c,'a',now)
 await store.update(s=>{s.companions=[f.c]})
 const reopened=await PartnerStore.open(join(root,'state.json'));const c=reopened.snapshot().companions[0]
 assert.equal(c.affection.score,21)
 const before=structuredClone(c.affection)
 applyIdentity({companions:[c]},c,{name:'新名字'},c.updatedAt,'ai')
 assert.deepEqual(c.affection,before)
 assert.throws(()=>applyIdentity({companions:[c]},c,{affection:{score:100}},c.updatedAt,'ai'))
})
test('runtime awards only completed real conversations even with memory disabled; replay, failure and autonomous work do not gain',async()=>{
 const {PartnerAgentRuntime}=await import('../lib/agent-runtime.js')
 const f=fixture();f.c.automation.memory.enabled=false
 const runtime=Object.create(PartnerAgentRuntime.prototype)
 Object.assign(runtime,{store:{snapshot:()=>f.state,update:async fn=>fn(f.state)}})
 const start={type:'turn/start',seq:1,time:now-100,data:{turn:1}}
 const input={...user('a'),seq:2,time:now-90}
 const answer={type:'assistant/message',seq:3,time:now-10,data:{message:{content:[{type:'text',text:'好啊，一起聊聊。'}]}}}
 const end={type:'turn/end',seq:4,time:now,data:{turn:1,reason:{kind:'completed'}}}
 const session={id:'s',snapshotEvents:()=>[start,input,answer,end]}
 await runtime.processSessionEvent(session,{...end,data:{turn:1,reason:{kind:'failed'}}})
 assert.equal(f.c.affection,undefined)
 await runtime.processSessionEvent(session,end);assert.equal(f.c.affection.score,21)
 await runtime.processSessionEvent(session,end);assert.equal(f.c.affection.score,21)
 input.data.source={kind:'plugin:@lemoncat7/dsh-partner',form:'notice',summary:IDLE_CONTACT_NOTICE}
 end.time+=AFFECTION_INTERVAL;end.seq=5
 await runtime.processSessionEvent(session,end);assert.equal(f.c.affection.score,21)
})
