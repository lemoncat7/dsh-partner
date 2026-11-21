import test from 'node:test'
import assert from 'node:assert/strict'
import {QqGroupAutonomy,QUIET_CONVERSATION_WINDOW_MS} from '../lib/channels/qq/autonomy.js'
import {scoreGroupReply,routeGroupReply,CONVERSATION_WINDOW_MS} from '../lib/channels/qq/reply-rules.js'
const event={id:'one',sender:'group:12345678:22345678',text:'小明你怎么看？',qqGroup:{groupId:'12345678',userId:'22345678',senderName:'朋友',autonomous:true,mentioned:false}}
const companion={name:'小明',relationshipText:'用户是哥哥，角色是弟弟'}
const context={name:'小明',owner:true,addresses:['弟弟'],affection:20,now:1000000,seed:'test'}
const signal=()=>new AbortController().signal
const forbidden={get(){throw Error('must not resolve a remote model')}}
const unavailable=async()=>undefined
const input=(text,group={},id=text)=>({...event,id,text,qqGroup:{...event.qqGroup,...group}})

test('explicit calling and validated reply relationships take precedence over semantics',()=>{
 for(const text of ['小明？','小明你怎么看','小明。出来聊聊']){
  const result=scoreGroupReply(input(text),context);assert.equal(result.reply,true,text);assert.equal(result.route,'direct')
 }
 assert.equal(routeGroupReply(input('小明天去不去'),context),undefined)
 assert.equal(scoreGroupReply(input('你好',{otherMention:true}),context).reply,false)
 assert.equal(scoreGroupReply(input('小明？',{replyTo:'other',hasReply:true}),context).reply,false)
 assert.equal(scoreGroupReply(input('嗯',{replyTo:'self',hasReply:true}),context).route,'direct')
 assert.equal(scoreGroupReply(input('你好',{otherMention:true,mentioned:true}),context).reply,true)
 assert.equal(routeGroupReply(input('弟弟人呢？'),context),undefined,'relationship terms are not hardcoded routing aliases')
})
test('a typed mention addresses the current character by name',()=>{
 const ctx={...context,name:'莫殇',semantic:{label:'other',confidence:.378,margin:.052,scene:{label:'other',confidence:.417,margin:.159}}}
 for(const text of ['@莫殇 什么长者表情包 解释一下','＠ 莫殇，你知道这个吗']){
  const reply=scoreGroupReply(input(text),ctx)
  assert.equal(reply.reply,true)
  assert.equal(reply.route,'direct')
 }
 assert.equal(routeGroupReply(input('@莫殇的朋友，解释一下'),ctx),undefined)
 assert.equal(routeGroupReply(input('@莫殇 解释一下',{replyTo:'other',hasReply:true}),ctx).reply,false)
})

test('recent conversation keeps substantive followups but leaves closing acknowledgements quiet',async()=>{
 let now=context.now,calls=0;const gate=new QqGroupAutonomy(forbidden,()=>now,async()=>{calls++;return {label:'engage',confidence:.65,margin:.25,replySimilarity:.7}})
 const first=input('小明？');gate.observe('c',first);assert.equal(await gate.shouldReply('c',first,companion,signal()),true);gate.replied('c',first,'刚刚回来了')
 now+=13000
 for(const text of ['哇 太棒了','然后呢','我都没说那个','😀','That is awesome!','え、すごいね']){
  const e=input(text);gate.observe('c',e);assert.equal(await gate.shouldReply('c',e,companion,signal()),true,text)
  assert.equal(gate.status('c').route,'continuation')
 }
 assert.equal(await gate.shouldReply('c',input('好的'),companion,signal()),false)
 assert.equal(calls,6,'a recent speaker still needs evidence of a continuation')
})
test('another speaker does not erase a thread or inherit it; channels, groups and expiry are separate',async()=>{
 let now=context.now,calls=0;const gate=new QqGroupAutonomy(forbidden,()=>now,async text=>{calls++;return {label:'background',confidence:.4,margin:.08,replySimilarity:.6,...(text==='太棒了'&&calls===2?{scene:{label:'question',confidence:.85,margin:.5}}:{})}})
 const first=input('小明？');gate.observe('c',first);gate.replied('c',first,'刚刚回来了')
 now+=13000
 const other=input('天气不错',{userId:'33445678'});gate.observe('c',other);await gate.shouldReply('c',other,companion,signal());assert.equal(gate.status('c').route,'fallback')
 const follow=input('太棒了');gate.observe('c',follow);await gate.shouldReply('c',follow,companion,signal());assert.equal(gate.status('c').route,'continuation')
 await gate.shouldReply('other-channel',follow,companion,signal());assert.equal(gate.status('other-channel').route,'fallback')
 await gate.shouldReply('c',input('太棒了',{groupId:'87654321'}),companion,signal());assert.equal(gate.status('c').route,'fallback')
 now+=CONVERSATION_WINDOW_MS;await gate.shouldReply('c',follow,companion,signal());assert.equal(gate.status('c').route,'fallback');assert.equal(calls,5)
})
test('only delivery establishes continuity, redirect and explicit stopping close the correct thread',async()=>{
 const gate=new QqGroupAutonomy(forbidden,()=>context.now,unavailable)
 const first=input('小明？');gate.observe('c',first);await gate.shouldReply('c',first,companion,signal())
 const follow=input('太棒了');gate.observe('c',follow);await gate.shouldReply('c',follow,companion,signal());assert.equal(gate.status('c').route,'fallback','mere admission is not a reply')
 gate.replied('c',first,'你好')
 const redirect=input('你在吗',{otherMention:true});gate.observe('c',redirect)
 gate.replied('c',first,'late delivery');await gate.shouldReply('c',follow,companion,signal());assert.equal(gate.status('c').route,'fallback','late old send does not reopen redirected thread')
 gate.observe('c',first);gate.replied('c',first,'你好')
 const stop=input('不用回复了');gate.observe('c',stop);assert.equal(await gate.shouldReply('c',stop,companion,signal()),false)
 gate.replied('c',stop,'');await gate.shouldReply('c',follow,companion,signal());assert.equal(gate.status('c').route,'fallback')
})
test('uncertain new group chatter stays quiet; direct requests and genuine continuations remain reachable',()=>{
 for(const semantic of [undefined,{label:'other',confidence:.6,margin:.3},{label:'close',confidence:.8,margin:.15},{label:'engage',confidence:.5,margin:.2}]){
  assert.equal(scoreGroupReply(input('给你看看'),{...context,semantic}).reply,false)
  assert.equal(scoreGroupReply(input('给你看看'),{...context,semantic,recent:{at:context.now,text:'看什么'}}).reply,false)
 }
 for(const label of ['address','engage'])assert.equal(scoreGroupReply(input('给你看看'),{...context,semantic:{label,confidence:.8,margin:.5}}).reply,true)
 for(const label of ['other','close','background'])for(const recent of [undefined,{at:context.now,text:'你好'}])assert.equal(scoreGroupReply(input('普通消息'),{...context,recent,semantic:{label,confidence:.9,margin:.6}}).reply,false)
 assert.equal(scoreGroupReply(input('好的'),{...context,recent:{at:context.now,text:'你来了吗'}}).reply,false)
 assert.equal(scoreGroupReply(input('不用回复了',{mentioned:true}),context).reply,false)
})
test('classifier outage does not admit every group line; explicit requests and cancellation remain intact',async()=>{
 const gate=new QqGroupAutonomy(forbidden,()=>context.now,async()=>{throw Error('service down')})
 assert.equal(await gate.shouldReply('c',input('我来了'),companion,signal()),false)
 assert.equal(await gate.shouldReply('c',input('小明帮我看看'),companion,signal()),true)
 const controller=new AbortController();controller.abort()
 await assert.rejects(gate.shouldReply('c',event,companion,controller.signal))
 const lateController=new AbortController(),late=new QqGroupAutonomy(forbidden,()=>context.now,async()=>{lateController.abort();return undefined})
 await assert.rejects(late.shouldReply('c',input('我来了'),companion,lateController.signal))
})
test('bounded observations exclude the current and later events from the context of a queued message',()=>{
 const gate=new QqGroupAutonomy(forbidden,()=>context.now,unavailable)
 for(let i=0;i<100;i++)gate.observe('c',input('message-'+i,{},String(i)))
 const rows=JSON.parse(gate.context('c',input('message-98',{},'98')))
 assert.equal(rows.length,16);assert.equal(rows.at(-1).text,'message-97')
})

