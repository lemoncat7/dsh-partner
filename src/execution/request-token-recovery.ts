import type {SessionEvent} from '@deepseek-ai/dsh-session'
import {isIdleContactNotice} from '../character/idle-contact.js'

/** Repair only the old plugin cap persisted by the host after an autonomous wake. */
export function recoverReplyTokenLimit<T extends {provider?:string;model?:string;maxTokens?:number}>(options:T,events:readonly SessionEvent[]):T {
 if(options.maxTokens!==700&&options.maxTokens!==800)return options
 const headers=events.flatMap((e,i)=>e.type==='request/header'?[{i,header:e.data.header}]:[])
 const latest=headers.at(-1)
 if(!latest||latest.header.config.provider!==options.provider||latest.header.config.model!==options.model||latest.header.config.maxTokens!==options.maxTokens)return options
 let first=headers.length-1
 while(first>=0){const h=headers[first]!.header;if(h.config.provider!==options.provider||h.config.model!==options.model||![700,800].includes(h.config.maxTokens??0)||h.adapterDefaults?.maxTokens===true)break;first--}
 const original=headers[first],capped=headers[first+1]
 if(!original||!capped||original.header.config.provider!==options.provider||original.header.config.model!==options.model)return options
 const preceding=[...events.slice(0,capped.i)].reverse().find(e=>e.type==='user/message'&&(e.data.source.kind==='user'||isIdleContactNotice(e)))
 if(!preceding||!isIdleContactNotice(preceding))return options
 const restored={...options}
 if(original.header.adapterDefaults?.maxTokens===true||original.header.config.maxTokens===undefined)delete restored.maxTokens
 else restored.maxTokens=original.header.config.maxTokens
 return restored
}
