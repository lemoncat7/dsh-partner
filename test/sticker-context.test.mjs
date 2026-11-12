import test from 'node:test'
import assert from 'node:assert/strict'
import {renderStickerCandidates} from '../lib/chat/sticker-context.js'
test('real catalogue stays bounded and matching tags are preferred without inventing IDs',()=>{
 const items=Array.from({length:48},(_,i)=>({id:'qq-custom-'+i,name:'收藏 '+i,tags:[],size:0,mediaType:'image/gif'}))
 items[47].tags=['抱抱']
 const text=renderStickerCandidates(items,'给你抱抱')
 const result=JSON.parse(text.split('\n')[1]);assert.equal(result.length,8);assert.equal(result[0].id,'qq-custom-47')
 assert.ok(result.every(r=>items.some(i=>i.id===r.id)));assert.equal(renderStickerCandidates([],''),'')
 assert.equal(renderStickerCandidates([{...items[0],id:'invalid/id'}],''),'')
})
