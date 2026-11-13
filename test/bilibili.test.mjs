import test from 'node:test'
import assert from 'node:assert/strict'
import {BilibiliService} from '../lib/channels/bilibili/service.js'
import {biliSettings,parseBiliSettings} from '../lib/channels/bilibili/catalog.js'
import {bilibiliTool} from '../lib/channels/bilibili/tools.js'
import {biliActivityProvider} from '../lib/channels/bilibili/activity-provider.js'
function fixture(){const state={companions:[{id:'c'}],channels:[{id:'bilibili-test',platform:'bilibili',companionId:'c',name:'B',accountId:'',enabled:true,updatedAt:1,bilibili:biliSettings()}],sessions:[{id:'s',sessionId:'s',companionId:'c',kind:'local'}],pairings:[]};const store={snapshot:()=>structuredClone(state),isCompanionRemoving:()=>false,update:async fn=>fn(state)};const calls=[];const service=new BilibiliService(store,async(...a)=>{calls.push(a);return {ok:true}});return {state,store,calls,service,c:state.channels[0]}}
const signal=()=>new AbortController().signal
const bv='BV1xx411c7mD'
test('public browsing requires no account, unknown/disabled APIs and invalid IDs are rejected',async()=>{const f=fixture();await f.service.call(f.c.id,'share_link',{bvid:bv},signal(),()=>{});assert.equal(f.calls.length,1);await assert.rejects(f.service.call(f.c.id,'like',{bvid:bv,status:true},signal(),()=>{}));await assert.rejects(f.service.call(f.c.id,'video',{bvid:'bad'},signal(),()=>{}));assert.equal(f.calls.length,1);assert.throws(()=>parseBiliSettings({autonomousActions:true,enabledActions:['arbitrary']}))})
test('activity discovery respects autonomous toggle, enabled APIs and account state',()=>{const f=fixture();assert.equal(biliActivityProvider.discover({channel:f.c,sessions:[],companionId:'c'}).length,0);f.c.bilibili={autonomousActions:true,enabledActions:['search','comment']};let list=biliActivityProvider.discover({channel:f.c,sessions:[],companionId:'c'}).flatMap(x=>x.operations);assert.deepEqual(list,['search']);f.c.accountId='123';list=biliActivityProvider.discover({channel:f.c,sessions:[],companionId:'c'}).flatMap(x=>x.operations);assert.ok(list.includes('comment'))})
test('write receipts prevent duplicates and survive uncertain completion',async()=>{const f=fixture();f.c.bilibili={autonomousActions:true,enabledActions:['comment']};f.c.accountId='123';const params={bvid:bv,text:'好有趣'};await f.service.call(f.c.id,'comment',params,signal(),()=>{});assert.equal(f.c.bilibiliActivity[0].status,'confirmed');await assert.rejects(f.service.call(f.c.id,'comment',params,signal(),()=>{}));assert.equal(f.calls.length,1);const broken=new BilibiliService(f.store,async()=>{throw Error('timeout')});await assert.rejects(broken.call(f.c.id,'comment',{bvid:bv,text:'另一次'},signal(),()=>{}));assert.equal(f.c.bilibiliActivity.at(-1).status,'unknown');await assert.rejects(f.service.call(f.c.id,'comment',{bvid:bv,text:'另一次'},signal(),()=>{}));assert.equal(f.calls.length,1)})
test('revocation and foreign sessions cannot dispatch API calls',async()=>{const f=fixture();await assert.rejects(f.service.call(f.c.id,'search',{keyword:'test'},signal(),()=>{f.c.enabled=false}));assert.equal(f.calls.length,0);const tool=bilibiliTool('c',f.store,f.service);await assert.rejects(tool.execute({action:'list'},{signal:signal(),agent:{session:{id:'foreign',snapshotEvents:()=>[]}}}));})
test('one account serializes work and receipt history is bounded',async()=>{const f=fixture();let finish;const service=new BilibiliService(f.store,()=>new Promise(r=>{finish=r}));const a=service.call(f.c.id,'search',{keyword:'test'},signal(),()=>{});await assert.rejects(service.call(f.c.id,'hot',{},signal(),()=>{}));finish({ok:true});await a;})
test('login status cannot expose arbitrary credential data through channel state',async()=>{const f=fixture();const s=new BilibiliService(f.store,async()=>({logged_in:true,uid:'456'}));await s.account(f.c.id,'status');assert.equal(f.c.accountId,'456');assert.ok(f.c.updatedAt>1);await assert.rejects(f.service.settings(f.c.id,biliSettings(),1));})


test('definite login refusal permits retry after reauthentication; uncertain writes remain blocked',async()=>{
 const f=fixture();f.c.bilibili={autonomousActions:true,enabledActions:['comment']};f.c.accountId='123';
 const s=new BilibiliService(f.store,async()=>{throw Object.assign(Error('login expired'),{notSubmitted:true,loginRequired:true})});
 const p={bvid:bv,text:'test'};await assert.rejects(s.call(f.c.id,'comment',p,signal(),()=>{}));
 assert.equal(f.c.accountId,'');assert.equal(f.c.bilibiliActivity[0].status,'failed');
 f.c.accountId='123';await f.service.call(f.c.id,'comment',p,signal(),()=>{});assert.equal(f.calls.length,1);
});

