import { useState } from 'react'
import { api } from '../client-api.js'
import { matchStickerNote, parseStickerNotes, type StickerImportNote } from '../chat/sticker-import.js'
import { FormField as Field } from './partner-components.js'
import { errorMessage } from './workspace-components.js'

export function StickerImport({path,busy,setBusy,onImported}:{path:string;busy:boolean;setBusy(value:boolean):void;onImported():Promise<void>}):JSX.Element {
  const [notes,setNotes]=useState<StickerImportNote[]>([])
  const [files,setFiles]=useState<File[]>([])
  const [status,setStatus]=useState('')
  const [error,setError]=useState<string>()
  const loadNotes=async(file?:File)=>{
    if(!file)return
    setError(undefined)
    try {if(file.size>1024*1024)throw new Error('收藏资料不能超过 1 MB');setNotes(parseStickerNotes(await file.text()))}
    catch(e){setNotes([]);setError(errorMessage(e))}
  }
  const importImages=async()=>{
    if(busy||!files.length)return
    setBusy(true);setError(undefined);setStatus('正在导入…')
    const remaining:File[]=[];const failures:string[]=[];let added=0
    for(const file of files){
      try{
        if(file.size>2*1024*1024)throw new Error('超过 2 MB')
        const base64=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(new Error('图片读取失败'));reader.onload=()=>resolve(String(reader.result).split(',')[1]??'');reader.readAsDataURL(file)})
        const {name,tags}=matchStickerNote(file.name,notes)
        await api(path,{method:'POST',body:JSON.stringify({name,tags,base64})});added++
      }catch(e){remaining.push(file);failures.push(`${file.name}：${errorMessage(e)}`)}
    }
    setFiles(remaining);setStatus(`已导入 ${added} 张${remaining.length?`，${remaining.length} 张失败，可处理后重试`:'，现在可以在表情库中使用'}`)
    if(failures.length)setError(failures.join('\n'))
    try{await onImported()}catch(e){setError(errorMessage(e))}finally{setBusy(false)}
  }
  return <details className="dsh-partner-sticker-upload">
    <summary>导入收藏图片</summary>
    <p>可批量选择从 QQ 收藏保存的图片。若已有 qq-bridge，还可选择它的 state/stickers.json，匹配图片的名称和情绪标签。资料文件不包含图片，图片文件名需与资料中的 ID 或 MD5 相同。</p>
    <fieldset disabled={busy} className="dsh-partner-character-fields">
      <Field label="收藏资料（可选）" hint="只读取名称、标签和匹配标识，不连接 QQ，也不访问资料中的网址。"><input type="file" accept="application/json,.json" onChange={e=>void loadNotes(e.target.files?.[0])}/></Field>
      {notes.length>0&&<p>已读取 {notes.length} 条收藏资料。</p>}
      <Field label="选择图片" hint="PNG、JPEG、GIF、WebP，每张最多 2 MB；每位伙伴最多 50 张自定义表情。"><input type="file" multiple accept="image/png,image/jpeg,image/gif,image/webp" onChange={e=>{const selected=Array.from(e.target.files??[]);setStatus('');setError(selected.length>50?'一次最多选择 50 张图片':undefined);setFiles(selected.length>50?[]:selected)}}/></Field>
      {files.length>0&&<ul className="dsh-partner-sticker-import-preview">{files.map((file,i)=>{const note=matchStickerNote(file.name,notes);return <li key={`${file.name}-${i}`}><strong>{note.name}</strong><span>{note.matched?'已匹配收藏资料':'使用文件名'}{note.tags.length?` · ${note.tags.join('、')}`:''}</span></li>})}</ul>}
      <button type="button" disabled={!files.length} onClick={()=>void importImages()}>{busy?'正在导入…':`导入${files.length?` ${files.length} 张`:''}图片`}</button>
    </fieldset>
    {status&&<p role="status">{status}</p>}
    {error&&<p role="alert" className="dsh-partner-inline-error" style={{whiteSpace:'pre-wrap'}}>{error}</p>}
  </details>
}
