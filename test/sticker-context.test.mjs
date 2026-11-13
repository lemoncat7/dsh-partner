import test from 'node:test'
import assert from 'node:assert/strict'
import {renderStickerTags,stickerPage} from '../lib/chat/sticker-context.js'
import {qqCustomCatalog,qqStickerTags} from '../lib/channels/qq/catalog.js'
import {qqStickerAdapter} from '../lib/channels/qq/sticker-adapter.js'
import {QqStickerCache} from '../lib/channels/qq/sticker-cache.js'
const signal=new AbortController().signal
const channel={id:'qq',platform:'qq',enabled:true,companionId:'c',accountId:'12345678',updatedAt:1}
test('ambient tags are deduplicated and complete, without per-image metadata or fixed vocabulary',()=>{
 const items=Array.from({length:80},(_,i)=>({id:'secret-id-'+i,name:'secret-name-'+i,tags:['开心','新标签'+i],size:0,mediaType:'image/gif'}))
 const text=renderStickerTags(items),tags=JSON.parse(text.split('：')[1].split('\n')[0])
 assert.equal(tags.length,81);assert.ok(tags.includes('新标签79'));assert.equal(tags.filter(t=>t==='开心').length,1)
 assert.doesNotMatch(text,/secret-|http|QQ原生/);assert.equal(renderStickerTags([]),'')
 const page=stickerPage(items);assert.equal(page.items.length,12);assert.equal(page.total,80);assert.equal(page.nextOffset,12)
 assert.equal(stickerPage(items,72).nextOffset,null);assert.equal(stickerPage(items,72).items[7].id,'secret-id-79')
 for(const [offset,limit] of [[-1,12],[0,25],[0,0],[NaN,12],[0,1.5]])assert.throws(()=>stickerPage(items,offset,limit))
})
test('legacy QQ notes produce searchable real tags, including tags after the old 48-item cutoff',async()=>{
 assert.deepEqual(qqStickerTags('开心 开心，得意、嘿嘿；困困'),['开心','得意','嘿嘿','困困'])
 assert.deepEqual(qqStickerTags('http://example.com qq-custom-123'),[])
 const faces=qqCustomCatalog(Array.from({length:80},(_,i)=>({emoji_id:'id-'+i,desc:'开心 标签'+i})))
 const adapter=qqStickerAdapter(channel,{},async kind=>{assert.equal(kind,'image');return faces})
 const all=await adapter.list('c','',signal,'image');assert.equal(all.length,80)
 assert.ok(renderStickerTags(all).includes('标签79'));assert.doesNotMatch(renderStickerTags(all),/QQ原生|QQ 收藏/)
 const found=await adapter.list('c','标签79',signal,'image');assert.equal(found[0].id,'qq-custom-'+faces[79].id)
})
test('collection mutations invalidate shared tags, stay channel isolated and late old responses cannot replace fresh state',async()=>{
 let rows=[{emoji_id:'one',desc:'开心'}],loads=0,clock=0
 const cache=new QqStickerCache(async()=>{loads++;return qqCustomCatalog(rows)},()=>clock)
 const adapter=()=>qqStickerAdapter(channel,{},kind=>cache.get('qq',1,kind))
 const tags=async()=>renderStickerTags(await adapter().list('c','',signal,'image'))
 assert.match(await tags(),/开心/);await tags();assert.equal(loads,1)
 await cache.get('other',1,'image');rows=[{emoji_id:'one',desc:'害羞'},{emoji_id:'two',desc:'开心'}];cache.invalidate('qq')
 assert.match(await tags(),/害羞/);assert.match(await tags(),/开心/);assert.equal(loads,3)
 await cache.get('other',1,'image');assert.equal(loads,3)
 rows=[{emoji_id:'one',desc:'害羞'}];cache.invalidate('qq');assert.doesNotMatch(await tags(),/开心/)
 rows=[];cache.invalidate('qq');assert.equal(await tags(),'')
 rows=[{emoji_id:'external',desc:'外部添加'}];clock+=300001;assert.match(await tags(),/外部添加/)
 let release,n=0
 const race=new QqStickerCache(()=>++n===1?new Promise((_,reject)=>{release=reject}):Promise.resolve(qqCustomCatalog(rows)))
 const old=race.get('qq',1,'image');await Promise.resolve();race.invalidate('qq')
 const fresh=await race.get('qq',1,'image');release(Error('old failed'));await assert.rejects(old)
 assert.equal(await race.get('qq',1,'image'),fresh);assert.equal(n,2)
})
