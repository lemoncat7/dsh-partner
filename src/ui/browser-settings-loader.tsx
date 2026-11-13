import {useEffect,useState,type ComponentProps} from 'react'
import type {BrowserSettings as Settings} from './browser-settings.js'
declare const require: {async(path:string):Promise<unknown>}
type Module={BrowserSettings:typeof Settings}
let pending:Promise<Module>|undefined
function load():Promise<Module>{
 return pending??=require.async('./client.browser.js').then(value=>{
  const module=value as Module
  if(typeof module?.BrowserSettings!=='function')throw new Error('浏览器模块加载失败')
  return module
 }).catch(error=>{pending=undefined;throw error})
}
export function BrowserSettings(props:ComponentProps<typeof Settings>):JSX.Element{
 const [module,setModule]=useState<Module>(),[failed,setFailed]=useState(false),[attempt,setAttempt]=useState(0)
 useEffect(()=>{let active=true;setFailed(false);void load().then(m=>{if(active)setModule(m)},()=>{if(active)setFailed(true)});return()=>{active=false}},[attempt])
 if(module){const Component=module.BrowserSettings;return <Component {...props}/>}
 return failed?<p role="alert">浏览器模块加载失败。<button onClick={()=>setAttempt(n=>n+1)}>重新加载</button></p>:<p role="status">正在加载浏览器设置…</p>
}
