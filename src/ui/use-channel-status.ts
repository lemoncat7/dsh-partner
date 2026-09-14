import {useEffect, type Dispatch, type SetStateAction} from 'react'
import {api, type PartnerSnapshot} from '../client-api.js'

type Status=Pick<PartnerSnapshot,'channels'|'pairings'>
const listeners=new Set<(value:Status)=>void>()
let timer:ReturnType<typeof setTimeout>|undefined
let active:AbortController|undefined
let lastValue=''
async function poll():Promise<void> {
  if(active||!listeners.size)return
  const controller=new AbortController();active=controller
  try {
    if(document.visibilityState!=='hidden') {
      const value=await api<Status>('/channels/status',{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10_000)])})
      const serialized=JSON.stringify(value)
      if(serialized!==lastValue){lastValue=serialized;listeners.forEach(listener=>listener(value))}
    }
  } catch { /* Preserve known state during brief network failures. */ }
  finally {
    if(active===controller)active=undefined
    if(listeners.size)timer=setTimeout(()=>void poll(),3000)
  }
}
export function useChannelStatus(setSnapshot:Dispatch<SetStateAction<PartnerSnapshot|undefined>>):void {
  useEffect(()=>{
    const update=(value:Status)=>setSnapshot(previous=>previous?{...previous,...value}:previous)
    listeners.add(update)
    lastValue=''
    if(!active){clearTimeout(timer);void poll()}
    return ()=>{listeners.delete(update);if(!listeners.size){clearTimeout(timer);active?.abort();lastValue=''}}
  },[setSnapshot])
}