test('group context keeps a confirmed reply before messages received later in the same QQ second',()=>{
 const second=1000000
 let now=second+100
 const gate=new QqGroupAutonomy(forbidden,()=>now,unavailable)
 const record=(id,text,user)=>{const e={...input(text,{userId:user},id),timestamp:second,receivedAt:now};gate.observe('c',e);return e}
 const first=record('first','先问一句','22345678')
 now=second+300
 gate.replied('c',first,'伙伴已经答了')
 now=second+450
 record('other','群友接话','33445678')
 now=second+600
 const current=record('current','再问一句','22345678')
 const rows=JSON.parse(gate.context('c',current))
 assert.deepEqual(rows.map(row=>row.text),['先问一句','伙伴已经答了','群友接话'])
 assert.deepEqual(rows.map(row=>Date.parse(row.at)),[second+100,second+300,second+450])
})

test('shared sleep stops an ongoing hot group thread before semantic classification',async()=>{
 let now=context.now,calls=0;const gate=new QqGroupAutonomy(forbidden,()=>now,async()=>{calls++;return {label:'engage',confidence:.65,margin:.25,replySimilarity:.6}})
 const first=input('小明？');gate.observe('c',first);gate.replied('c',first,'聊着呢')
 const sleeping={...companion,sleepPolicy:{enabled:true},sleepState:{episode:{wakeAt:context.now+60000}}}
 assert.equal(await gate.shouldReply('c',input('然后呢'),sleeping,signal()),false)
 assert.equal(calls,0);assert.match(gate.status('c').reason,/睡眠/)
 assert.equal(await gate.shouldReply('c',input('醒醒',{mentioned:true}),sleeping,signal()),true)
 sleeping.sleepState.episode.wokeAt=context.now
 now+=13000
 assert.equal(await gate.shouldReply('c',input('然后呢'),sleeping,signal()),true)
})

test('human exchanges stay selective and nearby public invitations are each evaluated',async()=>{
 let now=context.now,calls=0
 const gate=new QqGroupAutonomy(forbidden,()=>now,async()=>{calls++;return {label:'engage',confidence:.95,margin:.9}})
 gate.observe('c',input('上线了已经',{userId:'33445678'},'other'))
 now+=2000
 let chosen
 for(let i=0;i<100;i++){
  const chatter=input('这话听起来怪怪的',{},'candidate-'+i);gate.observe('c',chatter)
  if(await gate.shouldReply('c',chatter,companion,signal())){chosen=chatter;break}
 }
 assert.ok(chosen,'human-to-human chatter is no longer categorically rejected')
 assert.equal(gate.status('c').route,'opportunity');assert.ok(calls>0)
 const before=calls,mention=input('帮我看看',{mentioned:true});gate.observe('c',mention)
 assert.equal(await gate.shouldReply('c',mention,companion,signal()),true);assert.equal(calls,before)
 assert.equal(await gate.shouldReply('c',input('？'),companion,signal()),false);assert.equal(calls,before)
 const invitation=input('大家怎么看这个更新');gate.observe('c',invitation)
 assert.equal(await gate.shouldReply('c',invitation,companion,signal()),true)
})

