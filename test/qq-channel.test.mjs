import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer } from 'ws'
import { once } from 'node:events'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OneBotConnection } from '../lib/channels/qq/connection.js'
import { oneBotMessage } from '../lib/channels/qq/message.js'
import { qqMediaUrl } from '../lib/channels/qq/transport.js'
import { DirectTransport, directConfig } from '../lib/channels/direct/transport.js'
const bot='12345678', peer='87654321'
const event=(extra={})=>({post_type:'message',message_type:'private',sub_type:'friend',self_id:Number(bot),user_id:Number(peer),message_id:-123,time:Math.floor(Date.now()/1000),message:[{type:'text',data:{text:'你好'}}],...extra})
async function server(t,handler) {
  const wss=new WebSocketServer({host:'127.0.0.1',port:0});await once(wss,'listening')
  const requests=[],connections=[]
  wss.on('connection',(ws,req)=>{
    connections.push({ws,token:new URL(req.url,'http://local').searchParams.get('access_token')})
    ws.on('message',async data=>{
      const r=JSON.parse(data);requests.push(r)
      const value=handler?await handler(r,ws):undefined
      if(value===false)return
      const response=value??(r.action==='get_login_info'?{user_id:Number(bot)}:r.action==='get_status'?{online:true,good:true}:r.action==='get_friend_list'?[{user_id:Number(peer)}]:r.action==='upload_private_file'?{file_id:'f1'}:{message_id:-456})
      if(ws.readyState===1)ws.send(JSON.stringify({status:'ok',retcode:0,data:response,echo:r.echo}))
    })
  })
  t.after(async()=>{for(const c of wss.clients)c.terminate();await new Promise(resolve=>wss.close(resolve))})
  return {url:`ws://127.0.0.1:${wss.address().port}`,requests,connections,wss}
}
test('QQ requires forward WS, separate token and valid target',()=>{
  assert.equal(directConfig({platform:'qq',baseUrl:'ws://snowluma:3001'}).baseUrl,'ws://snowluma:3001')
  for(const baseUrl of ['http://snowluma:3000','ws://user:secret@host','ws://host?access_token=secret','file:///tmp'])assert.throws(()=>directConfig({platform:'qq',baseUrl}))
  assert.throws(()=>directConfig({platform:'qq',baseUrl:'ws://host',targetId:'group:1'}))
})
test('private events preserve signed IDs and mixed text/media; ignore groups, strangers and self echoes',()=>{
  const m=oneBotMessage(event({message:[{type:'text',data:{text:'看看'}},{type:'image',data:{url:'https://gchat.qpic.cn/x'}}]}),bot)
  assert.equal(m.id,`qq:${bot}:${peer}:-123`);assert.equal(m.text,'看看');assert.equal(m.media.length,1)
  for(const extra of [{message_type:'group'},{post_type:'message_sent'},{user_id:Number(bot)},{self_id:999999},{sub_type:'group'},{sub_type:'other'}])assert.equal(oneBotMessage(event(extra),bot),undefined)
  assert.equal(oneBotMessage(event(),bot,'999999'),undefined)
})
test('one WS receives events and routes literal text replies without CQ execution',async t=>{
  const s=await server(t),api=new DirectTransport({platform:'qq',baseUrl:s.url,targetId:''},'ws-secret',{accountId:bot,peerId:''});t.after(()=>api.close())
  assert.equal((await api.validate()).accountId,bot)
  s.connections[0].ws.send(JSON.stringify(event()))
  const batch=await api.poll(undefined,AbortSignal.timeout(3000),100)
  assert.equal(batch.messages[0].text,'你好')
  const target=api.forTarget(peer,{accountId:bot,peerId:peer})
  assert.equal(target.progress(peer),undefined)
  await target.sendText(peer,'[CQ:at,qq=all] 原样发送',undefined)
  assert.equal(s.connections.length,1);assert.equal(s.connections[0].token,'ws-secret')
  assert.deepEqual(s.requests.at(-1).params.message,[{type:'text',data:{text:'[CQ:at,qq=all] 原样发送'}}])
  await assert.rejects(target.sendText('999999','wrong target',undefined),/不匹配/)
})
test('echo correlates concurrent responses arriving out of order',async t=>{
  const s=await server(t,async r=>{if(r.action==='slow')await new Promise(resolve=>setTimeout(resolve,40));return r.action})
  const c=new OneBotConnection(s.url,'secret');t.after(()=>c.close())
  assert.deepEqual(await Promise.all([c.call('slow',{}),c.call('fast',{})]),['slow','fast'])
})
test('disconnect rejects unacknowledged send without replay; next read reconnects',async t=>{
  const s=await server(t,(r,ws)=>{if(r.action==='send_private_msg'){ws.close();return false}})
  const c=new OneBotConnection(s.url,'secret');t.after(()=>c.close())
  await assert.rejects(c.call('send_private_msg',{}),/断开/)
  await c.call('get_status',{})
  assert.equal(s.requests.filter(r=>r.action==='send_private_msg').length,1);assert.equal(s.connections.length,2)
})
test('account change, offline account and missing friend fail before sending',async t=>{
  let mode='switch'
  const s=await server(t,r=>r.action==='get_login_info'?{user_id:mode==='switch'?999999:Number(bot)}:r.action==='get_status'?{online:mode!=='offline',good:true}:r.action==='get_friend_list'?[]:undefined)
  const api=new DirectTransport({platform:'qq',baseUrl:s.url,targetId:peer},'secret',{accountId:bot,peerId:peer});t.after(()=>api.close())
  await assert.rejects(api.sendText(peer,'hello',undefined),/账号/)
  mode='offline';await assert.rejects(api.sendText(peer,'hello',undefined),/尚未上线/)
  mode='friend';await assert.rejects(api.sendText(peer,'hello',undefined),/好友/)
  assert.equal(s.requests.filter(r=>r.action==='send_private_msg').length,0)
})
test('text plus sticker both send; attachments carry bytes across container boundaries',async t=>{
  const s=await server(t),api=new DirectTransport({platform:'qq',baseUrl:s.url,targetId:peer},'secret',{accountId:bot,peerId:peer});t.after(()=>api.close())
  const dir=await mkdtemp(join(tmpdir(),'qq-channel-'));t.after(()=>rm(dir,{recursive:true,force:true}))
  const path=join(dir,'sticker.png');await writeFile(path,Buffer.from([137,80,78,71,13,10,26,10,0]))
  await api.sendText(peer,'先发文字',undefined)
  await api.sendAttachment(peer,{path,name:'sticker.png',mediaType:'image/png',kind:'image'},undefined)
  const sent=s.requests.filter(r=>r.action==='send_private_msg');assert.equal(sent.length,2)
  assert.equal(sent[0].params.message[0].type,'text');assert.equal(sent[1].params.message[0].type,'image');assert.match(sent[1].params.message[0].data.file,/^base64:\/\//)
  const txt=join(dir,'note.txt');await writeFile(txt,'文件内容')
  await api.sendAttachment(peer,{path:txt,name:'note.txt',mediaType:'text/plain',kind:'file'},undefined)
  assert.equal(s.requests.at(-1).action,'upload_private_file');assert.match(s.requests.at(-1).params.file,/^base64:\/\//)
})
test('API failure is not delivery; cancellation stops idle receive',async t=>{
  const s=await server(t,(r,ws)=>{if(r.action==='send_private_msg'){ws.send(JSON.stringify({echo:r.echo,status:'failed',retcode:100}));return false}})
  const c=new OneBotConnection(s.url,'secret');t.after(()=>c.close())
  await assert.rejects(c.call('send_private_msg',{}),/retcode 100/)
  await assert.rejects(c.read(AbortSignal.timeout(30),20000))
})
test('media URLs reject arbitrary hosts, credentials and local files',()=>{
  assert.equal(qqMediaUrl('https://multimedia.nt.qq.com/x').hostname,'multimedia.nt.qq.com')
  for(const url of ['file:///etc/passwd','http://127.0.0.1:5099/x','https://gchat.qpic.cn.evil.example/x','https://u:p@gchat.qpic.cn/x','https://qq.com/x'])assert.throws(()=>qqMediaUrl(url))
})
