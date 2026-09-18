import test from 'node:test'
import assert from 'node:assert/strict'
import { DirectDispatcher } from '../lib/channels/direct/dispatcher.js'
import { ChannelManager } from '../lib/channels/manager.js'
import { DirectTransport } from '../lib/channels/direct/transport.js'

const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}}
const tick=()=>new Promise(r=>setImmediate(r))

test('steering runs after input preparation but before active reply finishes; queue waits for all prior work',async()=>{
  const controller=new AbortController(),dispatcher=new DirectDispatcher(controller.signal,e=>assert.fail(e)),events=[]
  const prep=deferred(),finish=deferred()
  dispatcher.enqueue(['first'],'queue',async ready=>{events.push('first');await prep.promise;ready();await finish.promise;events.push('finished')})
  dispatcher.enqueue(['steer'],'steer',async ready=>{events.push('steer');ready()})
  dispatcher.enqueue(['queued'],'queue',async ready=>{events.push('queued');ready()})
  await tick();assert.deepEqual(events,['first']);assert.equal(dispatcher.has('queued'),true)
  prep.resolve();await tick();assert.deepEqual(events,['first','steer'])
  finish.resolve();await dispatcher.drain();assert.deepEqual(events,['first','steer','finished','queued'])
  assert.equal(dispatcher.busy,false);assert.equal(dispatcher.has('first'),false)
})

test('abort drops unstarted work; failure is observed and outstanding identifiers are released',async()=>{
  const abort=new AbortController(),gate=deferred(),errors=[]
  const dispatcher=new DirectDispatcher(abort.signal,e=>{errors.push(e);abort.abort()})
  dispatcher.enqueue(['first'],'queue',async ready=>{ready();await gate.promise;throw Error('failed')})
  dispatcher.enqueue(['queued'],'queue',async()=>assert.fail('must not execute after failure'))
  await tick();gate.resolve();await dispatcher.drain()
  assert.equal(errors.length,1);assert.equal(dispatcher.has('queued'),false)
  assert.throws(()=>dispatcher.enqueue(['late'],'steer',async()=>{}))
})

function fixture(mode) {
  const channel={id:'c',platform:'matrix',accountId:'bot',companionId:'p',enabled:true,direct:{baseUrl:'http://local',targetId:'room',peerId:'peer',cursor:'old'}}
  const state={channels:[channel],companions:[{id:'p'}],pairings:[{channelId:'c',userId:'peer',status:'approved',directTargetId:'room'}],recentReceipts:[]}
  const controller=new AbortController(),events=[],gate=deferred()
  const store={snapshot:()=>structuredClone(state),update:async fn=>fn(state)}
  let active=false
  const agents={
    steer:async(_c,_channel,_peer,input)=>{events.push(['steer',input.text,input.attachments.length]);if(!active)return false;gate.resolve();return true},
    reply:async(_c,_channel,_peer,input)=>{events.push(['reply',input.text]);active=true;await gate.promise;active=false;return {text:'done',attachments:[]}},
  }
  const manager=new ChannelManager({settings:{get:()=>({busyEnter:mode})}},store,{read:async()=>({baseUrl:'http://local',botToken:'test'})},agents,'/tmp')
  return {channel,state,controller,events,gate,store,manager,agents}
}