test('semantic chime-ins are optional and never override explicit other-person addressing',async()=>{
 const labels={label:'engage',confidence:.95,margin:.9},shared={...context,otherConversation:true,semantic:labels}
 const decisions=Array.from({length:200},(_,i)=>scoreGroupReply(input('这个透视也太离谱了'),{...shared,seed:'room-message-'+i}))
 assert.ok(decisions.some(r=>r.reply));assert.ok(decisions.some(r=>!r.reply));assert.ok(decisions.every(r=>r.route==='opportunity'))
 assert.equal(scoreGroupReply(input('这个透视也太离谱了',{otherMention:true}),shared).reply,false)
 assert.equal(scoreGroupReply(input('普通消息'),{...shared,semantic:{label:'other',confidence:.95,margin:.8}}).reply,false)
 let now=context.now
 const gate=new QqGroupAutonomy(forbidden,()=>now,async()=>labels)
 const e=input('大家觉得怎么样');gate.observe('a',e);assert.equal(await gate.shouldReply('a',e,companion,signal()),true)
 const second=input('还有一个大家来看看',{},'second');gate.observe('a',second);assert.equal(await gate.shouldReply('a',second,companion,signal()),true)
 gate.observe('b',second);assert.equal(await gate.shouldReply('b',second,companion,signal()),true)
 const another=input('大家来看看',{groupId:'87654321'},'another');gate.observe('a',another);assert.equal(await gate.shouldReply('a',another,companion,signal()),true)
})

test('room history includes factual seconds and delivered partner turns, and expires stale chatter',()=>{
 let now=context.now;const gate=new QqGroupAutonomy(forbidden,()=>now,unavailable)
 const first={...input('小明？',{},'first'),timestamp:now-5000};gate.observe('c',first)
 gate.replied('c',first,'我刚看见')
 now+=2000;const next={...input('然后呢',{},'next'),timestamp:now};gate.observe('c',next)
 const rows=JSON.parse(gate.context('c',next))
 assert.equal(rows[0].ageSeconds,7);assert.equal(rows[1].ageSeconds,2)
 assert.equal(rows[1].kind,'partner');assert.equal(rows[1].text,'我刚看见')
 assert.ok(!rows.some(r=>r.text==='然后呢'))
 now+=11*60000;const later=input('新话题',{},'later');gate.observe('c',later)
 assert.deepEqual(JSON.parse(gate.context('c',later)),[])
})

test('verified followups stop after redirects and cancellation; decision history is bounded metadata only',async()=>{
 let now=context.now,calls=0;const gate=new QqGroupAutonomy(forbidden,()=>now,async()=>{calls++;return {label:'background',confidence:.4,margin:.08,replySimilarity:.6}})
 const first=input('小明？');gate.observe('c',first);gate.replied('c',first,'你好')
 now+=13000;const follow=input('前面那张呢');gate.observe('c',follow)
 assert.equal(await gate.shouldReply('c',follow,companion,signal()),true);assert.equal(calls,1)
 const stop=input('你们先聊，不用回我');gate.observe('c',stop)
 assert.equal(await gate.shouldReply('c',stop,companion,signal()),false)
 assert.equal(await gate.shouldReply('c',follow,companion,signal()),false)
 for(let i=0;i<45;i++)gate.record('c',input('private text',{},String(i)),'旁听')
 const history=gate.history('c');assert.equal(history.length,40);assert.equal(history.at(-1).messageId,'44')
 assert.ok(!JSON.stringify(history).includes('private text'));history.length=0;assert.equal(gate.history('c').length,40)
})

test('moderate clear engagement and context-related followups are admitted without weakening explicit negatives',()=>{
 const e=input('这一下也太厉害了')
 assert.equal(scoreGroupReply(e,{...context,semantic:{label:'engage',confidence:.606557,margin:.448234}}).reply,true)
 assert.equal(scoreGroupReply(e,{...context,semantic:{label:'engage',confidence:.54,margin:.18}}).reply,false)
 assert.equal(scoreGroupReply(e,{...context,semantic:{label:'engage',confidence:.54,margin:.18,contextSimilarity:.65}}).reply,true)
 assert.equal(scoreGroupReply(e,{...context,semantic:{label:'engage',confidence:.54,margin:.18,contextSimilarity:.1}}).reply,false)
 for(const label of ['other','close','background'])assert.equal(scoreGroupReply(e,{...context,semantic:{label,confidence:.9,margin:.6,contextSimilarity:.99}}).reply,false)
 for(const e of [input('不用回我'),input('好'),input('这下真厉害',{otherMention:true})])assert.equal(scoreGroupReply(e,{...context,semantic:{label:'engage',confidence:.95,margin:.8,contextSimilarity:.99}}).reply,false)
})
test('classification gets bounded fresh context plus last delivered reply, never other rooms or future messages',async()=>{
 let now=context.now;const seen=[]
 const gate=new QqGroupAutonomy(forbidden,()=>now,async(text,_signal,rows)=>{seen.push({text,rows});return {label:'background',confidence:.9,margin:.6}})
 const initial=input('小明？');gate.observe('c',initial);gate.replied('c',initial,'篮球打得不错')
 for(let i=0;i<8;i++){now+=1000;gate.observe('c',input('篮球比赛'+i+'x'.repeat(300),{userId:'33445678'},'background-'+i))}
 const current=input('最后那个球真绝了',{userId:'44556677'},'current');gate.observe('c',current)
 gate.observe('c',input('future secret',{userId:'33445678'},'future'))
 await gate.shouldReply('c',current,companion,signal())
 assert.equal(seen[0].text,current.text);assert.equal(seen[0].rows.length,4);assert.ok(seen[0].rows.every(t=>t.length<=48))
 assert.ok(seen[0].rows.includes('篮球打得不错'));assert.ok(!seen[0].rows.some(t=>t.includes('future secret')||t.includes(current.text)))
 assert.equal(gate.status('c').contextSize,4)
 assert.deepEqual(gate.attentionContext('other-channel',current),[])
 assert.deepEqual(gate.attentionContext('c',input('另一个群',{groupId:'87654321'})),[])
 now+=91000;assert.deepEqual(gate.attentionContext('c',current),[])
})
test('real local-model misses recover for open invitations and related reactions without admitting unrelated background',()=>{
 for(const text of ['大家觉得这个更新怎么样','有人知道这个怎么弄吗'])assert.equal(routeGroupReply(input(text),context).route,'opportunity')
 assert.equal(routeGroupReply(input('有人知道这个怎么弄吗',{otherMention:true}),context).reply,false)
 assert.equal(scoreGroupReply(input('最后那一下绝了'),{...context,semantic:{label:'close',confidence:.6333,margin:.3331,contextSimilarity:.7028}}).reply,true)
 assert.equal(scoreGroupReply(input('最后那一下绝了'),{...context,semantic:{label:'close',confidence:.6333,margin:.3331,contextSimilarity:.1}}).reply,false)
 assert.equal(scoreGroupReply(input('然后那个呢'),{...context,semantic:{label:'engage',confidence:.4965,margin:.1489,contextSimilarity:.4174}}).reply,true)
 assert.equal(scoreGroupReply(input('他住慈溪那边'),{...context,semantic:{label:'other',confidence:.3935,margin:.1254,contextSimilarity:.4233}}).reply,false)
 assert.equal(scoreGroupReply(input('晚安'),{...context,semantic:{label:'close',confidence:.63,margin:.33,contextSimilarity:.7}}).reply,false)
})

