import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Session} from '@deepseek-ai/dsh-session'
import {createUserMessage, createSystemMessage} from '@deepseek-ai/dsh-llm'
import {emptyCharacterCard, normalizeCharacterCard, renderCharacterCore, activatedLore} from '../lib/character/domain.js'
import {renderPartnerPersona} from '../lib/execution/agent-support.js'
import {createDefaultCompanion, normalizeAutomation} from '../lib/domain.js'
import {PartnerMemoryStore} from '../lib/memory-store.js'
import {renewContext} from '../lib/context-renewal.js'
import {DailyReviewScheduler} from '../lib/daily-review.js'

const card = () => ({...emptyCharacterCard(), enabled:true, identity:'记录者', motivation:'好奇而坦率',voice:'短句，不敷衍',examples:[{user:'今天累了',assistant:'先歇一会儿，想说说发生了什么吗？'},{user:'这个想法对吗',assistant:'有可行的部分，也有个问题需要先确认。'}]})
const result = {daily:{summary:'已整理',events:['明确的事件'],openTasks:[],completedTasks:[],learnings:[]}, memories:[],concerns:[],relations:[]}
async function fixture(t) {const dir=await mkdtemp(join(tmpdir(),'character-renewal-'));t.after(()=>rm(dir,{recursive:true,force:true}));return new PartnerMemoryStore(dir)}
async function complete(store, turn, extra={}) {await store.enqueue(turn);const job=await store.claimJob('c',Date.now()+1000);assert.equal(job.turn.id,turn.id);await store.consolidate(turn,{...result,...extra},job);await store.settleJob(job)}
const turn = (id,at=Date.now(),scopeId='local') => ({id,at,scopeId,companionId:'c',sessionId:'s',userMessageIds:[id],user:`消息 ${id}`,assistant:'已收到'})
test('disabled cards preserve legacy identity; enabled cards require concrete guidance and range',()=>{
 const companion=createDefaultCompanion()
 const original=renderPartnerPersona(companion)
 assert.equal(renderPartnerPersona({...companion,characterCard:emptyCharacterCard()}),original)
 assert.throws(()=>normalizeCharacterCard({...card(),examples:[]}),/两组/)
 assert.match(renderPartnerPersona({...companion,characterCard:card()}),/必须持续依据/)
 assert.doesNotMatch(renderCharacterCore(card(),'heartbeat'),/访客：/)
 assert.match(renderCharacterCore(card(),'heartbeat'),/JSON/)
 assert.equal(normalizeAutomation(companion.automation).memory.contextRenewalEnabled,true)
 assert.equal(normalizeAutomation(companion.automation).memory.contextRenewalHour,4)
})
test('lore activation is scoped, deterministic and bounded',()=>{
 const c=card();c.lore=Array.from({length:12},(_,i)=>({id:String(i),title:'管理标签',keywords:['雨夜'],content:'资料'.repeat(500),enabled:i!==0}))
 assert.equal(activatedLore(c,'晴天').length,0)
 assert.equal(activatedLore(c,'雨夜').length,5)
 assert.equal(activatedLore(c,'雨夜')[0].id,'1')
})
test('history finds old Chinese and assistant details beyond the last 100 turns, with scope isolation',async t=>{
 const store=await fixture(t)
 await store.enqueue({...turn('old',1),user:'项目的代号是青岚星港',assistant:'约好的具体颜色是琥珀橙，编号 XK928'})
 for(let i=0;i<105;i++)await store.enqueue(turn('later-'+i,i+2))
 await store.enqueue({...turn('private',200,'other'),user:'青岚星港隐私'})
 const old=await store.searchHistory('c','local','青岚星港')
 assert.equal(old[0].id,'old');assert.ok(old.every(x=>x.id!=='private'))
 assert.equal((await store.searchHistory('c','local','XK928'))[0].id,'old')
 assert.ok((await store.searchHistory('c','local','琥珀橙'))[0].assistant.includes('琥珀橙'))
})
test('renewal waits for extraction and final review, but disabled memory needs neither',async t=>{
 const store=await fixture(t), source=turn('one')
 assert.equal(await store.renewalReady('c','local','s','2099-01-01',false),true)
 assert.deepEqual(await store.unarchivedContext('c','local',[{id:'one',text:source.user}]),['one'])
 await store.enqueue(source)
 assert.deepEqual(await store.unarchivedContext('c','local',[{id:'one',text:source.user}]),[])
 assert.equal(await store.renewalReady('c','local','s','2099-01-01'),false)
 const job=await store.claimJob('c');await store.consolidate(source,result,job);await store.settleJob(job)
 assert.equal(await store.renewalReady('c','local','s','2099-01-01'),false)
 const [target]=await store.pendingDailyReviews('c','2099-01-01');await store.completeDailyReview(target,result)
 assert.equal(await store.renewalReady('c','local','s','2099-01-01'),true)
 assert.equal(await store.coversContext('c','local',[{id:'one',text:source.user}]),true)
 assert.equal(await store.coversContext('c','local',[{id:'new',text:source.user}]),false,'identical new text must not reuse old coverage')
 await complete(store,turn('two',Date.now()+10))
 assert.equal(await store.renewalReady('c','local','s','2099-01-01'),false,'new turn invalidates same-day review')
 await store.markRenewed('c','s','2099-01-01',4)
 assert.equal(await store.renewalReady('c','local','s','2099-01-01',false),false)
})
test('character memories are separate, pins protected, stale manual saves rejected',async t=>{
 const store=await fixture(t)
 const manual=await store.saveCharacterState('c','local',{scene:'小屋',relationship:'熟人',facts:[],events:[],pins:['约定']},0)
 await assert.rejects(()=>store.saveCharacterState('c','local',manual,0),/已更新/)
 await complete(store,turn('one',manual.updatedAt+10),{characterState:{scene:'窗边',relationship:'熟人',facts:['角色喜欢雨夜'],events:['谈起音乐'],pins:['不能覆盖'],updatedAt:0}})
 const state=await store.characterState('c','local')
 assert.equal(state.scene,'窗边');assert.deepEqual(state.pins,['约定'])
 assert.equal((await store.profileSnapshot('c','local')).entries.length,0)
 assert.equal((await store.characterState('c','other')).scene,'')
})
function sessionFixture() {
 const session=Session.create('session-test')
 session.append('system/message',{turn:0,step:0,message:createSystemMessage('protected persona')},{surfaceOp:'append'})
 for(const text of ['旧问题一','旧问题二'])session.append('user/message',createUserMessage({content:[{type:'text',text}],source:{kind:'user'}}),{surfaceOp:'append'})
 return {session,agent:{session,runMaintenance:task=>task(new AbortController().signal)}}
}
test('native renewal preserves protected system head and raw log; survives replay and is idempotent',async()=>{
 const {session,agent}=sessionFixture();let flushes=0
 assert.equal(await renewContext(agent,'2026-10-29','已保存摘要',async()=>true,async()=>{flushes++}),2)
 assert.equal(session.deriveMessages()[0].content[0].text,'protected persona')
 assert.equal(session.deriveMessages().length,2)
 assert.equal(session.snapshotEvents().length,4)
 const restored=Session.create('restored',session.snapshotEvents())
 assert.equal(restored.deriveMessages().length,2)
 assert.equal(await renewContext(agent,'2026-10-29','重复',async()=>true,async()=>{flushes++}),0)
 assert.equal(session.snapshotEvents().length,4);assert.equal(flushes,2)
})
test('failed readiness and concurrent injection leave old context intact',async()=>{
 const {session,agent}=sessionFixture()
 assert.equal(await renewContext(agent,'day','',async()=>false,async()=>{}),0)
 assert.equal(session.deriveMessages().length,3)
 await assert.rejects(()=>renewContext(agent,'day','',async()=>{session.append('user/message',createUserMessage({content:[{type:'text',text:'new'}],source:{kind:'user'}}),{surfaceOp:'append'});return true},async()=>{}),/上下文发生变化/)
 assert.equal(session.deriveMessages().length,4)
})
test('memory-off checkpoint does not claim archived long-term facts',async()=>{
 const {session,agent}=sessionFixture()
 await renewContext(agent,'day','',async()=>true,async()=>{},false)
 assert.match(session.deriveMessages()[1].content[0].text,/未提炼长期记忆/)
})
test('renewal is independent of daily-review switch and failures never clear',async()=>{
 const c={...createDefaultCompanion(),id:'c'};c.automation.memory.enabled=true;c.automation.memory.dailyReviewEnabled=false
 const state={companions:[c]};let reviewed=0,cleared=0,fail=false
 const scheduler=new DailyReviewScheduler({logger:{warn(){},error(){}}},{snapshot:()=>state,isCompanionRemoving:()=>false},{pendingDailyReviews:async()=>[{scopeId:'local',date:'2026-10-28'}],failDailyReview:async()=>{}},{reviewDay:async()=>{if(fail)throw Error('model unavailable');reviewed++;return []}},{isCompanionBusy:()=>false,prepareRenewalMemory:async()=>{},renewReviewedContexts:async()=>{cleared++;return 1}})
 await scheduler.trigger('c',false,true);assert.equal(reviewed,1);assert.equal(cleared,1)
 fail=true;await scheduler.trigger('c',false,true);assert.equal(cleared,1)
 c.automation.memory.enabled=false;await scheduler.trigger('c',false,true);assert.equal(cleared,2);assert.equal(reviewed,1)
 await scheduler.close()
})

