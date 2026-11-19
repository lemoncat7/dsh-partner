import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { imageReferenceId } from './image-references.js'

const extensions = {'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif'} as const

export function inboundDay(at: number, timeZone = 'Asia/Shanghai'): string {
  return new Intl.DateTimeFormat('sv-SE',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(at)
}

/** Reuse the dated file if present. The next day can be archived independently. */
export async function archiveInboundImage(cwd: string, day: string, ref: ImageAttachmentRef, store: AttachmentStore, original?: Uint8Array): Promise<string> {
  const relative=join('inbound',day,imageReferenceId(ref)+'.'+extensions[ref.mediaType])
  const path=join(cwd,relative)
  const existing=await lstat(path).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error})
  if(existing){
    if(!existing.isFile())throw Error('图片归档位置无效')
    return relative
  }
  const data=original??(await store.readImage(ref)).data
  await writeFileAtomic(path,data,{mode:0o600,dirMode:0o700})
  return relative
}
