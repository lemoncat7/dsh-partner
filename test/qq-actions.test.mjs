import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,symlink,rm,mkdir} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {qqActionTools,validateQqParams,qqLocalMedia} from '../lib/channels/qq/actions.js'
import {QQ_ACTIONS,QQ_ACTION_MAP} from '../lib/channels/qq/action-catalog.js'
import {parseQqSettings,qqSettings} from '../lib/channels/qq/settings.js'
import {ChannelManager} from '../lib/channels/manager.js'
import {PartnerAgentRuntime} from '../lib/agent-runtime.js'
const signal=()=>AbortSignal.timeout(10000)
function fixture(){
 const channel={id:'qq',platform:'qq',companionId:'c',accountId:'12345678',enabled:true,updatedAt:1,qq:qqSettings({autonomousActions:true,enabledActions:QQ_ACTIONS.map(a=>a.id),groupReplies:true,groupIds:['493531768']})}
 const state={companions:[{id:'c'}],channels:[channel],sessions:[{sessionId:'s',companionId:'c',cwd:'/tmp'}],pairings:[{channelId:'qq',userId:'834426963',status:'approved',directTargetId:'834426963'}]}
 const store={subscribe:()=>()=>{},snapshot:()=>state,isCompanionRemoving:()=>false,update:async fn=>fn(state)},requests=[]
 let response={tid:'new',token:'do-not-return',html:'<script>bad</script>'}
 const call=async(id,action,params,signal,guard)=>{guard();requests.push({id,action,params});return response}
 const tool=qqActionTools('c',store,call)[0],exec={signal:signal(),callId:'call',agent:{session:{id:'s'}}}
 return {state,store,channel,requests,tool,exec,setResponse:r=>{response=r},call:(operation,params={})=>tool.execute({action:'call',operation,params},exec)}
}
test('QQ capabilities default off and reject unknown operations/options',()=>{
 assert.equal(qqSettings().autonomousActions,false)
 assert.equal(qqSettings().qzoneVisibility,4)
 assert.throws(()=>parseQqSettings({...qqSettings(),enabledActions:['get_cookies']}))
 assert.throws(()=>parseQqSettings({...qqSettings(),qzoneVisibility:'4'}))
 assert.equal(new Set(QQ_ACTIONS.map(a=>a.id)).size,QQ_ACTIONS.length)
 for(const forbidden of ['get_cookies','get_credentials','send_packet','bot_exit'])assert.equal(QQ_ACTION_MAP.has(forbidden),false)
 assert.throws(()=>validateQqParams(QQ_ACTION_MAP.get('send_qzone_msg').schema,{content:'hello',evil:'x'}))
 assert.throws(()=>validateQqParams(QQ_ACTION_MAP.get('get_msg').schema,{message_id:0}))
 validateQqParams(QQ_ACTION_MAP.get('get_msg').schema,{message_id:-123})
 validateQqParams(QQ_ACTION_MAP.get('set_group_member_invite_policy').schema,{group_id:493531768,policy:'require_approval'})
})
test('Qzone default visibility, redacted results and persistent duplicate claim',async()=>{
 const f=fixture();const result=await f.call('send_qzone_msg',{content:'hello'})
 assert.equal(f.requests[0].params.ugc_right,4);assert.deepEqual(result.result,{tid:'new'})
 assert.equal(f.channel.qqActivity[0].status,'confirmed')
 assert.equal((await f.call('send_qzone_msg',{content:'hello'})).duplicate,true)
 const reopened=qqActionTools('c',f.store,()=>{throw Error('duplicate sent')})[0]
 assert.equal((await reopened.execute({action:'call',operation:'send_qzone_msg',params:{content:'hello'}},f.exec)).duplicate,true)
 assert.equal(f.requests.length,1)
})
test('owner, global capability, operation and target scopes are all required',async()=>{
 for(const mutate of [f=>{f.exec.agent.session.id='other'},f=>{f.channel.qq.autonomousActions=false},f=>{f.channel.enabled=false},f=>{f.channel.qq.enabledActions=[]},f=>{f.channel.companionId='other'}]){
  const f=fixture();mutate(f);await assert.rejects(f.call('send_qzone_msg',{content:'x'}));assert.equal(f.requests.length,0)
 }
 const f=fixture()
 await assert.rejects(f.call('send_group_ai_record',{group_id:99999999,character:'v',text:'hello'}),/范围/)
 await assert.rejects(f.call('send_like',{user_id:99999999}),/授权/)
 await f.call('send_like',{user_id:834426963});assert.equal(f.requests.length,1)
})
test('message IDs resolve target scope before reaction and reject group mismatch',async()=>{
 const f=fixture();f.setResponse({message_type:'group',group_id:99999999})
 await assert.rejects(f.call('set_msg_emoji_like',{message_id:-3,emoji_id:'14'}),/范围/)
 assert.equal(f.requests.length,1);assert.equal(f.requests[0].action,'get_msg')
 f.setResponse({message_type:'group',group_id:493531768});f.requests.length=0
 await f.call('set_msg_emoji_like',{message_id:-3,emoji_id:'14'});assert.equal(f.requests[1].params.message_id,-3)
 const g=fixture();g.channel.qq.groupIds.push('99887766');g.setResponse({message_type:'group',group_id:99887766})
 await assert.rejects(g.call('set_group_todo',{group_id:493531768,message_id:-3}),/不属于/)
})
test('revocation during target resolution prevents external mutation',async()=>{
 const f=fixture(),tool=qqActionTools('c',f.store,async(id,action)=>{assert.equal(action,'get_msg');f.channel.qq.enabledActions=[];return {message_type:'group',group_id:493531768}})[0]
 await assert.rejects(tool.execute({action:'call',operation:'delete_msg',params:{message_id:-1}},f.exec),/关闭/)
 assert.equal(f.channel.qqActivity,undefined)
})
test('unacknowledged external mutation is recorded and not retried after tool recreation',async()=>{
 const f=fixture();let calls=0
 const tool=qqActionTools('c',f.store,async()=>{calls++;throw Error('network token=secret')})[0]
 await assert.rejects(tool.execute({action:'call',operation:'send_qzone_msg',params:{content:'x'}},f.exec),e=>!e.message.includes('secret')&&e.message.includes('勿自动'))
 assert.equal(f.channel.qqActivity[0].status,'unknown')
 await tool.execute({action:'call',operation:'send_qzone_msg',params:{content:'x'}},f.exec);assert.equal(calls,1)
})
test('media confines canonical and descriptor path; voice uses native record segment',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'qq-capabilities-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 await writeFile(join(dir,'voice.mp3'),'ID3test');await mkdir(join(dir,'.partner'));await writeFile(join(dir,'.partner','secret'),'secret');await symlink('/etc/passwd',join(dir,'outside'));await symlink(join(dir,'.partner'),join(dir,'hidden'))
 for(const path of ['../etc/passwd','/etc/passwd','outside','hidden/secret','.partner/secret','base64://abc','http://a'])await assert.rejects(qqLocalMedia(dir,path,signal()))
 const f=fixture();f.state.sessions[0].cwd=dir
 await f.call('send_voice',{user_id:834426963,file:'voice.mp3'})
 assert.equal(f.requests[0].action,'send_private_msg');assert.equal(f.requests[0].params.message[0].type,'record');assert.match(f.requests[0].params.message[0].data.file,/^base64:\/\//)
 const g=fixture();await assert.rejects(g.call('send_voice',{user_id:834426963,group_id:493531768,file:'x'}),/只选择/)
})
test('group voice selects saved character and discovery does not send',async()=>{
 const f=fixture();f.channel.qq.voiceCharacter='voice-a'
 await f.tool.execute({action:'describe',operation:'send_group_ai_record'},f.exec);assert.equal(f.requests.length,0)
 await f.call('send_group_ai_record',{group_id:493531768,text:'hello'});assert.equal(f.requests[0].params.character,'voice-a')
})
test('background memory does not prevent a real group autonomy decision',async()=>{
 const f=fixture();f.state.recentReceipts=[];f.state.pairings=[{channelId:'qq',userId:'group:493531768:834426963',status:'approved'}]
 let judgments=0
 const manager=new ChannelManager({},f.store,{}, {isCompanionBusy:()=>true},'/tmp')
 manager.groupAutonomy={observe(){},shouldReply:async()=>{judgments++;return false},record:()=>{throw Error('busy should not suppress decision')}}
 f.state.companions=[{id:'c'}];manager.rememberReceipts=async()=>{}
 await manager.handleDirect(f.channel,{}, {id:'e',sender:'group:493531768:834426963',text:'hello',qqGroup:{groupId:'493531768',autonomous:true,mentioned:false}},signal())
 assert.equal(judgments,1)
})
test('busy diagnostics distinguish memory, setup, observation and actual sessions',()=>{
 const f=fixture();const runtime=new PartnerAgentRuntime({agents:{get:()=>({status:'running'})}},f.store,'/tmp',undefined,{isRunning:()=>true})
 runtime.observationJobs.set('c',1);runtime.agentSetupJobs.set('c',1)
 const rows=runtime.companionActivity('c');assert.deepEqual(rows.map(r=>r.kind),['memory','observation','setup','conversation']);assert.equal(rows[3].sessionId,'s')
})