test('renewal backfills visible legacy turns once before allowing memory cleanup',async t=>{
 const {PartnerAgentRuntime}=await import('../lib/agent-runtime.js')
 const memory=await fixture(t), {session,agent}=sessionFixture()
 const companion={...createDefaultCompanion(),id:'c'};companion.automation.memory.enabled=true
 const route={id:'r',companionId:'c',channelId:'local:c',userId:'local',sessionId:session.id,kind:'local',lastMessageAt:0}
 const runtime=Object.create(PartnerAgentRuntime.prototype)
 Object.assign(runtime,{memory,store:{snapshot:()=>({sessions:[route]})},configurations:{companion:()=>companion},isCompanionBusy:()=>false,isArchived:()=>false,ensureAgent:async()=>agent})
 await runtime.prepareRenewalMemory('c');await runtime.prepareRenewalMemory('c')
 const {conversationMemoryScope}=await import('../lib/memory-scope.js');const scope=conversationMemoryScope(route,[route])
 const history=await memory.history('c',scope)
 assert.equal(history.length,2)
 assert.equal(new Set(history.flatMap(t=>t.userMessageIds)).size,2)
 assert.equal(await memory.renewalReady('c',scope,session.id,'2099-01-01'),false)
})

test('renewal also handles a single visible user message and retries a failed flush safely',async()=>{
 const session=Session.create('single')
 session.append('system/message',{turn:0,step:0,message:createSystemMessage('head')},{surfaceOp:'append'})
 session.append('user/message',createUserMessage({content:[{type:'text',text:'one'}],source:{kind:'user'}}),{surfaceOp:'append'})
 const agent={session,runMaintenance:task=>task(new AbortController().signal)}
 await assert.rejects(()=>renewContext(agent,'day','',async()=>true,async()=>{throw Error('disk temporarily unavailable')},false),/disk/)
 assert.equal(session.snapshotEvents().length,3)
 await renewContext(agent,'day','',async()=>true,async()=>{},false)
 assert.equal(session.snapshotEvents().length,3)
 assert.equal(Session.create('replay',session.snapshotEvents()).deriveMessages()[0].content[0].text,'head')
})
