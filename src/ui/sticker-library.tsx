import { useEffect, useState } from 'react'
import { api, PARTNER_API } from '../client-api.js'
import type { Sticker } from '../chat/stickers.js'
import { WorkspaceDialog, errorMessage } from './workspace-components.js'
import { FormField as Field } from './partner-components.js'
import { StickerImport } from './sticker-import.js'

export function StickerLibraryDialog({companionId,close}:{companionId:string;close():void}):JSX.Element {
  const path=`/companions/${encodeURIComponent(companionId)}/stickers`
  const [items,setItems]=useState<Sticker[]>([]),[error,setError]=useState<string>(),[busy,setBusy]=useState(false),[loaded,setLoaded]=useState(false)
  const [name,setName]=useState(''),[tags,setTags]=useState(''),[file,setFile]=useState<File>(),[query,setQuery]=useState(''),[deleting,setDeleting]=useState<string>()
  const load=async()=>{const data=await api<{items:Sticker[]}>(path);setItems(data.items);setLoaded(true)}
  useEffect(()=>{let active=true;void api<{items:Sticker[]}>(path).then(data=>{if(active){setItems(data.items);setLoaded(true)}}).catch(e=>{if(active)setError(errorMessage(e))});return()=>{active=false}},[path])
  const upload=async()=>{
    if(!file||busy)return
    setBusy(true);setError(undefined)
    try{
      if(file.size>2*1024*1024)throw new Error('请选择 2 MB 以内的图片')
      const base64=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(new Error('图片读取失败'));reader.onload=()=>resolve(String(reader.result).split(',')[1]??'');reader.readAsDataURL(file)})
      await api(path,{method:'POST',body:JSON.stringify({name,tags:tags.split(/[,，]/).map(t=>t.trim()).filter(Boolean),base64})})
      setName('');setTags('');setFile(undefined);await load()
    }catch(e){setError(errorMessage(e))}finally{setBusy(false)}
  }
  const remove=async(id:string)=>{setBusy(true);setError(undefined);try{await api(`${path}/${id}`,{method:'DELETE'});setDeleting(undefined);await load()}catch(e){setError(errorMessage(e))}finally{setBusy(false)}}
  const filtered=items.filter(item=>`${item.name} ${item.tags.join(' ')}`.includes(query.trim()))
  return <WorkspaceDialog title="表情库" eyebrow="CHAT EXPRESSIONS" detail="伙伴按语境选择，不固定每轮发送。管理表情立即生效；聊天方式开关仍需保存身份。" close={()=>{if(!busy)close()}} width="wide" className="dsh-partner-character-dialog">
    {error&&<p role="alert" className="dsh-partner-inline-error">{error}</p>}
    <details className="dsh-partner-sticker-source"><summary>大肥鱼的表情从哪里来？</summary><p>qq-bridge 通过 SnowLuma 的 fetch_custom_face_detail 读取登录账号的 QQ 收藏，再用名称、备注和标签选图。它没有随项目附带一套“大肥鱼表情包”。这里提供本地收藏导入，暂不连接 QQ；现有内置图片来自 Volpeon 的 Blobfox 小狐狸表情集，按 Apache-2.0 授权随插件提供，使用时无需联网下载。</p><a href="https://github.com/Derpyu520/qq-bridge/blob/a49877f4e58d04e47532d44b803360d0f001160d/src/sticker-lib.js" target="_blank" rel="noreferrer">查看来源实现</a></details>
    <p className="dsh-partner-character-hint">内置精选 20 张小狐狸表情 · <a href="https://volpeon.ink/emojis/blobfox/" target="_blank" rel="noreferrer">作者 Volpeon / Blobfox</a> · Apache-2.0</p>
    <Field label="查找表情"><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="名称或情绪标签"/></Field>
    {!loaded?<p role="status">正在读取表情库…</p>:<><p>{items.filter(i=>i.builtin).length} 张内置 · {items.filter(i=>!i.builtin).length}/50 张自定义</p><div className="dsh-partner-sticker-grid">{filtered.map(item=><figure key={item.id}>
      <img src={`${PARTNER_API}${path}/${item.id}`} alt={item.name} loading="lazy"/><figcaption><strong>{item.name}</strong><small>{item.tags.join(' · ')}</small></figcaption>
      {item.builtin?<small>内置</small>:deleting===item.id?<div><span>移出表情库？</span><button type="button" disabled={busy} onClick={()=>void remove(item.id)}>确认移除</button><button type="button" disabled={busy} onClick={()=>setDeleting(undefined)}>取消</button></div>:<button type="button" disabled={busy} onClick={()=>setDeleting(item.id)} aria-label={`移除 ${item.name}`}>移除</button>}
    </figure>)}</div>{!filtered.length&&<p>没有匹配的表情。</p>}</>}
    <StickerImport path={path} busy={busy} setBusy={setBusy} onImported={load}/>
    <details className="dsh-partner-sticker-upload"><summary>添加自己的表情</summary><p>PNG、JPEG、GIF 或 WebP，每张最多 2 MB。名称和标签帮助伙伴找到合适的表情；不需要填写复杂参数。</p>
      <Field label="图片"><input key={file?.name??'empty'} type="file" accept="image/png,image/jpeg,image/gif,image/webp" disabled={busy} onChange={e=>{const value=e.target.files?.[0];setFile(value);if(value&&!name)setName(value.name.replace(/\.[^.]+$/,'').slice(0,60))}}/></Field>
      <Field label="表情名称"><input value={name} maxLength={60} disabled={busy} onChange={e=>setName(e.target.value)} placeholder="例如：气鼓鼓"/></Field>
      <Field label="情绪标签" hint="可选，最多 8 个，用逗号分隔。例如：嘴硬、生气、撒娇。"><input value={tags} maxLength={248} disabled={busy} onChange={e=>setTags(e.target.value)}/></Field>
      <button type="button" disabled={busy||!file||!name.trim()} onClick={()=>void upload()}>{busy?'正在保存…':'添加表情'}</button>
    </details>
  </WorkspaceDialog>
}