test('AI discovers and edits enabled profile operations through the same entry',async()=>{
 const f=fixture()
 const listed=await f.tool.execute({action:'list',category:'profile'},f.exec)
 assert.ok(listed.channels[0].actions.some(a=>a.id==='set_qq_profile'))
 const described=await f.tool.execute({action:'describe',operation:'set_qq_profile'},f.exec)
 assert.ok(described.parameters.properties.nickname)
 await f.call('set_qq_profile',{nickname:'新的昵称',personal_note:'新的资料'})
 assert.equal(f.requests[0].action,'set_qq_profile');assert.equal(f.requests[0].params.nickname,'新的昵称')
 const g=fixture();g.channel.qq.enabledActions=g.channel.qq.enabledActions.filter(a=>a!=='set_qq_profile')
 await assert.rejects(g.call('set_qq_profile',{nickname:'不应修改'}));assert.equal(g.requests.length,0)
})


test('single QQ entry discovers categories before bounded operation lists and individual schemas',async()=>{
 const f=fixture(),tools=qqActionTools('c',f.store,async()=>{})
 assert.equal(tools.length,1)
 const initial=await f.tool.execute({action:'list'},f.exec)
 assert.equal(initial.channels[0].actions,undefined)
 assert.equal(initial.channels[0].categories.length,10)
 assert.doesNotMatch(JSON.stringify(initial),/set_qq_profile|parameters/)
 const detail=await f.tool.execute({action:'list',category:'profile'},f.exec)
 assert.ok(detail.channels[0].actions.some(a=>a.id==='set_qq_profile'))
 assert.equal(detail.channels[0].actions[0].schema,undefined)
 const search=await f.tool.execute({action:'list',query:'语音'},f.exec)
 assert.ok(search.channels[0].actions.length>0);assert.ok(search.channels[0].actions.length<=20)
 const page=await f.tool.execute({action:'list',query:'get',offset:20},f.exec)
 assert.ok(page.channels[0].actions.length<=20)
 assert.equal(f.requests.length,0)
})
