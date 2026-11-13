import {dispatchTool} from '../compat/tool-dispatch.js'
import {ToolCallId} from '@deepseek-ai/dsh-llm'
import {scopeTarget} from '@deepseek-ai/dsh-scope'
import type {ToolRuntime,ToolRunContext} from '@deepseek-ai/dsh-tools'

/** Preserve the actual tool's schema, policy, cancellation, log projection and receipts. */
export async function dispatchDiscoveredTool(runtime:ToolRuntime,name:string,args:unknown,exec:ToolRunContext){
  const subCallId=ToolCallId(`${exec.callId}:capability`),rootCallId=exec.rootCallId??exec.callId
  const log={rootCallId,parentCallId:exec.callId,subCallId,name,arguments:JSON.stringify(args)}
  exec.agent!.session.append('tool/ptc-dispatch-start',log)
  const result=await dispatchTool(runtime, {name,arguments:args,agent:exec.agent!,signal:exec.signal,callId:subCallId,rootCallId,parent:exec.token,...(exec.toolSet?{toolSet:exec.toolSet}:{})})
  let content=result.content
  // Honor the host's durable-log projection (large output locators/redaction).
  try {content=await exec.agent!.ctx.waterfall(scopeTarget(runtime,exec.agent!), 'tools/ptc-dispatch-log',{exec,agent:exec.agent!,subCallId,name,isError:result.isError,content},()=>Promise.resolve(content))}catch { /* the settled result must still be recorded */ }
  exec.agent!.session.append('tool/ptc-dispatch',{...log,isError:result.isError,content,...(result.meta===undefined?{}:{meta:result.meta}),...(result.error?.info===undefined?{}:{error:result.error.info})})
  for(const context of result.additionalContexts??[])exec.deferContext(context)
  if(result.concludesTurn)exec.concludeTurn()
  const errorText=content.flatMap(b=>b.type==='text'?[b.text]:[]).join('\n')
  return {dispatch:result,...(result.isError&&errorText.trim()?{failureReceipt:{kind:'tool_error' as const,callId:subCallId,excerpt:errorText.trim().slice(0,500),toolName:name}}:{})}
}