test('plain acknowledgements stay quiet while new requests and questions can be answered immediately',async()=>{
 let now=context.now
 let prediction={label:'engage',confidence:.75,margin:.45,replySimilarity:.72,scene:{label:'banter',confidence:.8,margin:.5}}
 const gate=new QqGroupAutonomy(forbidden,()=>now,async()=>prediction)
 const a=input('小明？');gate.observe('c',a);gate.replied('c',a,'3050这就要当公众号美工了')
 now+=2000
 const same=input('哈哈我也觉得',{},'same-speaker')
 gate.observe('c',same);assert.equal(await gate.shouldReply('c',same,companion,signal()),false)
 assert.match(gate.status('c').reason,/确认或收尾/)
 const shared=input('其他成员顺着话题补充',{userId:'33445678'},'shared')
 gate.observe('c',shared);await gate.shouldReply('c',shared,companion,signal())
 assert.equal(gate.status('c').route,'opportunity')
 assert.ok(gate.status('c').probability<1)
 assert.match(gate.guidance('c',same),/同一话题换人发言也仍是一场对话/)
 const direct=input('小明看看我这个',{userId:'33445678',mentioned:true})
 gate.observe('c',direct);assert.equal(await gate.shouldReply('c',direct,companion,signal()),true)
 prediction={...prediction,scene:{label:'question',confidence:.85,margin:.5}}
 const actualQuestion=input('所以这张显卡能跑哪些模型？')
 gate.observe('c',actualQuestion);assert.equal(await gate.shouldReply('c',actualQuestion,companion,signal()),true)
})
test('an elliptical request grounded in the delivered conversation is recognized even when the model calls it a closing',async()=>{
 const prediction={label:'close',confidence:.85135,margin:.7955,contextSimilarity:.57217,replySimilarity:.47242,scene:{label:'close',confidence:.52747,margin:.38406}}
 const fixture=(delay=21_000)=>{
  let now=context.now,calls=0
  const gate=new QqGroupAutonomy(forbidden,()=>now,async()=>{calls++;return prediction})
  const send=(text,reply)=>{const e=input(text);gate.observe('c',e);gate.replied('c',e,reply)}
  send('换个成年男性，破防的那种效果试试看','换不了，我只能拿童声破防')
  now+=23_000
  send('免费声音能存三种，我目前只有这一种','我占一个格子，剩下想存谁的声音')
  now+=delay
  const check=async (text,group={})=>{const e=input(text,group);gate.observe('c',e);return gate.shouldReply('c',e,companion,signal())}
  return {gate,check,calls:()=>calls}
 }
 for(const text of ['那你破一个','那你试一下','你能不能用刚才那个？']){
  const f=fixture()
  assert.equal(await f.check(text),true,text)
  assert.equal(f.gate.status('c').route,'continuation')
  assert.equal(f.gate.status('c').followupRequest,true)
  assert.equal(f.gate.status('c').addressed,false)
  assert.equal(f.calls(),1)
  const guidance=f.gate.guidance('c',input(text))
  assert.match(guidance,/补足省略/)
  assert.doesNotMatch(guidance,/确认或收尾/)
 }
 assert.equal(await fixture(2000).check('那你破一个'),true)
 assert.equal(await fixture(65_000).check('那你破一个'),true)
 for(const text of ['那你自己看着办','我也就这么一说','那你不用再说一句'])assert.equal(await fixture().check(text),false,text)
 assert.equal(await fixture().check('那你破一个',{replyTo:'other',hasReply:true}),false)
 assert.equal(await fixture().check('那你破一个',{userId:'33445678'}),false)
 const interleaved=fixture()
 await interleaved.check('另一个成员说了一句',{userId:'33445678'})
 assert.equal(await interleaved.check('那你破一个'),false)
})
test('a new speaker can ask for a followup to the last delivered room reply',async()=>{
 let now=context.now,frame
 const prediction={label:'engage',confidence:.373178,margin:.041462,contextSimilarity:.638552,replySimilarity:.344960,scene:{label:'question',confidence:.235602,margin:.050380}}
 const fixture=()=>{
  now=context.now
  const reply='链接我没存，搜图样图森破就一堆，视频版更魔性'
  const gate=new QqGroupAutonomy(forbidden,()=>now,async(text,_signal,_context,_report,f)=>{
   frame=f
   const index=f.dialogue.findIndex(turn=>turn.speaker===0&&turn.text===reply)
   return text.startsWith('你去')&&f.partnerText===reply&&index>=0
    ?{...prediction,replySimilarity:.623276,link:{index,confidence:.9,margin:.6}}
    :prediction
  })
  const initial=input('什么长者表情包')
  gate.observe('c',initial)
  gate.replied('c',initial,'图样图森破，一脸看透你的老先生表情')
  now+=132_000
  const link=input('有对应链接么',{userId:'33445678'})
  gate.observe('c',link)
  now+=10_000
  gate.replied('c',link,reply)
  now+=24_000
  return {gate,reply}
 }
 const request=input('你去b站找点对对应的视频给我们看看')
 let f=fixture()
 f.gate.observe('c',request)
 assert.equal(await f.gate.shouldReply('c',request,companion,signal()),true)
 assert.equal(frame.partnerText,f.reply,'the latest delivered room reply takes priority over the older reply to this speaker')
 assert.equal(f.gate.status('c').followupRequest,true)
 assert.equal(f.gate.status('c').addressed,true)
 assert.equal(f.gate.status('c').linkedMessageId,'reply:有对应链接么')
 assert.match(f.gate.guidance('c',request),/当前发言关联的前文/)
 assert.match(f.gate.guidance('c',request),/有对应链接么/)
 f=fixture()
 f.gate.observe('c',input('另外那条我先问小赵',{userId:'44556677'}))
 f.gate.observe('c',request)
 assert.equal(await f.gate.shouldReply('c',request,companion,signal()),false,'an intervening human turn makes the target ambiguous')
 f=fixture()
 const quoted=input(request.text,{hasReply:true,replyTo:'other'})
 f.gate.observe('c',quoted)
 assert.equal(await f.gate.shouldReply('c',quoted,companion,signal()),false,'an explicit other recipient wins')
 f=fixture()
 const agreement=input('我也觉得视频挺有意思')
 f.gate.observe('c',agreement)
 assert.equal(await f.gate.shouldReply('c',agreement,companion,signal()),false,'similarity alone does not identify a request')
})
test('interleaved conversation preserves two reply chains and uses the selected parent’s speaker',async()=>{
 let now=context.now
 let frame
 const member={userId:'33445678'},third={userId:'44556677'}
 const gate=new QqGroupAutonomy(forbidden,()=>now,async(text,_signal,_history,_report,value)=>{
  frame=value
  const parents={'先试文字版':'旧版也能导出','我来取过去':'下班前这箱我会放前台','那把第二版也附上':'先试文字版'}
  const index=frame.dialogue.findIndex(turn=>turn.text===parents[text])
  return {label:'address',confidence:.8,margin:.5,...(index>=0?{link:{index,confidence:.87,margin:.6}}:{})}
 })
 const add=(text,author={})=>{now+=1000;const e=input(text,author);gate.observe('a',e);return e}
 const decide=e=>gate.shouldReply('a',e,companion,signal())
 const start=add('这份稿能导出吗')
 gate.replied('a',start,'旧版也能导出')
 const a=add('先试文字版')
 assert.equal(await decide(a),true)
 gate.replied('a',a,'文字版准备好了')
 add('下班前这箱我会放前台',member)
 assert.equal(await decide(add('我来取过去',third)),false)
 assert.equal(gate.status('a').linkedMessageId,'下班前这箱我会放前台')
 const last=add('那把第二版也附上',third)
 assert.equal(await decide(last),false)
 const traced=frame.dialogue.find(turn=>turn.text===a.text)
 assert.equal(frame.dialogue[traced.replyTo].text,'旧版也能导出')
 const human=frame.dialogue.find(turn=>turn.text==='我来取过去')
 assert.equal(frame.dialogue[human.replyTo].text,'下班前这箱我会放前台')
 assert.doesNotMatch(JSON.stringify(frame.dialogue),/33445678|44556677/)
})
test('shared conversation stays selective and cannot inherit silence, another room or a future send',async()=>{
 let now=context.now;const gate=new QqGroupAutonomy(forbidden,()=>now,async()=>({label:'engage',confidence:.41,margin:.21,contextSimilarity:.71}))
 const a=input('小明？'),b=input('接着刚才的话',{userId:'33445678'},'b');gate.observe('c',a);gate.observe('c',b)
 await gate.shouldReply('c',a,companion,signal())
 assert.equal(await gate.shouldReply('c',b,companion,signal()),false,'admission is not delivery')
 gate.replied('c',a,'已经参与话题')
 assert.equal(await gate.shouldReply('c',b,companion,signal()),false)
 assert.match(gate.status('c').reason,/缺少明确的接话意图/)
 assert.equal(await gate.shouldReply('other',b,companion,signal()),false)
 assert.equal(await gate.shouldReply('c',{...b,qqGroup:{...b.qqGroup,groupId:'87654321'}},companion,signal()),false)
 assert.equal(await gate.shouldReply('c',{...b,receivedAt:now-1},companion,signal()),false,'queued input cannot inherit a later send')
 now+=180000;assert.equal(await gate.shouldReply('c',b,companion,signal()),false,'silent admissions did not extend the group window')
 assert.match(gate.guidance('c',b),/尚无近期参与依据/)
})
test('shared participation never overrides other-person targets, stops, strong negatives or unrelated weak scores',()=>{
 const c={...context,groupRecent:{at:context.now-1000,text:'聊显卡'},semantic:{label:'engage',confidence:.41,margin:.21,contextSimilarity:.71}}
 for(const e of [input('不用回复'),input('好的'),input('晚安'),input('显卡',{otherMention:true}),input('显卡',{replyTo:'other'})])assert.equal(scoreGroupReply(e,c).reply,false)
 for(const label of ['other','background','close'])assert.equal(scoreGroupReply(input('普通消息'),{...c,semantic:{label,confidence:.9,margin:.6,contextSimilarity:.9}}).reply,false)
 assert.equal(scoreGroupReply(input('不相关的新话题'),{...c,semantic:{...c.semantic,contextSimilarity:.1}}).reply,false)
})

