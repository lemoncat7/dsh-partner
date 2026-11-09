import {useEffect,useState,type ComponentProps} from 'react'
import type {TtsSettings as Settings} from './tts-settings.js'
declare const require: {async(path:string):Promise<unknown>}
type Module={TtsSettings:typeof Settings}
let pending:Promise<Module>|undefined
function load():Promise<Module>{
 return pending??=require.async('./client.tts.js').then(value=>{
  const module=value as Module
  if(typeof module?.TtsSettings!=='function')throw new Error('语音模块加载失败')
  return module
 }).catch(error=>{pending=undefined;throw error})
}
export function TtsSettings(props:ComponentProps<typeof Settings>):JSX.Element{
 const [module,setModule]=useState<Module>(),[failed,setFailed]=useState(false),[attempt,setAttempt]=useState(0)
 useEffect(()=>{let active=true;setFailed(false);void load().then(m=>{if(active)setModule(m)},()=>{if(active)setFailed(true)});return()=>{active=false}},[attempt])
 if(module){const Component=module.TtsSettings;return <Component {...props}/>}
 return failed?<p role="alert">语音模块加载失败。<button onClick={()=>setAttempt(n=>n+1)}>重新加载</button></p>:<p role="status">正在加载语音设置…</p>
}
