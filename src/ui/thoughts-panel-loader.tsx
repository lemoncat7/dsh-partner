import {useEffect,useState,type ComponentProps} from 'react'
import type {ThoughtsPanel as Settings} from './thoughts-panel.js'
declare const require: {async(path:string):Promise<unknown>}
type Module={ThoughtsPanel:typeof Settings}
let pending:Promise<Module>|undefined
function load():Promise<Module>{
 return pending??=require.async('./client.activities.js').then(value=>{
  const module=value as Module
  if(typeof module?.ThoughtsPanel!=='function')throw new Error('活动记录加载失败')
  return module
 }).catch(error=>{pending=undefined;throw error})
}
export function ThoughtsPanel(props:ComponentProps<typeof Settings>):JSX.Element{
 const [module,setModule]=useState<Module>(),[failed,setFailed]=useState(false),[attempt,setAttempt]=useState(0)
 useEffect(()=>{let active=true;setFailed(false);void load().then(m=>{if(active)setModule(m)},()=>{if(active)setFailed(true)});return()=>{active=false}},[attempt])
 if(module){const Component=module.ThoughtsPanel;return <Component {...props}/>}
 return failed?<p role="alert">活动记录加载失败。<button onClick={()=>setAttempt(n=>n+1)}>重新加载</button></p>:<p role="status">正在加载活动记录…</p>
}