test('moderate separated positive intent passes, while unsupported low scores stay quiet',()=>{
 for(const [text,label,confidence,margin] of [['绳子断了','engage',.543657,.355339],['弟弟。出来吐槽几句','address',.568769,.372488],['你别装没看见啊','engage',.549,.339]])assert.equal(scoreGroupReply(input(text),{...context,semantic:{label,confidence,margin}}).reply,true)
 assert.equal(scoreGroupReply(input('史诗级削弱'),{...context,semantic:{label:'close',confidence:.4618,margin:.1151,contextSimilarity:.3416}}).reply,true)
 assert.equal(scoreGroupReply(input('无关联的附和'),{...context,semantic:{label:'close',confidence:.4618,margin:.1151,contextSimilarity:.1}}).reply,false)
})
test('a quiet room retains a relevant reply after 32 minutes without assuming every new message is a continuation',async()=>{
 let now=context.now,prediction={label:'address',confidence:.403,margin:.12,contextSimilarity:.508},seen
 const gate=new QqGroupAutonomy(forbidden,()=>now,async(t,s,c)=>{seen=c;return prediction})
 const first=input('小明？');gate.observe('c',first);gate.replied('c',first,'给大家一个亿 但每花一块钱就得当众喵一声')
 now+=32*60000;const next=input('那你喵起来',{},'quiet');gate.observe('c',next)
 assert.equal(await gate.shouldReply('c',next,companion,signal()),true);assert.equal(gate.status('c').route,'continuation')
 assert.ok(seen.some(s=>s.includes('喵')));assert.ok(JSON.parse(gate.context('c',next)).some(r=>r.kind==='partner'&&r.ageSeconds===1920))
 assert.match(gate.guidance('c',next),/1920 秒前/)
 prediction={...prediction,contextSimilarity:.1};assert.equal(await gate.shouldReply('c',next,companion,signal()),false)
})
test('quiet continuity expires, cannot cross rooms, and intervening traffic survives observation TTL pruning',async()=>{
 for(const mode of ['intervening','expired','other-room','quoted-other','strong-negative']){
  let now=context.now;const gate=new QqGroupAutonomy(forbidden,()=>now,async()=>({label:mode==='strong-negative'?'other':'address',confidence:mode==='strong-negative'?.95:.403,margin:mode==='strong-negative'?.8:.12,contextSimilarity:.7}))
  const first=input('小明？');gate.observe('c',first);gate.replied('c',first,'刚聊的笑话')
  if(mode==='intervening'){now+=60000;gate.observe('c',input('后来已经聊了别的话题',{userId:'99887766'},'intervening'))}
  now+=mode==='expired'?QUIET_CONVERSATION_WINDOW_MS:32*60000
  const next=input('那你呢',mode==='quoted-other'?{replyTo:'other'}:mode==='other-room'?{groupId:'99887766'}:{},'next');gate.observe('c',next)
  assert.equal(await gate.shouldReply('c',next,companion,signal()),false,mode)
 }
})
test('unavailable classifications carry diagnostics without turning failure into a semantic rejection',async()=>{
 const gate=new QqGroupAutonomy(forbidden,()=>context.now,async(t,s,c,report)=>{report({status:'timeout',attempts:2,retryAfterMs:1000})})
 const e=input('路过的话');gate.observe('c',e);await gate.shouldReply('c',e,companion,signal())
 assert.equal(gate.status('c').classification.status,'timeout');assert.match(gate.status('c').reason,/请求超时/);assert.equal(gate.status('c').semantic,undefined)
})

