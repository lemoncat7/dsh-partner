import type {PartnerState} from '../domain.js'
import {channelTts,ttsProfile} from './domain.js'
export function validateTtsState(state:Partial<PartnerState>):void{
 for(const c of state.companions??[]){
  if(c.ttsProfiles===undefined)continue
  if(!Array.isArray(c.ttsProfiles)||c.ttsProfiles.length>20)throw Error('invalid TTS profiles')
  const ids=new Set<string>()
  for(const p of c.ttsProfiles){if(!p||typeof p.id!=='string'||! /^[a-zA-Z0-9_-]{1,100}$/.test(p.id)||ids.has(p.id)||!Number.isFinite(p.updatedAt)||p.credentialId!==undefined&&!/^[a-zA-Z0-9_-]{1,100}$/.test(p.credentialId))throw Error('invalid TTS profile identity');ids.add(p.id);ttsProfile(p as unknown as Record<string,unknown>,p.id,p.updatedAt,p.credentialId)}
 }
 for(const c of state.channels??[]){
  if(c.tts)channelTts(c.tts as unknown as Record<string,unknown>)
  if(c.ttsReceipts===undefined)continue
  if(!Array.isArray(c.ttsReceipts)||c.ttsReceipts.length>500)throw Error('invalid TTS receipts')
  const ids=new Set<string>()
  for(const r of c.ttsReceipts){if(!r||! /^[a-f0-9]{64}$/.test(r.id)||ids.has(r.id)||!['generating','generated','sending','confirmed','failed','unknown'].includes(r.status)||!Number.isFinite(r.at)||typeof r.profileId!=='string'||typeof r.inputId!=='string'||typeof r.routeId!=='string'||typeof r.spokenText!=='string'||r.spokenText.length>2000||r.audioId!==undefined&&!/^[a-f0-9]{64}\.(wav|mp3)$/.test(r.audioId))throw Error('invalid TTS receipt');ids.add(r.id)}
 }
}
