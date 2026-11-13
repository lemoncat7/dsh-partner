import test from 'node:test'
import assert from 'node:assert/strict'
import {activityChoiceContext} from '../lib/character/activity-choice.js'
import {createChannelActivities} from '../lib/channels/activity-defaults.js'
import {ChannelActivityRegistry} from '../lib/channels/activity-registry.js'
import {idleActivityPrompt} from '../lib/character/idle-contact.js'
import {BILI_ACTION_MAP} from '../lib/channels/bilibili/catalog.js'
const now=Date.now()
const row=(id,names,at=now-60000,sessionId='s')=>({id,sessionId,at,summary:'PRIVATE SUMMARY',silent:true,sharing:'none',artifacts:['/private/file'],tools:names.map(name=>({name,ok:true}))})
const fixture=()=>({companions:[{id:'c'}],channels:[
 {id:'qq',platform:'qq',companionId:'c',enabled:true,qq:{autonomousActions:true,enabledActions:['get_qzone_feeds','send_qzone_msg','delete_qzone_msg','set_qq_profile']}},
 {id:'b',platform:'bilibili',companionId:'c',enabled:true,accountId:'123',bilibili:{autonomousActions:true,privateActions:true,enabledActions:['search','hot','comments','comment','unread','replies','favorite_lists','favorite','dynamic','publish_video']}}
],sessions:[{id:'r',sessionId:'s',companionId:'c',kind:'local',channelId:'@local'}],pairings:[]})
const data=text=>JSON.parse(text.split('\n')[0].split('：').slice(1).join('：'))

test('creation-heavy history surfaces unused space and social reading without scheduling publication',()=>{
 const s=fixture(),c={id:'c',activityJournal:Array.from({length:12},(_,i)=>row(String(i),['write','generate_image','partner_bilibili:search'],now-(12-i)*60000))}
 const before=structuredClone({s,c}),text=activityChoiceContext(c,[],createChannelActivities().describe(s,'c'),'s',now),d=data(text)
 assert.equal(d.sampleRounds,12)
 assert.equal(d.counts.find(x=>x.kind==='创作或修改文件').rounds,12)
 assert.equal(d.explorationOptions.length,3)
 assert.ok(d.explorationOptions.some(x=>x.tool==='partner_qq'&&x.discoveryOperations.includes('get_qzone_feeds')))
 assert.ok(d.explorationOptions.some(x=>x.discoveryOperations.includes('unread')))
 assert.ok(d.explorationOptions.every(x=>x.observedRounds===0))
 assert.doesNotMatch(JSON.stringify(d),/send_qzone_msg|delete_qzone_msg|set_qq_profile|publish_video|PRIVATE SUMMARY|private\/file/)
 assert.match(text,/不是轮流打卡、必做任务或发言配额/)
 assert.deepEqual({s,c},before)
})

test('sample is session scoped, bounded by time and size, and preserves uncertainty of old operations',()=>{
 const s=fixture(),c={id:'c',activityJournal:[row('old',['generate_image'],now-8*86400_000),row('future',['generate_image'],now+60000),row('foreign',['generate_image'],now-60000,'other'),...Array.from({length:15},(_,i)=>row(String(i),['partner_bilibili:call','partner_bilibili:describe'],now-(16-i)*60000))]}
 const d=data(activityChoiceContext(c,[],createChannelActivities().describe(s,'c'),'s',now))
 assert.equal(d.sampleRounds,12);assert.equal(d.unknownOperationRounds,12);assert.deepEqual(d.counts,[])
 assert.equal(data(activityChoiceContext(c,[],[],undefined,now)).sampleRounds,0)
})

test('recent failed external operations are not suggested for immediate retry; revoked capabilities disappear',()=>{
 const s=fixture(),failed=row('f',['partner_qq:get_qzone_feeds']);failed.tools[0].ok=false
 const c={id:'c',activityJournal:[failed]},catalog=()=>createChannelActivities().describe(s,'c')
 assert.ok(!data(activityChoiceContext(c,[],catalog(),'s',now)).explorationOptions.some(x=>x.channelId==='qq'))
 failed.at=now-7*3600_000
 assert.ok(data(activityChoiceContext(c,[],catalog(),'s',now)).explorationOptions.some(x=>x.channelId==='qq'))
 s.channels[1].bilibili.autonomousActions=false
 assert.ok(data(activityChoiceContext(c,[],catalog(),'s',now)).explorationOptions.some(x=>x.channelId==='qq'))
 s.channels[0].qq.autonomousActions=false
 assert.deepEqual(data(activityChoiceContext(c,[],catalog(),'s',now)).explorationOptions,[])
})

test('actual interaction is distinct from reading, discovery and failed sends',()=>{
 const c={id:'c',activityJournal:[row('read',['partner_bilibili:comments','partner_bilibili:describe']),row('write',['partner_bilibili:comment','partner_qq:send_qzone_msg']),row('fail',['partner_bilibili:dynamic'])]}
 c.activityJournal[2].tools[0].ok=false
 const d=data(activityChoiceContext(c,[],[],'s',now))
 assert.equal(d.counts.find(x=>x.kind==='空间或B站互动发布').rounds,1)
 assert.equal(d.counts.find(x=>x.kind==='网页或视频资料').rounds,1)
})

test('discovery metadata is optional, validated against enabled operations and read-only for built-in B site',()=>{
 const s=fixture(),list=createChannelActivities().describe(s,'c')
 assert.ok(data(activityChoiceContext({id:'c'},[],list,'s',now)).explorationOptions.some(x=>x.channelId==='qq'),'a provider with many categories cannot hide the other channel')
 for(const p of list.filter(x=>x.platform==='bilibili'))for(const a of p.activities)for(const op of a.discoveryOperations??[])assert.equal(BILI_ACTION_MAP.get(op).write,false)
 const r=new ChannelActivityRegistry(),base={id:'read',title:'新频道',tool:'other_plugin',visibility:'public',description:'读取新资料',operations:['read']}
 r.register({id:'new',platform:'qq',discover:()=>[{...base,discoveryOperations:['write']}]});assert.deepEqual(r.describe(s,'c'),[])
 const good=new ChannelActivityRegistry();good.register({id:'new',platform:'qq',discover:()=>[{...base,discoveryOperations:['read']}]})
 assert.equal(data(activityChoiceContext({id:'c'},[],good.describe(s,'c'),'s',now)).explorationOptions[0].tool,'other_plugin')
})

test('real idle prompt includes selection feedback without exposing other sessions or altering configuration',()=>{
 const s=fixture(),c=s.companions[0];c.idleContact={routeId:'r'};c.activityJournal=[row('one',['generate_image']),row('other',['partner_qq:send_qzone_msg'],now-50000,'other')]
 const before=structuredClone(s),prompt=idleActivityPrompt(s,c)
 assert.match(prompt,/"sampleRounds":1/);assert.match(prompt,/"kind":"创作或修改文件","rounds":1/)
 assert.doesNotMatch(prompt,/PRIVATE SUMMARY|private\/file/)
 assert.match(prompt,/明确的用户约定/);assert.match(prompt,/看到内容后/)
 assert.deepEqual(s,before)
})