test('model-recognized calls are never sampled out as casual interjections during other conversation',()=>{
 for(const text of ['弟弟','小可爱','你人呢','过来一下'])for(let i=0;i<200;i++){
  const result=scoreGroupReply(input(text),{...context,otherConversation:true,seed:'call-'+i,semantic:{label:'address',confidence:.55,margin:.31}})
  assert.equal(result.reply,true,text+' seed='+i);assert.equal(result.probability,1);assert.equal(result.route,'semantic')
 }
 assert.equal(scoreGroupReply(input('弟弟',{otherMention:true}),{...context,semantic:{label:'address',confidence:.9,margin:.8}}).reply,false)
})
test('busy admission uses semantic calls without admitting engagement, background or classifier failures',async()=>{
 for(const label of ['address','engage','background',undefined]){
  let calls=0
  const gate=new QqGroupAutonomy(forbidden,()=>context.now,async()=>{calls++;return label?{label,confidence:.8,margin:.6}:undefined})
  const e=input('一个未配置的叫法');gate.observe('c',e)
  assert.equal(await gate.shouldReply('c',e,companion,signal(),undefined,true),label==='address');assert.equal(calls,1)
 }
})

test('a separated low-confidence call is admitted; a reference to another person is not a call',()=>{
 const semantic={label:'address',confidence:.49314788287942196,margin:.27950781102531624}
 assert.equal(scoreGroupReply(input('弟弟弟弟'),{...context,semantic}).reply,true)
 assert.equal(scoreGroupReply(input('我弟弟今天放假'),{...context,semantic:{...semantic,scene:{label:'other',confidence:.85,margin:.7}}}).reply,false)
 assert.equal(scoreGroupReply(input('我喊弟弟',{otherMention:true}),{...context,semantic}).reply,false)
})
test('social scenes create selective opportunities and use delivered topic or actual persona relevance',()=>{
 for(const label of ['question','banter','share','topic']){
  const semantic={label:'background',confidence:.4,margin:.08,scene:{label,confidence:.8,margin:.6}}
  const decisions=Array.from({length:100},(_,i)=>scoreGroupReply(input('一段可以交流的新内容'),{...context,seed:'scene-'+i,otherConversation:true,semantic}))
  assert.ok(decisions.some(d=>d.reply),label);assert.ok(decisions.some(d=>!d.reply),label)
  const related=scoreGroupReply(input('一段可以交流的新内容'),{...context,semantic:{...semantic,replySimilarity:.5}})
  assert.equal(related.reply,true,label);assert.equal(related.route,'continuation',label)
  if(['share','banter'].includes(label)){
   assert.equal(scoreGroupReply(input('新内容'),{...context,otherConversation:true,semantic}).probability,.25)
   assert.equal(scoreGroupReply(input('新内容'),{...context,otherConversation:true,semantic:{...semantic,profileSimilarity:.6}}).probability,.65)
  }
 }
 for(const label of ['close','other','background'])assert.equal(scoreGroupReply(input('新内容'),{...context,recent:{at:context.now-60000,text:'旧话题'},semantic:{label:'engage',confidence:.9,margin:.8,contextSimilarity:.9,scene:{label,confidence:.9,margin:.8}}}).reply,false,label)
})
test('social opportunities never queue behind busy work; recognized calls still do',async()=>{
 for(const label of ['banter','share','question','topic','address']){
  const gate=new QqGroupAutonomy(forbidden,()=>context.now,async()=>({label:label==='address'?'address':'background',confidence:.8,margin:.6,scene:{label,confidence:.9,margin:.8},replySimilarity:.9}))
  const e=input('一段新内容');gate.observe('c',e)
  assert.equal(await gate.shouldReply('c',e,companion,signal(),undefined,true),label==='address',label)
 }
})
test('semantic identity frame is current and relationship is scoped to the verified sender',async()=>{
 const frames=[];const gate=new QqGroupAutonomy(forbidden,()=>context.now,async(_text,_signal,_context,_report,frame)=>{frames.push(frame);return {label:'background',confidence:.3,margin:.01}})
 const identity={...companion,characterCard:{enabled:true,roleText:'喜欢拆坏掉的收音机。擅长照顾街边受伤的小动物'},name:'新名字',role:'喜欢推理游戏',description:'爱开玩笑',relationshipText:'绑定账号是哥哥，自己是弟弟'}
 const settings={identityBinding:{enabled:true,qqIds:['22345678']}}
 const e=input('一些普通内容');gate.observe('c',e)
 await gate.shouldReply('c',e,identity,signal(),settings)
 await gate.shouldReply('c',input('一些普通内容',{userId:'33445678'}),identity,signal(),settings)
 assert.equal(frames[0].profile[0],'新名字');assert.ok(frames[0].profile.includes(identity.relationshipText))
 assert.ok(!frames[1].profile.includes(identity.relationshipText))
 assert.ok(frames.every(f=>f.profile.includes('擅长照顾街边受伤的小动物')))
 assert.ok(frames.every(f=>f.profile.length<=11&&f.profile.every(t=>t.length<=160)))
})
test('recognized scene is passed to generation only for that message; explicit targets remain authoritative',async()=>{
 const gate=new QqGroupAutonomy(forbidden,()=>context.now,async()=>({label:'engage',confidence:.8,margin:.7,scene:{label:'banter',confidence:.85,margin:.7}}))
 const e=input('又说早睡结果熬夜');gate.observe('c',e);await gate.shouldReply('c',e,companion,signal())
 assert.match(gate.guidance('c',e),/本轮本地场景线索：玩笑、接梗或吐槽/)
 assert.doesNotMatch(gate.guidance('c',input('另一个消息')),/本轮本地场景线索/)
 const other=input('新内容',{replyTo:'other',hasReply:true});gate.observe('c',other)
 assert.equal(await gate.shouldReply('c',other,companion,signal()),false)
})

