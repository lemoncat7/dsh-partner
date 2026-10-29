import test from 'node:test'
import assert from 'node:assert/strict'
import {createDefaultCompanion} from '../lib/domain.js'
import {normalizeCharacterCard,renderCharacterCore} from '../lib/character/domain.js'
import {renderIdentityRelationship,relationshipTextForIdentity} from '../lib/character/relationship-adapter.js'
import {renderPartnerPersona} from '../lib/execution/agent-support.js'
import {previewCharacter} from '../lib/character/preview.js'

test('default combines independent documents; QQ adds relationship only for verified owner',()=>{
 const c={...createDefaultCompanion(),relationshipText:'EXCLUSIVE_RELATION',characterCard:normalizeCharacterCard({enabled:true,roleText:'ROLE_ONLY'})}
 assert.match(renderPartnerPersona(c),/ROLE_ONLY[\s\S]*EXCLUSIVE_RELATION/)
 assert.doesNotMatch(renderPartnerPersona(c,'conversation',false),/EXCLUSIVE_RELATION/)
 assert.match(renderIdentityRelationship(c,{channel:'qq',matched:true}),/EXCLUSIVE_RELATION/)
 assert.equal(renderIdentityRelationship(c,{channel:'qq',matched:false}),'')
 assert.deepEqual(c.capabilities,createDefaultCompanion().capabilities)
})

test('legacy explicit relationship stays separate; explicit empty clears it without editing original',()=>{
 const c={characterCard:normalizeCharacterCard({enabled:true,identity:'ROLE_ONLY',relationship:'LEGACY_RELATION'})}
 assert.match(renderCharacterCore(c.characterCard),/ROLE_ONLY/);assert.doesNotMatch(renderCharacterCore(c.characterCard),/LEGACY_RELATION/)
 assert.equal(relationshipTextForIdentity(c),'LEGACY_RELATION')
 assert.equal(renderIdentityRelationship({...c,relationshipText:''}),'')
 assert.equal(c.characterCard.relationship,'LEGACY_RELATION')
})

test('isolated preview uses the same adapter and draft relationship without sending or saving',async()=>{
 const c={...createDefaultCompanion(),relationshipText:'SAVED_RELATION'},card=normalizeCharacterCard({enabled:true,roleText:'ROLE_ONLY'})
 const prompts=[];const ctx={get:()=>({currentSelection:()=>({provider:'test',model:'test'})}),llm:{async *stream(input){prompts.push(input.system);assert.equal(input.tools,undefined);yield {type:'text-delta',text:'回复'};yield {type:'finish',reason:{kind:'stop'}}}}}
 for(const audience of ['default','qq-owner','qq-guest'])await previewCharacter(ctx,c,{card,message:'你好',relationshipText:'DRAFT_RELATION',audience})
 assert.match(prompts[0],/DRAFT_RELATION/);assert.match(prompts[1],/DRAFT_RELATION/);assert.doesNotMatch(prompts[2],/DRAFT_RELATION|SAVED_RELATION/)
 assert.equal(c.relationshipText,'SAVED_RELATION')
})