for(const platform of ['matrix','mattermost'])test(`${platform} keeps polling during execution and follows steer setting`,{timeout:12000},async t=>{
  const f=fixture('steer');f.channel.platform=platform;let polls=0
  t.mock.method(DirectTransport.prototype,'validate',async()=>({accountId:'bot',peerId:'peer'}))
  t.mock.method(DirectTransport.prototype,'poll',async()=>{
    polls++
    if(polls===1)return {cursor:'first',messages:[{id:'first',sender:'peer',text:'first'}]}
    if(polls===2)return {cursor:'first',messages:[]}
    if(polls===3){assert.ok(f.events.some(e=>e[0]==='reply'));return {cursor:'second',messages:[{id:'second',sender:'peer',text:'补充',media:[{source:'mxc://local/file'}]}]}}
    return {cursor:'second',messages:[]}
  })
  t.mock.method(DirectTransport.prototype,'receiveAttachments',async()=>[{kind:'file',name:'a',data:Buffer.from('a')}])
  t.mock.method(DirectTransport.prototype,'sendText',async()=>{})
  t.mock.method(DirectTransport.prototype,'progress',()=>({typing:async()=>{},create:async()=> 'p',edit:async()=>{},send:async()=>{}}))
  const update=f.store.update;f.store.update=async fn=>{await update(fn);if(f.state.channels[0].direct.cursor==='second')f.controller.abort()}
  await f.manager.directLoop(f.channel,f.controller.signal)
  assert.deepEqual(f.events.filter(e=>e[0]==='reply'),[['reply','first']])
  assert.deepEqual(f.events.filter(e=>e[0]==='steer').at(-1),['steer','补充',1])
  assert.ok(f.state.recentReceipts.includes('c:second'))
})

test('queue setting never calls steer and serializes replies while polling continues', {timeout:12000},async t=>{
  const f=fixture('queue');let polls=0
  t.mock.method(DirectTransport.prototype,'validate',async()=>({accountId:'bot',peerId:'peer'}))
  t.mock.method(DirectTransport.prototype,'poll',async()=>{
    polls++
    if(polls===1)return {cursor:'first',messages:[{id:'first',sender:'peer',text:'first'}]}
    if(polls===2)return {cursor:'first',messages:[]}
    if(polls===3)return {cursor:'second',messages:[{id:'second',sender:'peer',text:'second'}]}
    if(polls===5){assert.deepEqual(f.events,[['reply','first']]);assert.equal(f.state.recentReceipts.includes('c:second'),false);f.gate.resolve()}
    return {cursor:'second',messages:[]}
  })
  t.mock.method(DirectTransport.prototype,'sendText',async()=>{})
  t.mock.method(DirectTransport.prototype,'progress',()=>({typing:async()=>{},create:async()=> 'p',edit:async()=>{},send:async()=>{}}))
  const update=f.store.update;f.store.update=async fn=>{await update(fn);if(f.state.channels[0].direct.cursor==='second')f.controller.abort()}
  await f.manager.directLoop(f.channel,f.controller.signal)
  assert.deepEqual(f.events,[['reply','first'],['reply','second']])
})

test('question answers bypass the queue while a model turn is waiting', {timeout:12000},async t=>{
  const f=fixture('queue');let polls=0,answer
  f.agents.reply=async()=>{
    f.manager.pendingQuestions.set('session',{sessionId:'session',channelId:'c',userId:'peer',questions:[{id:'q',question:'选择',options:[{label:'A'},{label:'B'}]}],resolve:value=>{answer=value;f.gate.resolve()},reject:()=>f.gate.resolve(),detachAbort:()=>{}})
    await f.gate.promise
    return {text:'收到答案',attachments:[]}
  }
  t.mock.method(DirectTransport.prototype,'validate',async()=>({accountId:'bot',peerId:'peer'}))
  t.mock.method(DirectTransport.prototype,'poll',async()=>{
    polls++
    if(polls===1)return {cursor:'first',messages:[{id:'first',sender:'peer',text:'first'}]}
    if(polls===2)return {cursor:'first',messages:[]}
    if(polls===3)return {cursor:'answer',messages:[{id:'answer',sender:'peer',text:'2'}]}
    return {cursor:'answer',messages:[]}
  })
  t.mock.method(DirectTransport.prototype,'sendText',async()=>{})
  t.mock.method(DirectTransport.prototype,'progress',()=>({typing:async()=>{},create:async()=> 'p',edit:async()=>{},send:async()=>{}}))
  const update=f.store.update;f.store.update=async fn=>{await update(fn);if(f.state.channels[0].direct.cursor==='answer')f.controller.abort()}
  await f.manager.directLoop(f.channel,f.controller.signal)
  assert.deepEqual(answer.answers[0].selected,['B'])
  assert.ok(f.state.recentReceipts.includes('c:answer'))
  assert.equal(f.manager.pendingQuestions.size,0)
})
