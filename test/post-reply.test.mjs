import test from 'node:test'
import assert from 'node:assert/strict'
import { PartnerAgentRuntime } from '../lib/agent-runtime.js'
import { postReplyProbability, postReplyAllowed, activityPolicyCurrent } from '../lib/character/post-reply.js'
import { qqChatOnly } from '../lib/channels/qq/authority.js'
import { currentQqIdentityRelation } from '../lib/channels/qq/identity-binding.js'
import { IDLE_CONTACT_NOTICE } from '../lib/character/idle-contact.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PartnerStore } from '../lib/store.js'

function fixture() {
  const companion={id:'c',updatedAt:1,characterCard:{enabled:true},affection:{score:100},idleContact:{enabled:true,routeId:'other',idleMinutes:120}}
  const route={id:'r',companionId:'c',kind:'channel',channelId:'ch',userId:'834426963',sessionId:'s',lastMessageAt:Date.now(),qqSessionMode:'separate'}
  const channel={id:'ch',companionId:'c',enabled:true,platform:'qq',qq:{privateReplies:true,identityBinding:{enabled:true,qqIds:['834426963','12345678']}}}
  const state={companions:[companion],sessions:[route],channels:[channel],pairings:[{channelId:'ch',userId:route.userId,status:'approved'}]}
  const events=[{type:'user/message',seq:1,time:Date.now(),data:{id:'u1',source:{kind:'user'}}}]
  const followed=[]
  const agent={status:'idle',session:{id:'s',seq:1,snapshotEvents:()=>events},followup:message=>followed.push(message)}
  const store={snapshot:()=>state,update:async fn=>fn(state),subscribe:()=>()=>{},isCompanionRemoving:()=>false}
  const runtime=new PartnerAgentRuntime({agents:{get:()=>undefined}},store,'/tmp');runtime.ensureAgent=async()=>agent;runtime.isArchived=()=>false
  return {companion,route,channel,state,events,followed,agent,store,runtime,source:{routeId:'r',sessionId:'s',userMessageId:'u1'}}
}
async function hit(f) {
  const random=Math.random;Math.random=()=>0
  try{await f.runtime.replyDelivered(f.source)}finally{Math.random=random}
}
function ready(f){f.route.postReplyOpportunity.dueAt=Date.now()-1}

