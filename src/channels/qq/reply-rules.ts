import { createHash } from 'node:crypto'
import type { DirectMessage } from '../direct/transport.js'

export interface ReplyScore { reply:boolean; score:number; probability:number; reasons:string[] }
export interface ReplyScoreContext { name:string; owner:boolean; affection:number; recent?:{at:number;text:string}; now:number; seed:string }
const normalized=(text:string)=>text.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu,'').slice(0,160)
/** Character bigram Dice similarity works without a Chinese tokenizer or model. */
export function topicSimilarity(left:string,right:string):number {
 const grams=(text:string)=>{const chars=Array.from(normalized(text)),out=new Set<string>();for(let i=1;i<chars.length;i++)out.add(chars[i-1]!+chars[i]!);return out}
 const a=grams(left),b=grams(right);if(!a.size||!b.size)return 0
 let common=0;for(const gram of a)if(b.has(gram))common++
 return 2*common/(a.size+b.size)
}
/** One edit for longer names only: two-character Chinese names are too ambiguous. */
function nearName(text:string,name:string):boolean {
 const a=Array.from(normalized(text)),b=Array.from(normalized(name))
 if(b.length<4||b.length>30)return false
 const prefix=a.slice(0,b.length)
 let previous=Array.from({length:b.length+1},(_,i)=>i)
 for(let i=1;i<=prefix.length;i++){
  const row=[i];for(let j=1;j<=b.length;j++)row[j]=Math.min(row[j-1]!+1,previous[j]!+1,previous[j-1]!+(prefix[i-1]===b[j-1]?0:1))
  previous=row
 }
 return previous[b.length]!<=1
}
export function scoreGroupReply(event:DirectMessage,context:ReplyScoreContext):ReplyScore {
 const text=event.text.trim(),group=event.qqGroup,reasons:string[]=[]
 const fixed=(reply:boolean,reason:string):ReplyScore=>({reply,score:reply?100:0,probability:reply?1:0,reasons:[reason]})
 if(group?.mentioned)return fixed(true,'明确 @ 伙伴')
 const name=context.name?.trim(),directedElsewhere=group?.otherMention===true
 if(!directedElsewhere&&!group?.hasReply&&name&&name.length>=2&&text.startsWith(name)){
  const tail=text.slice(name.length)
  if(!tail||/^[\s,，:：!！?？、]/u.test(tail)||/^(?:你|在吗|在不在|出来|来一下|帮我|帮忙|能不能|可以|会不会)/u.test(tail))return fixed(true,'直接叫到角色名字')
 }
 if(!event.media?.length&&!group?.hasReply&&!directedElsewhere&&/^(?:嗯{1,3}|好|好的|收到|ok)[\s。.!！~～]*$/iu.test(text))return fixed(false,'简短确认，没有新问题')
 let score=8
 const add=(points:number,reason:string)=>{score+=points;reasons.push(`${reason} ${points>=0?'+':''}${points}`)}
 if(context.owner)add(12,'归属账号')
 if(context.owner&&context.affection>0)add(Math.round(Math.min(100,context.affection)*.08),'好感度')
 if(/[?？]|(?:为什么|怎么|咋|是否|是不是|能不能|可以吗|怎么办|谁知道|有人知道|帮忙|请问|在吗|呢[。！!~～\s]*$)/u.test(text))add(18,'问题或求助')
 if(/^(?:你|那你|可是你|但你|所以你)/u.test(text)&&!/[他她它]/u.test(text))add(16,'直接对话措辞')
 // Kinship alone cannot prove identity; only verified owners get this address cue.
 if(context.owner&&/^(?:弟弟|哥哥|姐姐|妹妹|伙伴|小家伙|小朋友)(?:[，,：:\s]|你|呢|在|$)/u.test(text))add(25,'归属账号的称呼')
 if(/^(?:hello|helo|hi|hey|你好|大家好|我来了|我又来了|我回来了)[!！。~～\s]*$/iu.test(text))add(25,'招呼或回来续聊')
 if(/^(?:我都没说|我没说|不是这个|不是那个|不是说|不是这个意思)/u.test(text))add(15,'纠正或补充')
 if(name&&text.includes(name))add(25,'提到角色名')
 else if(name&&nearName(text,name))add(30,'近似角色名')
 const age=context.recent?context.now-context.recent.at:Infinity
 if(age>=0&&age<120000){
  const weight=1-age/120000
  add(Math.round(30*weight),'刚才与此人对话')
  const similarity=topicSimilarity(text,context.recent!.text)
  if(similarity>=.12)add(Math.round(20*similarity*weight),'话题相似')
 }
 if(event.media?.length)add(8,'附件')
 if(group?.hasReply)add(-12,'引用对象未确认')
 if(directedElsewhere)add(-60,'明确 @ 其他人')
 score=Math.max(0,Math.min(directedElsewhere?29:100,Math.round(score)))
 const probability=score>=65?1:score<30?0:(score-30)/35
 const draw=createHash('sha256').update(context.seed).digest().readUInt32BE(0)/0x100000000
 return {score,probability,reply:draw<probability,reasons}
}
