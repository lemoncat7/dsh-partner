import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PartnerStore} from '../lib/store.js'
import {normalizeCharacterCard} from '../lib/character/domain.js'
import {runtimeSnapshot} from '../lib/companions/runtime-policy.js'
import {SessionConfigurationIndex} from '../lib/companions/session-configuration.js'
import {renderPartnerPersona} from '../lib/execution/agent-support.js'
import {renderIdentityRelationship} from '../lib/character/relationship-adapter.js'
import {usesShortDeliveryPolicy} from '../lib/character/conversation-behavior.js'

test('committed capability policy scopes the whole role bundle and preserves saved options across toggles',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'partner-role-policy-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const store=await PartnerStore.open(join(dir,'state.json'))
 await store.update(s=>{const c=s.companions[0];c.capabilities=['skills','mcp'];c.characterCard=normalizeCharacterCard({enabled:false,roleText:'只在开启后生效的语气',length:'short',segmentedReplies:true,shortVoiceReplies:true,stickersEnabled:true});c.relationshipText='只在开启后生效的关系';c.idleContact={enabled:true,routeId:'local',idleMinutes:120};c.sleepPolicy={enabled:true,dreamsEnabled:true};c.automation.memory.rollingContextEnabled=true;s.sessions.push({id:'local',kind:'local',sessionId:'normal',channelId:'@local',userId:'owner',companionId:c.id,lastMessageAt:1})})
 const c=store.snapshot().companions[0],id=c.id,index=new SessionConfigurationIndex(store);t.after(()=>index.close())
 const off=store.runtimePolicy(id)
 assert.equal(store.runtimePolicy(id),off,'reads reuse the committed policy, with no per-message recomputation')
 assert.ok(Object.values(off.rules).every(v=>v===false))
 for(const name of ['partner_background_task','partner_chat_say','partner_chat_reply','partner_sleep','partner_affection','partner_thoughts'])assert.equal(off.allowsTool(name),false,name)
 for(const name of ['bash','generate_image','partner_browser','partner_skill','partner_task_board','partner_mcp','partner_identity','partner_send_attachment'])assert.equal(off.allowsTool(name),true,name)
 const effective=runtimeSnapshot(store).companions[0]
 assert.equal(effective.relationshipText,undefined);assert.equal(effective.characterCard,undefined)
 assert.equal(effective.sleepPolicy.enabled,false);assert.equal(effective.idleContact.enabled,false);assert.equal(effective.automation.memory.rollingContextEnabled,false)
 assert.deepEqual(effective.capabilities,c.capabilities);assert.equal(effective.instructions,c.instructions)
 assert.equal(index.forSession('normal').companion.characterCard,undefined)
 assert.equal(renderIdentityRelationship(c),'');assert.equal(usesShortDeliveryPolicy(c.characterCard),false)
 assert.doesNotMatch(renderPartnerPersona(c),/只在开启后生效|必须先交|任务回应流程|短句接话/)
 assert.equal(store.snapshot().companions[0].characterCard.length,'short','runtime projection does not erase settings')
 effective.instructions='changed detached snapshot';assert.equal(store.snapshot().companions[0].instructions,c.instructions)
 await store.update(s=>{s.companions[0].characterCard.enabled=true})
 const on=store.runtimePolicy(id)
 assert.notEqual(on,off);assert.ok(Object.values(on.rules).every(Boolean))
 assert.ok(on.allowsTool('partner_background_task'));assert.equal(on.companion.characterCard.length,'short');assert.equal(on.companion.relationshipText,c.relationshipText)
 assert.match(renderPartnerPersona(on.companion),/只在开启后生效的语气/)
 assert.match(renderIdentityRelationship(on.companion),/只在开启后生效的关系/)
 await store.update(s=>{s.companions[0].characterCard.enabled=false})
 assert.equal(store.runtimePolicy(id).rules.forceBackground,false)
 assert.equal(index.forSession('normal').companion.relationshipText,undefined)
 assert.equal((await PartnerStore.open(join(dir,'state.json'))).runtimePolicy(id).roleChat,false)
})
