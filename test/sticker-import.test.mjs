import test from 'node:test'
import assert from 'node:assert/strict'
import {parseStickerNotes,matchStickerNote} from '../lib/chat/sticker-import.js'

test('QQ collection metadata matches exact IDs or hashes, retaining useful labels only',()=>{
  const notes=parseStickerNotes('\uFEFF'+JSON.stringify([{id:'face-1',md5:'ABC123',desc:'开心\n一下',localNote:'不覆盖原备注',tags:['开心','开心','得意'],url:'http://127.0.0.1/private',useCount:200},{emoji_id:'face-2',localNote:'好困',tags:[]}]))
  assert.deepEqual(matchStickerNote('abc123.GIF',notes),{name:'开心 一下',tags:['开心','得意'],matched:true})
  assert.equal(matchStickerNote('face-2.png',notes).name,'好困')
  assert.deepEqual(matchStickerNote('abc123-copy.png',notes),{name:'abc123-copy',tags:[],matched:false})
  assert.equal(JSON.stringify(notes).includes('127.0.0.1'),false)
})
test('bad collections fail visibly; incomplete and ambiguous records do not mislabel pictures',()=>{
  for(const text of ['{}','not json',' '.repeat(1024*1024+1),JSON.stringify(Array(2001).fill({}))])assert.throws(()=>parseStickerNotes(text))
  assert.deepEqual(parseStickerNotes('[null,12,{}, {"url":"https://example.com/a.png"}]'),[])
  const notes=parseStickerNotes(JSON.stringify([{id:'a',desc:'甲'},{id:'a',desc:'乙'}]))
  assert.equal(matchStickerNote('a.png',notes).matched,false)
})