test('a call recognized by the scene head is admitted alongside a public invitation',async()=>{
 let label='share';const gate=new QqGroupAutonomy(forbidden,()=>context.now,async()=>({label:'engage',confidence:.9,margin:.8,scene:{label,confidence:.9,margin:.8},replySimilarity:.5}))
 const first=input('大家觉得这个如何');gate.observe('c',first);assert.equal(await gate.shouldReply('c',first,companion,signal()),true)
 label='address';const next=input('喂在不在');gate.observe('c',next)
 assert.equal(await gate.shouldReply('c',next,companion,signal()),true)
})


test('actual contextual call is not vetoed by a moderately confident other-person scene, including the busy lane',async()=>{
 const semantic={label:'address',confidence:.48606611574332986,margin:.17431895777286216,contextSimilarity:.6368050634380726,replySimilarity:.6368050634380726,scene:{label:'other',confidence:.5266644592651288,margin:.3483341396482804}}
 assert.equal(scoreGroupReply(input('你又不在他那里， 把什么门'),{...context,semantic}).reply,true)
 for(const group of [{otherMention:true},{replyTo:'other'}])assert.equal(scoreGroupReply(input('你又不在他那里， 把什么门',group),{...context,semantic}).reply,false)
 const gate=new QqGroupAutonomy(forbidden,()=>context.now,async()=>semantic),e=input('你又不在他那里， 把什么门');gate.observe('c',e)
 assert.equal(await gate.shouldReply('c',e,companion,signal(),undefined,true),true)
})


