/** QQ-bridge exports contain metadata, not image bytes. Never follow imported URLs. */
export interface StickerImportNote { keys: string[]; name: string; tags: string[] }
const clean = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/[\s\u0000-\u001f\u007f\u200b-\u200f]+/g, ' ').trim().slice(0,max) : ''
export function parseStickerNotes(text: string): StickerImportNote[] {
  if (text.length > 1024 * 1024) throw new Error('收藏资料不能超过 1 MB')
  const raw: unknown = JSON.parse(text.replace(/^\uFEFF/, ''))
  if (!Array.isArray(raw) || raw.length > 2000) throw new Error('请选择 qq-bridge 的 state/stickers.json（最多 2000 条资料）')
  return raw.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return []
    const row=entry as Record<string, unknown>
    const keys=[row.id,row.resId,row.emoji_id,row.md5].map(k=>clean(k,200).toLowerCase()).filter(Boolean)
    if (!keys.length) return []
    const name=clean(row.desc,60)||clean(row.localNote,60)
    const tags=Array.isArray(row.tags)?[...new Set(row.tags.map(t=>clean(t,30)).filter(Boolean))].slice(0,8):[]
    return [{keys,name,tags}]
  })
}
export function matchStickerNote(filename: string, notes: StickerImportNote[]): {name:string;tags:string[];matched:boolean} {
  const stem=filename.replace(/\.[^.]+$/,'')
  const key=stem.toLowerCase()
  const matches=notes.filter(note=>note.keys.includes(key))
  const note=matches.length===1?matches[0]:undefined
  return {name:note?.name||clean(stem,60)||'未命名表情',tags:note?.tags??[],matched:!!note}
}
