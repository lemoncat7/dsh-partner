import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectDirectBatch, groupDirectMessages } from '../lib/channels/direct/inbound-batch.js'
import { DirectTransport } from '../lib/channels/direct/transport.js'
import { ChannelManager } from '../lib/channels/manager.js'
import { PartnerAgentRuntime } from '../lib/agent-runtime.js'

const text = { id:'text',sender:'peer',targetId:'room',text:'看我框起来的地方，再画点魔法',timestamp:10000 }
const image = { id:'image',sender:'peer',targetId:'room',text:'',timestamp:10096,media:[{source:'mxc://local/image'}] }

test('96 ms caption/image burst becomes one input in either order; text-only stays separate',()=>{
  assert.deepEqual(groupDirectMessages([text,image]),[[text,image]])
  const caption={...text,timestamp:10100}
  assert.deepEqual(groupDirectMessages([image,caption]),[[image,caption]])
  assert.equal(groupDirectMessages([text,{...text,id:'second',timestamp:10100}]).length,2)
})

test('different room, sender, old timestamps, missing timestamps and unrelated delays cannot merge',()=>{
  for(const other of [{...image,sender:'other'},{...image,targetId:'other'},{...image,timestamp:13000},{...image,timestamp:9000},{...image,timestamp:undefined}]) {
    assert.equal(groupDirectMessages([text,other]).length,2)
  }
  const many=Array.from({length:17},(_,i)=>({...image,id:String(i),timestamp:10000+i}))
  assert.deepEqual(groupDirectMessages(many).map(g=>g.length),[16,1])
})

test('lookahead combines separate sync batches, deduplicates overlap and carries cursor; abort/failure never succeeds',async()=>{
  let polls=0
  const batch=await collectDirectBatch({cursor:'first',messages:[text]},async cursor=>{polls++;assert.equal(cursor,'first');return {cursor:'next',messages:[text,image]}},new AbortController().signal,0)
  assert.deepEqual(batch.messages,[text,image]);assert.equal(batch.cursor,'next');assert.equal(polls,1)
  await assert.rejects(collectDirectBatch({cursor:'first',messages:[text]},async()=>assert.fail(),AbortSignal.abort(),0))
  await assert.rejects(collectDirectBatch({cursor:'first',messages:[text]},async()=>{throw Error('network')},new AbortController().signal,0),/network/)
  await collectDirectBatch({cursor:'empty',messages:[]},async()=>assert.fail(),new AbortController().signal,0)
})

function fixture() {
  const channel={id:'channel',platform:'matrix',accountId:'bot',companionId:'companion',enabled:true,direct:{baseUrl:'http://local',targetId:'room',peerId:'peer',cursor:'old'}}
  const state={channels:[channel],companions:[{id:'companion'}],recentReceipts:[],pairings:[{channelId:'channel',userId:'peer',status:'approved',directTargetId:'room'}]}
  const controller=new AbortController(),received=[]
  const store={snapshot:()=>structuredClone(state),update:async fn=>fn(state)}
  const manager=new ChannelManager({},store,{read:async()=>({baseUrl:'http://local',botToken:'test'})},{reply:async(...args)=>{received.push(args[3]);return {text:'完成',attachments:[]}}},'/tmp')
  return {manager,store,state,channel,controller,received}
}

test('connector collects caption then file across polls before execution and commits both receipts',async t=>{
  const f=fixture();let calls=0,downloaded=false
  t.mock.method(DirectTransport.prototype,'validate',async()=>({accountId:'bot',peerId:'peer'}))
  t.mock.method(DirectTransport.prototype,'poll',async(cursor,_signal,wait)=>{
    calls++
    if(calls===1)return {cursor:'first',messages:[text]}
    assert.equal(cursor,'first');assert.equal(wait,0)
    return {cursor:'complete',messages:[image]}
  })
  t.mock.method(DirectTransport.prototype,'receiveAttachments',async message=>{
    assert.equal(message.id,'image');assert.equal(f.received.length,0)
    downloaded=true;return [{kind:'image',name:'image.png',data:Buffer.from('image'),mediaType:'image/png'}]
  })
  t.mock.method(DirectTransport.prototype,'sendText',async()=>{})
  t.mock.method(DirectTransport.prototype,'progress',()=>({typing:async()=>{},create:async()=> 'progress',edit:async()=>{},send:async()=>{}}))
  const update=f.store.update
  f.store.update=async fn=>{await update(fn);if(f.state.channels[0].direct.cursor==='complete')f.controller.abort()}
  await f.manager.directLoop(f.channel,f.controller.signal)
  assert.equal(downloaded,true);assert.equal(f.received.length,1)
  assert.equal(f.received[0].text,text.text);assert.equal(f.received[0].attachments.length,1)
  assert.ok(f.state.recentReceipts.includes('channel:text'));assert.ok(f.state.recentReceipts.includes('channel:image'))
})

test('download failure does not execute caption; grouped receipts prevent replay and foreign groups fail',async()=>{
  const f=fixture(),sent=[]
  const api={config:{targetId:'room'},receiveAttachments:async()=>{throw Error('download')},sendText:async(_peer,text)=>sent.push(text)}
  await f.manager.handleDirect(f.channel,api,text,f.controller.signal,[text,image])
  assert.equal(f.received.length,0);assert.match(sent[0],/未交给伙伴执行/)
  assert.deepEqual(f.state.recentReceipts,['channel:text','channel:image'])
  await f.manager.handleDirect(f.channel,api,text,f.controller.signal,[text,image])
  assert.equal(sent.length,1)
  await assert.rejects(f.manager.handleDirect(f.channel,api,{...text,id:'fresh'},f.controller.signal,[{...text,id:'fresh'},{...image,id:'foreign',sender:'other'}]),/不同联系人/)
})

test('group attachment count is checked before downloads and each original post ID is preserved',async()=>{
  const f=fixture(),ids=[]
  const api={config:{targetId:'room'},receiveAttachments:async message=>{ids.push(message.id);return [{kind:'file',name:'a',data:Buffer.from('a')}]},sendText:async()=>{}}
  await f.manager.handleDirect(f.channel,api,text,f.controller.signal,[text,image,{...image,id:'second',timestamp:10100}])
  assert.deepEqual(ids,['image','second']);assert.equal(f.received.length,1);assert.equal(f.received[0].attachments.length,2)
  const fresh=fixture()
  await fresh.manager.handleDirect(fresh.channel,{...api,receiveAttachments:async()=>assert.fail('oversized group must not download')},text,fresh.controller.signal,[text,{...image,media:Array(9).fill(image.media[0])}])
  assert.equal(fresh.received.length,0)
})

test('inbound files exist before model handoff and paths precede user words in one message',async t=>{
  const cwd=await mkdtemp(join(tmpdir(),'partner-inbound-'))
  t.after(()=>rm(cwd,{recursive:true,force:true}))
  const result=await PartnerAgentRuntime.prototype.persistInbound.call({defaultCwd:cwd},{cwd},{text:'请读这个文件',attachments:[{kind:'file',name:'资料.txt',data:Buffer.from('hello'),mediaType:'text/plain'}]})
  const visible=result.content[0].text
  assert.ok(visible.indexOf('已保存')<visible.indexOf('请读这个文件'))
  const saved=visible.match(/已保存：(.+)（text\/plain）/)[1]
  assert.equal(await readFile(saved,'utf8'),'hello')
  assert.equal(result.content.length,1)
})
