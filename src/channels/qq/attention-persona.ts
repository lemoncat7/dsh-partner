import {createHash} from 'node:crypto'
import type {Companion} from '../../domain.js'

export function qqRoleText(companion:Companion):string {
 const card=companion.characterCard
 const role=card?.enabled?(card.roleText??[card.identity,card.motivation,card.voice].filter(Boolean).join('\n')):''
 return [companion.role,companion.description,role].filter(Boolean).join('\n')
}

/** Encode setting clauses separately so later traits and interests can match a short message. */
export function qqPersonaClauses(text:string,limit:number):string[]{
 const clauses=[...new Set(text.split(/[\n。！？；]+/u).map(part=>part.trim().slice(0,160)).filter(Boolean))]
 if(clauses.length<=limit)return clauses
 return Array.from({length:limit},(_,i)=>clauses[Math.floor(i*(clauses.length-1)/(limit-1))]!)
}

export function settingsRevision(text:string):string {
 return createHash('sha256').update(text.normalize('NFKC')).digest('hex')
}

export function roleSettingsForAttention(companion:Companion):string {
 return [companion.name,qqRoleText(companion)].filter(Boolean).join('\n')
}
export function defaultAttentionScope(channelId:string,accountId:string,companionId:string):string {
 return 'default:'+JSON.stringify([channelId,accountId,companionId])
}

/** Standalone names and leading names followed by an explicit call or request. */
export function explicitAttentionCall(text:string,aliases:readonly string[]):boolean {
 const input=text.normalize('NFKC').trim().replace(/^@\s*/u,'')
 return aliases.some(alias=>{
  if(!alias||!input.startsWith(alias))return false
  const tail=input.slice(alias.length).trim()
  if(/^[!?.。~…]*$/u.test(tail))return true
  return /^(?:你(?!们)|在吗|在不在|人呢|你好|出来|来一下|帮我|帮忙|能不能|可不可以|可以帮|麻烦|请帮)/u
   .test(tail.replace(/^[,、:]+\s*/u,''))
 })
}
