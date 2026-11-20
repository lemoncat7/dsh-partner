import type {Companion} from '../../domain.js'

export function qqRoleText(companion:Companion):string {
 return [companion.role,companion.description,companion.characterCard?.enabled?companion.characterCard.roleText:'']
  .filter(Boolean).join('\n')
}

/** Encode setting clauses separately so later traits and interests can match a short message. */
export function qqPersonaClauses(text:string,limit:number):string[]{
 const clauses=[...new Set(text.split(/[\n。！？；]+/u).map(part=>part.trim().slice(0,160)).filter(Boolean))]
 if(clauses.length<=limit)return clauses
 return Array.from({length:limit},(_,i)=>clauses[Math.floor(i*(clauses.length-1)/(limit-1))]!)
}