test('persona-supported agreement admits the actual repeated call without requiring prior replies',async()=>{
 const semantic={label:'address',confidence:.4788505692967512,margin:.23663710133781604,profileSimilarity:.6701513241060744,scene:{label:'address',confidence:.44913295794483965,margin:.2970202471576032}}
 assert.equal(scoreGroupReply(input('弟弟 出来冒泡'),{...context,semantic}).reply,true)
 const gate=new QqGroupAutonomy(forbidden,()=>context.now,async()=>semantic)
 for(const suffix of ['first','again']){const e={...input('弟弟 出来冒泡'),id:'call-'+suffix};gate.observe('c',e);assert.equal(await gate.shouldReply('c',e,companion,signal(),undefined,true),true)}
 for(const group of [{otherMention:true},{replyTo:'other'}])assert.equal(scoreGroupReply(input('弟弟 出来冒泡',group),{...context,semantic}).reply,false)
})
test('reply-related continuations cannot override a confirmed other-person scene',()=>{
 for(const label of ['other','close','background']){
  const result=scoreGroupReply(input('你刚才那句是什么意思'),{...context,latestReplyToSpeaker:true,recent:{at:context.now-45000,text:'上一条实际回复'},semantic:{label,confidence:.95,margin:.9,replySimilarity:.8,scene:{label,confidence:.95,margin:.9}}})
  assert.equal(result.reply,label!=='other');assert.equal(result.route,label==='other'?'other':'continuation')
  assert.equal(scoreGroupReply(input('无关的新话题'),{...context,recent:{at:context.now-45000,text:'上一条实际回复'},semantic:{label,confidence:.95,margin:.9,replySimilarity:.05,scene:{label,confidence:.95,margin:.9}}}).reply,false)
 }
 assert.equal(scoreGroupReply(input('不用回复了'),{...context,recent:{at:context.now-45000,text:'上一条实际回复'}}).reply,false)
})

test('a recent exchange cannot turn a group member’s invitation to another member into a call',async()=>{
 let now=context.now,calls=0
 const semantic={label:'address',confidence:.52,margin:.3,contextSimilarity:.88,replySimilarity:.79,scene:{label:'other',confidence:.45,margin:.1}}
 const gate=new QqGroupAutonomy(forbidden,()=>now,async()=>{calls++;return semantic})
 const initial=input('小明看看');gate.observe('c',initial);gate.replied('c',initial,'我看见了')
 now+=1000;gate.observe('c',input('我礼拜六回余姚了',{userId:'33445678'},'other'))
 now+=1000;const follow=input('那我礼拜天来宁波找你',{},'follow');gate.observe('c',follow)
 assert.equal(await gate.shouldReply('c',follow,companion,signal()),false)
 assert.equal(gate.status('c').route,'other');assert.equal(calls,1)
 assert.equal(await gate.shouldReply('c',input('你怎么看',{hasReply:true}),companion,signal()),false)
 assert.equal(await gate.shouldReply('c',input('你怎么看',{hasReply:true,replyTo:'self'}),companion,signal()),true)
})

test('weak correlated address labels alone cannot admit unrelated chatter',()=>{
 const semantic={label:'address',confidence:.28,margin:.01,scene:{label:'address',confidence:.2,margin:.01}}
 assert.equal(scoreGroupReply(input('随便聊聊'),{...context,semantic}).reply,false)
})

test('embedded mentions require semantic addressing, including while busy, without inheriting a recent thread',async()=>{
 const mentioned=input('弟弟 你觉得 他打球怎么样',{otherMention:true,otherMentionOffsets:[6]})
 assert.equal(routeGroupReply(mentioned,{...context,quickContinuation:true,recent:{at:context.now,text:'你说'}}),undefined)
 const call={label:'address',confidence:.8,margin:.6,scene:{label:'address',confidence:.8,margin:.6}}
 let calls=0,prediction=call
 const gate=new QqGroupAutonomy(forbidden,()=>context.now,async(text)=>{calls++;assert.equal(text,'弟弟 你觉得 @其他成员  他打球怎么样');return prediction})
 const first=input('小明？');gate.observe('c',first);gate.replied('c',first,'你说')
 gate.observe('c',mentioned)
 assert.equal(await gate.shouldReply('c',mentioned,companion,signal(),undefined,true),true)
 gate.replied('c',mentioned,'我觉得还不错')
 assert.match(gate.context('c',input('后续')),/我觉得还不错/,'mentioning a subject must not retire the delivered conversation')
 for(const semantic of [undefined,{label:'other',confidence:.9,margin:.8},{label:'engage',confidence:.9,margin:.8,replySimilarity:1,scene:{label:'question',confidence:.9,margin:.8}}]){
  prediction=semantic
  assert.equal(await gate.shouldReply('c',mentioned,companion,signal()),false,'neither recent conversation nor question scene proves who is addressed')
 }
 assert.equal(calls,4)
 const follow=input('接着说');gate.observe('c',follow);prediction=undefined
 assert.equal(await gate.shouldReply('c',follow,companion,signal()),false,'semantic redirect retires the speaker thread')
})

test('unrelated chatter leaves a one-member discussion intact; a second participant restores group pacing',async()=>{
 const decide=async(joinText)=>{
  let now=context.now
  const gate=new QqGroupAutonomy(forbidden,()=>now,async()=>({label:'engage',confidence:.72,margin:.24,
   scene:{label:'banter',confidence:.8,margin:.32},replySimilarity:.45}))
  const first=input('小明，我们聊聊银河列车这部电影',{},'first')
  gate.observe('c',first);gate.replied('c',first,'银河列车这部电影的车站很漂亮')
  now+=3000
  const other=input(joinText,{userId:'33445678'},'other')
  gate.observe('c',other)
  now+=3000
  const follow=input('银河列车的车站宛如星空',{},'follow')
  gate.observe('c',follow)
  await gate.shouldReply('c',follow,companion,signal())
  return gate.status('c')
 }
 const alone=await decide('今晚晚饭吃面条')
 assert.equal(alone.discussionParticipants,1)
 assert.equal(alone.route,'continuation')
 assert.equal(alone.probability,1)
 const shared=await decide('银河列车这部电影我也看过')
 assert.equal(shared.discussionParticipants,2)
 assert.equal(shared.route,'opportunity')
 assert.equal(shared.probability,.28)
})
