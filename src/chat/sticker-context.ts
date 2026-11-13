import type {Sticker} from './stickers.js'

/** Model-facing pages only. Full catalogues stay in the adapter for lookup and deduplication. */
export function stickerPageBounds(offset=0,limit=12):{offset:number;limit:number}{
 if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>24)throw Error('表情分页需要 offset >= 0，limit 为 1–24')
 return {offset,limit}
}
export function stickerPage(items:readonly Sticker[],offset=0,limit=12){
 stickerPageBounds(offset,limit)
 return {items:items.slice(offset,offset+limit).map(s=>({id:s.id,name:s.name.slice(0,80),tags:s.tags})),total:items.length,offset,nextOffset:offset+limit<items.length?offset+limit:null}
}

/** Only real tags are ambient context. IDs, names and image URLs remain on demand. */
export function renderStickerTags(items:readonly Pick<Sticker,'tags'>[]):string {
 const tags=[...new Set(items.flatMap(item=>item.tags).map(tag=>tag.trim()).filter(Boolean))].sort()
 return tags.length ? '当前表情收藏的标签（仅检索资料）：'+JSON.stringify(tags)+'\n想发表情时可按标签用 partner_stickers list 的 query 查找，inspect 按需预览；已有工具返回的真实 ID 可直接使用，不要求每轮查询或发送。' : ''
}
