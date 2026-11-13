import test from 'node:test'
import assert from 'node:assert/strict'
import {collectActivityJournal,mergeActivityJournal,activityJournalRecall,renderActivityJournal} from '../lib/character/activity-journal.js'
import {IDLE_CONTACT_NOTICE} from '../lib/character/idle-contact.js'
const events=()=>[
 {type:'turn/start',seq:1,data:{turn:1}},
 {type:'user/message',seq:2,data:{id:'idle',source:{kind:'plugin:@lemoncat7/dsh-partner',form:'notice',summary:IDLE_CONTACT_NOTICE}}},
 {type:'tool/call',seq:3,data:{callId:'w',name:'write',arguments:JSON.stringify({file_path:'activities/puzzle.md',content:'PRIVATE CONTENT'})}},
 {type:'tool/result',seq:4,data:{message:{toolCallId:'w',isError:false}}},
 {type:'tool/call',seq:5,data:{callId:'b',name:'bash',arguments:'{"command":"secret"}'}},
 {type:'tool/result',seq:6,data:{message:{toolCallId:'b',isError:true}}},
 {type:'tool/ptc-dispatch',seq:7,data:{name:'partner_activity_finish',arguments:'{}',isError:false,meta:{kind:'partner-activity-silent-v1',reason:'做了一道搭桥题，留着以后玩'}}},
 {type:'turn/end',seq:8,time:1234,data:{turn:1,reason:{kind:'completed'}}},
]
test('silent activities retain evidence and artifacts without archiving tool contents or reasoning',()=>{
 const rows=collectActivityJournal('s',events());assert.equal(rows.length,1)
 assert.equal(rows[0].silent,true);assert.deepEqual(rows[0].artifacts,['activities/puzzle.md'])
 assert.deepEqual(rows[0].tools,[{name:'write',ok:true},{name:'bash',ok:false}])
 assert.ok(!JSON.stringify(rows).includes('PRIVATE CONTENT'));assert.ok(!JSON.stringify(rows).includes('secret'))
 assert.match(renderActivityJournal(rows),/安静结束不代表没做过/)
})
test('journal excludes user turns, failed turns and spoofed notices',()=>{
 for(const mutate of [e=>e.splice(2,0,{type:'user/message',data:{source:{kind:'user'}}}),e=>e.at(-1).data.reason.kind='failed',e=>e[1].data.source.kind='user']){
  const e=events();mutate(e);assert.deepEqual(collectActivityJournal('s',e),[])
 }
})
test('durable journal is bounded, deduplicated and restricted to an eligible source session',()=>{
 const c={};const rows=collectActivityJournal('s',events());assert.equal(mergeActivityJournal(c,rows),true);assert.equal(mergeActivityJournal(c,rows),false)
 assert.equal(activityJournalRecall(c,'s',true).length,1);assert.deepEqual(activityJournalRecall(c,'s',false),[]);assert.deepEqual(activityJournalRecall(c,'other',true),[])
 for(let i=0;i<50;i++)mergeActivityJournal(c,[{...rows[0],id:String(i),at:2000+i}])
 assert.equal(c.activityJournal.length,40)
})
test('journal repairs recent missing records from completed raw session events without inventing events',()=>{
 const c={};assert.equal(activityJournalRecall(c,'s',true,events()).length,1);assert.equal(c.activityJournal,undefined)
})

