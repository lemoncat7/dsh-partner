import test from 'node:test'
import assert from 'node:assert/strict'
import {waitForSegment} from '../lib/channels/segment-delay.js'
import {normalizeCharacterCard,emptyCharacterCard} from '../lib/character/domain.js'
import {ChannelManager} from '../lib/channels/manager.js'
import {ReplySupersededError} from '../lib/channels/reply-turn.js'
const configured=(min=1,max=3)=>({...emptyCharacterCard(),segmentedReplies:true,segmentDelay:{enabled:true,minSeconds:min,maxSeconds:max}})
const simulation=(card=configured(),random=.5)=>{
 let now=0,draws=0,waits=[],checks=0
 const abort=new AbortController(),options={card:()=>card,validate:()=>{checks++},signal:abort.signal}
 const clock={now:()=>now,random:()=>{draws++;return random},sleep:async ms=>{waits.push(ms);now+=ms}}
 return {options,clock,abort,result:()=>({now,draws,waits,checks})}
}
test('legacy configuration stays disabled and valid ranges round-trip without prompt injection',()=>{
 assert.equal(normalizeCharacterCard(emptyCharacterCard()).segmentDelay,undefined)
 for(const [min,max] of [[0,0],[0,60],[1.2,2.4],[60,60]])assert.deepEqual(normalizeCharacterCard(configured(min,max)).segmentDelay,configured(min,max).segmentDelay)
 for(const [min,max] of [[3,1],[-1,1],[1,61],[NaN,1],[0,Infinity],['1',3],[1,null]])assert.throws(()=>normalizeCharacterCard(configured(min,max)),/随机间隔/)
 assert.throws(()=>normalizeCharacterCard({...configured(),segmentDelay:{enabled:'yes',minSeconds:1,maxSeconds:3}}),/开关/)
})
test('bounded random range, fixed range and disabled mode',async()=>{
 for(const [card,random,expected] of [[configured(),0,1000],[configured(),1,3000],[configured(),.5,2000],[configured(.3,.3),.8,300],[configured(0,0),.5,0],[emptyCharacterCard(),.5,0],[{...configured(),segmentedReplies:false},.5,0]]){
  const s=simulation(card,random);await waitForSegment(s.options,s.clock);assert.equal(s.result().now,expected);assert.ok(s.result().waits.every(ms=>ms<=200))
 }
})
test('each following part draws independently; edits do not restart or reroll the wait',async()=>{
 const card=configured(),s=simulation(card);await waitForSegment(s.options,s.clock);await waitForSegment(s.options,s.clock)
 assert.equal(s.result().draws,2);assert.equal(s.result().now,4000)
 const next=simulation(card),sleep=next.clock.sleep;next.clock.sleep=async ms=>{await sleep(ms);card.segmentDelay.enabled=false}
 await waitForSegment(next.options,next.clock);assert.equal(next.result().now,200)
 card.segmentDelay.enabled=true
 const edited=simulation(card),advance=edited.clock.sleep;edited.clock.sleep=async ms=>{await advance(ms);card.segmentDelay.minSeconds=.2;card.segmentDelay.maxSeconds=.2}
 await waitForSegment(edited.options,edited.clock);assert.equal(edited.result().now,200);assert.equal(edited.result().draws,1)
})
test('supersession, permission removal and shutdown stop the wait before the next send',async()=>{
 for(const error of [new ReplySupersededError(),Error('revoked')]){
  const s=simulation(),sleep=s.clock.sleep;s.clock.sleep=async ms=>{await sleep(ms);s.options.validate=()=>{throw error}}
  await assert.rejects(waitForSegment(s.options,s.clock),e=>e===error);assert.equal(s.result().now,200)
 }
 const s=simulation(),sleep=s.clock.sleep;s.clock.sleep=async ms=>{await sleep(ms);s.abort.abort()}
 await assert.rejects(waitForSegment(s.options,s.clock),{name:'AbortError'})
})
function fixture(card=configured(.08,.08)){
 const channel={id:'q',platform:'qq',accountId:'12345678',companionId:'c',enabled:true,direct:{baseUrl:'ws://local'},qq:{groupReplies:true,groupIds:['99887766'],autonomousGroupIds:['99887766']}}
 const state={channels:[channel],companions:[{id:'c',characterCard:{...card,enabled:true}}],pairings:[],sessions:[]},sent=[]
 const store={snapshot:()=>structuredClone(state),subscribe:()=>()=>{},isCompanionRemoving:()=>false}
 const manager=new ChannelManager({logger:{info(){},warn(){}}},store,{read:async()=>({})},{},'/tmp')
 manager.sender=()=>({sendText:async(user,text)=>sent.push({user,text,at:performance.now()}),sendAttachment:async(user,a)=>sent.push({user,text:a.name,at:performance.now()})})
 return {manager,state,sent,send:async(reply,part=async(i,fn)=>fn(),validate,user='group:99887766:22345678')=>manager.sendNotificationTarget('q',user,reply,part,validate)}
}
const reply={text:'',attachments:[],chatParts:[{type:'text',text:'first'},{type:'text',text:'second'},{type:'text',text:'third'}]}
test('real manager delivery sends first immediately, paces later parts and skips acknowledged parts',async()=>{
 const f=fixture();let began=false
 const running=f.send(reply,async(i,fn)=>{if(i===0){await fn();began=true}else await fn()})
 await new Promise(r=>setImmediate(r));assert.equal(began,true);assert.deepEqual(f.sent.map(s=>s.text),['first'])
 await running;assert.equal(f.sent.length,3);assert.ok(f.sent[1].at-f.sent[0].at>=70);assert.ok(f.sent[2].at-f.sent[1].at>=70)
 f.sent.length=0;await f.send(reply,async(i,fn)=>{if(i!==0&&i!==1)await fn()});assert.deepEqual(f.sent.map(s=>s.text),['third'])
})
test('a waiting QQ group does not block another group and live permission revocation fences delivery',async()=>{
 const f=fixture(configured(5,5));let allowed=true
 f.state.channels[0].qq.groupIds.push('88776655')
 f.state.channels[0].qq.autonomousGroupIds.push('88776655')
 const slow=f.send(reply,undefined,()=>{if(!allowed)throw new ReplySupersededError()});const rejected=assert.rejects(slow,ReplySupersededError)
 await new Promise(r=>setImmediate(r));await f.send({...reply,chatParts:[{type:'text',text:'other'}]},undefined,undefined,'group:88776655:33445566')
 assert.deepEqual(f.sent.map(s=>s.text),['first','other']);allowed=false;await rejected
 const g=fixture();const revoked=g.send(reply);const check=assert.rejects(revoked,/停用/);await new Promise(r=>setImmediate(r));g.state.channels[0].enabled=false;await check;assert.equal(g.sent.length,1)
})
test('plain task attachments are not paced; segmented audio follows the same queue',async()=>{
 const f=fixture(configured(60,60));await f.send({text:'done',attachments:[{name:'report',kind:'file',path:'/a'}]});assert.equal(f.sent.length,2)
 const g=fixture();await g.send({...reply,chatParts:[reply.chatParts[0],{type:'audio',attachment:{name:'voice',kind:'audio',path:'/v'}}]});assert.equal(g.sent.length,2);assert.ok(g.sent[1].at-g.sent[0].at>=70)
})