test('probability increases with affection, capped at 45%; disabling affection opts out',()=>{
  const {companion}=fixture()
  for(const [score,expected] of [[0,.05],[20,.066],[60,.194],[100,.45],[1000,.45]]){companion.affection.score=score;assert.ok(Math.abs(postReplyProbability(companion)-expected)<1e-9)}
  companion.characterCard.affectionEnabled=false;assert.equal(postReplyProbability(companion),0)
})
test('one durable draw after delivered reply; duplicate receipts cannot reroll a miss',async()=>{
  const f=fixture(), random=Math.random;Math.random=()=>.99
  try{await f.runtime.replyDelivered(f.source)}finally{Math.random=random}
  assert.equal(f.route.postReplyOpportunity.status,'missed');await hit(f);assert.equal(f.route.postReplyOpportunity.status,'missed')
  await f.runtime.idleContact('c');assert.equal(f.followed.length,0)
})
test('delayed continuation uses original route instead of configured idle destination, once only',async()=>{
  const f=fixture();await hit(f)
  assert.equal(f.route.postReplyOpportunity.status,'pending');await f.runtime.idleContact('c');assert.equal(f.followed.length,0)
  ready(f);await Promise.all([f.runtime.idleContact('c'),f.runtime.idleContact('c')]);assert.equal(f.followed.length,1)
  assert.equal(f.route.idleContactState.kind,'post-reply');assert.match(f.followed[0].content[0].text,/不要凑第二条消息/)
  assert.equal(f.route.postReplyOpportunity.status,'claimed');await f.runtime.idleContact('c');assert.equal(f.followed.length,1)
  assert.equal(activityPolicyCurrent(f.state,f.companion,f.route),true)
})
for(const scenario of ['new input','sleep','unbound','disabled','affection off','expired','settings changed','session changed','revoked'])test(`pending continuation cancels for ${scenario}`,async()=>{
  const f=fixture();await hit(f);ready(f)
  if(scenario==='new input')f.events.push({type:'user/message',seq:2,time:Date.now(),data:{id:'u2',source:{kind:'user'}}})
  if(scenario==='sleep')f.companion.sleepState={episode:{wakeAt:Date.now()+60000}}
  if(scenario==='unbound')f.channel.qq.identityBinding.qqIds=[]
  if(scenario==='disabled')f.companion.idleContact.enabled=false
  if(scenario==='affection off')f.companion.characterCard.affectionEnabled=false
  if(scenario==='expired')f.route.postReplyOpportunity.expiresAt=Date.now()-1
  if(scenario==='settings changed')f.companion.updatedAt++
  if(scenario==='session changed')f.route.sessionId='new-session'
  if(scenario==='revoked')f.state.pairings[0].status='blocked'
  await f.runtime.idleContact('c');assert.equal(f.followed.length,0)
})
test('busy turn defers within expiry; another message during claim prevents followup',async()=>{
  const f=fixture();await hit(f);ready(f);f.agent.status='running';await f.runtime.idleContact('c');assert.equal(f.followed.length,0)
  f.agent.status='idle';f.store.update=async fn=>{fn(f.state);f.agent.session.seq++}
  await f.runtime.idleContact('c');assert.equal(f.followed.length,0)
})
test('stale delivered reply and foreign routes cannot arm a continuation',async()=>{
  const f=fixture();f.source.userMessageId='older';await hit(f);assert.equal(f.route.postReplyOpportunity,undefined)
  f.source.userMessageId='u1';f.route.companionId='foreign';await hit(f);assert.equal(f.route.postReplyOpportunity,undefined)
})
test('owner-only QQ adapter and per-companion cancellation; multiple owners do not create parallel opportunities',async()=>{
  const f=fixture();f.route.userId='99999999';assert.equal(postReplyAllowed(f.state,f.companion,f.route),false)
  f.route.userId='834426963';await hit(f)
  const other={...f.route,id:'other',userId:'12345678',postReplyOpportunity:undefined};f.state.sessions.push(other)
  f.state.pairings.push({channelId:'ch',userId:'12345678',status:'approved'})
  f.source.routeId='other';await hit(f);assert.equal(f.route.postReplyOpportunity.status,'cancelled');assert.equal(other.postReplyOpportunity.status,'pending')
  f.state.sessions.push({...f.route,id:'foreign',companionId:'different',postReplyOpportunity:{...other.postReplyOpportunity}})
  await f.runtime.cancelPostReply('c');assert.equal(other.postReplyOpportunity.status,'cancelled');assert.equal(f.state.sessions.at(-1).postReplyOpportunity.status,'pending')
})
test('claimed continuation loses private capabilities immediately after owner revocation or new input',async()=>{
  const f=fixture();await hit(f);ready(f);await f.runtime.idleContact('c')
  f.events.push({type:'user/message',seq:2,data:f.followed[0]})
  assert.equal(qqChatOnly(f.agent,f.state),false)
  f.channel.qq.identityBinding.qqIds=[];assert.equal(qqChatOnly(f.agent,f.state),true)
  f.channel.qq.identityBinding.qqIds=['834426963'];await f.runtime.cancelPostReply('c');assert.equal(qqChatOnly(f.agent,f.state),true)
})
test('owner-addressed group continuation retains correct relation; idle group work stays unbound',()=>{
  const f=fixture();f.route.userId='group:493531768:834426963'
  f.route.idleContactState={kind:'post-reply',messageId:'notice'}
  const events=[{type:'user/message',data:{id:'notice',source:{kind:'plugin:@lemoncat7/dsh-partner',form:'notice',summary:IDLE_CONTACT_NOTICE}}}]
  assert.equal(currentQqIdentityRelation('s',events,[f.route],[f.channel]).matched,true)
  delete f.route.idleContactState.kind
  assert.equal(currentQqIdentityRelation('s',events,[f.route],[f.channel]).matched,false)
})
test('opportunity and consumed state survive store reopen',async t=>{
  const root=await mkdtemp(join(tmpdir(),'post-reply-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const store=await PartnerStore.open(join(root,'state.json'));const f=fixture();await hit(f)
  await store.update(s=>{s.sessions=[f.route]})
  const reopened=await PartnerStore.open(join(root,'state.json'));assert.deepEqual(reopened.snapshot().sessions[0].postReplyOpportunity,f.route.postReplyOpportunity)
})
test('a newer input on another session prevents an old channel delivery from arming',async()=>{
  const f=fixture();f.state.sessions.push({...f.route,id:'r2',sessionId:'s2'})
  await f.runtime.observeSessionEvent({id:'s2'},{type:'user/message',data:{id:'newer',source:{kind:'user'}}})
  await hit(f);assert.equal(f.route.postReplyOpportunity,undefined)
})
test('browser input cancels claimed work from another session immediately',async()=>{
  const f=fixture();await hit(f);ready(f);await f.runtime.idleContact('c')
  f.state.sessions.push({...f.route,id:'local',kind:'local',sessionId:'local-s'})
  await f.runtime.observeSessionEvent({id:'local-s'},{type:'user/message',data:{id:'browser',source:{kind:'user'}}})
  assert.equal(f.route.postReplyOpportunity.status,'cancelled')
})