test('activity journal survives durable storage without changing identity revision',async t=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path')
 const {PartnerStore}=await import('../lib/store.js')
 const root=await mkdtemp(join(tmpdir(),'activity-journal-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const file=join(root,'state.json'),store=await PartnerStore.open(file)
 const before=store.snapshot().companions[0].updatedAt
 await store.update(s=>mergeActivityJournal(s.companions[0],collectActivityJournal('s',events())))
 const reopened=await PartnerStore.open(file),c=reopened.snapshot().companions[0]
 assert.equal(c.updatedAt,before);assert.equal(c.activityJournal[0].summary,'做了一道搭桥题，留着以后玩')
})

test('silent finish does not erase confirmed speech and a successful call alone is not delivery',()=>{
 const e=events();e.splice(-1,0,{type:'tool/ptc-dispatch',data:{name:'partner_chat_reply',arguments:'{}',isError:false,meta:{kind:'partner-chat-v1',parts:[{type:'text',text:'发现一个好玩的'}],delivered:true,originRouteId:'r'}}})
 const r=collectActivityJournal('s',e)[0];assert.equal(r.silent,true);assert.equal(r.sharing,'confirmed');assert.equal(r.sharedText,'发现一个好玩的')
 delete e.at(-2).data.meta.delivered
 assert.equal(collectActivityJournal('s',e)[0].sharing,'pending')
 delete e.at(-2).data.meta
 assert.equal(collectActivityJournal('s',e)[0].sharing,'none')
})
test('successful edits connect work progress and old receipts can be repaired without duplicates',()=>{
 const e=events();e[2].data.name='edit';const row=collectActivityJournal('s',e)[0]
 assert.deepEqual(row.artifacts,['activities/puzzle.md'])
 const legacy={...row};delete legacy.sharing;const c={activityJournal:[legacy]}
 assert.equal(mergeActivityJournal(c,[row]),true);assert.equal(c.activityJournal.length,1);assert.equal(c.activityJournal[0].sharing,'none')
 assert.equal(mergeActivityJournal(c,[row]),false)
})
test('statistics separate confirmed, pending, unknown and overlapping categories',async()=>{
 const {summarizeActivities}=await import('../lib/character/activity-summary.js')
 const base=collectActivityJournal('s',events())[0]
 const s=summarizeActivities([{...base,sharing:'confirmed'},{...base,sharing:'pending'},{...base,sharing:undefined}])
 assert.equal(s.total,3);assert.equal(s.confirmed,1);assert.equal(s.pending,1);assert.equal(s.unknown,1);assert.equal(s.failed,3)
})
test('deferred delivery updates view only from acknowledged parts and exact owner/message',async()=>{
 const {withActivityDeliveries}=await import('../lib/character/activity-summary.js')
 const c={id:'c',activityJournal:collectActivityJournal('s',events())}
 const delivery={companionId:'c',reply:{idleContactOrigin:{messageId:'idle'}},targets:[{sentParts:[]}]}
 assert.equal(withActivityDeliveries(c,[delivery]).activityJournal[0].sharing,'pending')
 delivery.targets[0].sentParts=[0]
 assert.equal(withActivityDeliveries(c,[delivery]).activityJournal[0].sharing,'confirmed')
 delivery.companionId='other';assert.equal(withActivityDeliveries(c,[delivery]).activityJournal[0].sharing,'none')
 assert.equal(c.activityJournal[0].sharing,'none')
})
test('completed legacy receipts still match activity after payload scrubbing',async()=>{
 const {withActivityDeliveries}=await import('../lib/character/activity-summary.js')
 const c={id:'c',activityJournal:collectActivityJournal('s',events())}
 const delivery={id:JSON.stringify(['c','idle:idle']),companionId:'c',completedAt:123,reply:{text:'',attachments:[]},targets:[{sentParts:[0]}]}
 assert.equal(withActivityDeliveries(c,[delivery]).activityJournal[0].sharing,'confirmed')
 delivery.id=JSON.stringify(['c','idle:other']);assert.equal(withActivityDeliveries(c,[delivery]).activityJournal[0].sharing,'none')
})

test('explicit activity recall searches retained older entries rather than the latest eight',()=>{
 const make=(id,summary,at,sessionId='s')=>({id,summary,at,sessionId,silent:true,tools:[],artifacts:[]})
 const c={activityJournal:[make('origin','搜索卡比冷知识，从画册视频简介找到官方链接',1),...Array.from({length:12},(_,i)=>make(String(i),'翻看其他作品',i+2)),make('recent','卡比官网角色介绍',20),make('private','卡比画册私密内容',30,'other')]}
 assert.deepEqual(activityJournalRecall(c,'s',true,[],8,'卡比画册').map(r=>r.id),['origin','recent'])
 assert.equal(activityJournalRecall(c,'s',true,[],8,'最初为啥搜索卡比')[0].id,'origin')
 assert.deepEqual(activityJournalRecall(c,'s',true,[],8,'不存在的火星任务'),[])
 assert.deepEqual(activityJournalRecall(c,'s',false,[],8,'卡比'),[])
 assert.equal(activityJournalRecall(c,'s',true,[],3).length,3,'automatic context stays bounded')
})

test('B site native and dispatched calls retain exact operation without argument contents',()=>{
 const e=events();e[2].data.name='partner_bilibili';e[2].data.arguments=JSON.stringify({action:'call',operation:'comments',params:{text:'PRIVATE'}})
 e.splice(-1,0,{type:'tool/ptc-dispatch',data:{name:'partner_bilibili',arguments:JSON.stringify({action:'call',operation:'comment',params:{text:'PRIVATE'}}),isError:false}})
 const r=collectActivityJournal('s',e)[0]
 assert.ok(r.tools.some(t=>t.name==='partner_bilibili:comments'))
 assert.ok(r.tools.some(t=>t.name==='partner_bilibili:comment'))
 assert.doesNotMatch(JSON.stringify(r),/PRIVATE/)
 const old={...r,sharing:'confirmed',summary:'preserve this',tools:[{name:'partner_bilibili:call',ok:true}]},c={activityJournal:[old]}
 assert.equal(mergeActivityJournal(c,[r]),true);assert.equal(c.activityJournal[0].sharing,'confirmed');assert.equal(c.activityJournal[0].summary,'preserve this')
 assert.deepEqual(c.activityJournal[0].tools,r.tools);assert.equal(mergeActivityJournal(c,[r]),false)
})


test('MCP activity records real nested operations once, without wrapper discovery or calls',()=>{
 const e=events();e.splice(2,e.length-3,
 {type:'tool/call',data:{callId:'list',name:'partner_mcp',arguments:'{"action":"list"}'}},
 {type:'tool/result',data:{message:{toolCallId:'list',isError:false}}},
 {type:'tool/call',data:{callId:'work',name:'partner_mcp',arguments:'{"action":"call"}'}},
 {type:'tool/ptc-dispatch',data:{name:'mcp__read_audit',arguments:'{}',isError:false}},
 {type:'tool/result',data:{message:{toolCallId:'work',isError:false}}})
 assert.deepEqual(collectActivityJournal('s',e)[0].tools,[{name:'mcp__read_audit',ok:true}])
})