test('private abilities and autonomous activity are independent',async()=>{
 const f=fixture();f.c.accountId='123';f.c.bilibili={privateActions:true,autonomousActions:false,enabledActions:['comment']};
 await f.service.call(f.c.id,'comment',{bvid:bv,text:'manual request'},signal(),()=>{});assert.equal(f.calls.length,1);
 assert.equal(biliActivityProvider.discover({channel:f.c,sessions:[],companionId:'c'}).length,0);
 f.c.bilibili={privateActions:false,autonomousActions:true,enabledActions:['comment','search']};
 await assert.rejects(f.service.call(f.c.id,'comment',{bvid:bv,text:'blocked'},signal(),()=>{}));
 assert.deepEqual(biliActivityProvider.discover({channel:f.c,sessions:[],companionId:'c'}).flatMap(x=>x.operations),['search']);
});
test('video acquisition is public; publishing needs its own enabled capability',async()=>{
 const f=fixture();await f.service.call(f.c.id,'video_stream',{bvid:bv,page:2},signal(),()=>{});
 f.c.accountId='123';f.c.bilibili={privateActions:true,autonomousActions:false,enabledActions:['upload_draft','upload_status']};
 await assert.rejects(f.service.call(f.c.id,'publish_video',{draft_id:'a'.repeat(32)},signal(),()=>{}));
 assert.equal(f.calls.length,1);
});
test('media staging rejects files outside current workspace and hidden files',async()=>{
 const {mkdtemp,writeFile,mkdir,symlink,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {openBiliMedia}=await import('../lib/channels/bilibili/media.js');
 const root=await mkdtemp(join(tmpdir(),'bili-scope-'));try{
 await mkdir(join(root,'workspace'));await writeFile(join(root,'secret'),'fixture');await writeFile(join(root,'workspace','.hidden'),'fixture');await symlink(join(root,'secret'),join(root,'workspace','link'));
 for(const name of ['../secret','.hidden','link'])await assert.rejects(openBiliMedia(join(root,'workspace'),name));
 await writeFile(join(root,'workspace','video.mp4'),'fixture');const f=await openBiliMedia(join(root,'workspace'),'video.mp4');await f.handle.close();
 }finally{await rm(root,{recursive:true,force:true})}
});
test('QQ guest can discover public Bilibili operations but cannot invoke account actions',async()=>{
 const f=fixture();f.c.accountId='123';f.c.bilibili={privateActions:true,autonomousActions:false,enabledActions:['search','comment','upload_status']};
 f.state.sessions=[{sessionId:'s',companionId:'c',channelId:'qq',kind:'channel',userId:'32345678',inboundMessageIds:['message']}];
 f.state.channels.push({id:'qq',platform:'qq',qq:{identityBinding:{enabled:true,qqIds:['12345678']}}});
 const agent={session:{id:'s',header:{cwd:'/tmp'},snapshotEvents:()=>[{type:'user/message',data:{id:'message',source:{kind:'user'},content:[]}}]}};
 const tool=bilibiliTool('c',f.store,f.service),exec={signal:signal(),agent};
 const list=await tool.execute({action:'list'},exec);assert.deepEqual(list.channels[0].actions.map(x=>x.id),['search']);
 await tool.execute({action:'call',operation:'search',params:{keyword:'fixture'}},exec);
 await assert.rejects(tool.execute({action:'call',operation:'comment',params:{bvid:bv,text:'blocked'}},exec));
 await assert.rejects(tool.execute({action:'call',operation:'upload_status',params:{job_id:'a'.repeat(32)}},exec));assert.equal(f.calls.length,1);
});

test('video cooldown prevents staging or uploading and leaves a retryable receipt',async()=>{
 const f=fixture();f.c.accountId='123';f.c.bilibili={privateActions:true,enabledActions:['upload_draft']};const calls=[];
 const service=new BilibiliService(f.store,async(_id,op)=>{calls.push(op);return {result:{cooldown:{retryAt:Date.now()/1000+900}}}});
 await assert.rejects(service.call(f.c.id,'upload_draft',{video_path:'missing.mp4',cover_path:'missing.png',title:'test',tags:['test'],tid:1},signal(),()=>{},'/tmp'),/冷却/);
 assert.deepEqual(calls,['upload_health']);assert.equal(f.c.bilibiliActivity[0].status,'failed');
});
test('media status only releases definitely failed jobs, not unknown publications',async()=>{
 const f=fixture();f.c.accountId='123';f.c.bilibili={privateActions:true,enabledActions:['upload_status']};const job='a'.repeat(32);
 f.c.bilibiliActivity=[{id:'receipt',action:'image_dynamic',jobId:job,status:'confirmed',at:Date.now()}];
 let status='unknown';const service=new BilibiliService(f.store,async()=>({result:{status,published:false}}));
 await service.call(f.c.id,'upload_status',{job_id:job},signal(),()=>{});assert.equal(f.c.bilibiliActivity[0].status,'confirmed');
 status='failed';await service.call(f.c.id,'upload_status',{job_id:job},signal(),()=>{});assert.equal(f.c.bilibiliActivity[0].status,'failed');
});
test('image publication requires explicit capability, login, and nonempty images',async()=>{
 const f=fixture();await assert.rejects(f.service.call(f.c.id,'image_dynamic',{image_paths:['a.png']},signal(),()=>{}));
 f.c.accountId='123';f.c.bilibili={privateActions:true,enabledActions:['image_dynamic']};
 await assert.rejects(f.service.call(f.c.id,'image_dynamic',{image_paths:[]},signal(),()=>{}));assert.equal(f.calls.length,0);
});

test('activity catalogue separates public discovery from logged-in interaction and revocation removes private metadata',()=>{
 const f=fixture();f.c.accountId='123';f.c.bilibili={privateActions:true,autonomousActions:true,enabledActions:['search','share_link','dynamic','comment']}
 const list=()=>biliActivityProvider.discover({channel:f.c,sessions:[],companionId:'c'})
 for(const a of list())for(const op of a.operations)assert.equal(a.visibility,['search','share_link'].includes(op)?'public':'private')
 f.c.bilibili.privateActions=false;assert.ok(list().every(a=>a.visibility==='public'))
})
