import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {pathToFileURL} from 'node:url'
import {patchPrepareTools} from './prepare-tools.mjs'
export async function verifyPrepareTools(source){
 const patched=patchPrepareTools(source)
 assert.equal(patchPrepareTools(patched),patched)
 assert.throws(()=>patchPrepareTools('unrecognized host source'))
 const start=patched.indexOf('\tasync preStep(target, position) {'),end=patched.indexOf('\n\t/** Whether the assembled tool schemas',start)
 assert.ok(start>=0&&end>start)
 const preStep=Function('assembleContextFor','renderContextSections','return ({'+patched.slice(start,end)+'}).preStep')((agent,signal)=>({agent,signal}),()=>[])
 for(const mode of ['ready','error','aborted']){
  const order=[],controller=new AbortController(),claimed=[{id:'pending-input'}],selection={provider:'fixture',model:'fixture'}
  let ready=false,disposed=false
  const agent={id:'fixture',phase:{kind:'running',abort:controller},inbox:{claim:()=>claimed},model:{current:()=>selection},runtimeContext:{project:()=>undefined},dispatch:{
   async serial(name,payload){assert.equal(name,'agent/prepare-tools');assert.equal(payload.messages,claimed);assert.equal(payload.turn,1);order.push('prepare');await Promise.resolve();if(mode==='error')throw Error('preparation failed');if(mode==='aborted')controller.abort();ready=true},
   async waterfall(name,payload,next){assert.equal(name,'agent/pre-step');order.push('pre-step');return next()}
  },loopCtx:{tools:{async resolve({agent:scope}){assert.equal(scope,agent);assert.ok(ready);order.push('resolve');return {names:['partner_chat_reply','partner_tools'],dispose(){disposed=true}}}},systemPrompt:{async assemble({toolSet}){assert.deepEqual(toolSet.names,['partner_chat_reply','partner_tools']);order.push('assemble');return {tools:toolSet.names}}}}}
  if(mode==='ready'){
   const result=await preStep.call(agent,'next-step',{turn:1,step:0})
   assert.equal(result.kind,'enter');assert.deepEqual(order,['prepare','resolve','assemble','pre-step']);assert.equal(disposed,false);result.toolSet.dispose();assert.equal(disposed,true)
  }else{await assert.rejects(preStep.call(agent,'next-step',{turn:1,step:0}));assert.deepEqual(order,['prepare'])}
 }
 return {firstStepPrepared:true,errorsBlockBeforeSnapshot:true,abortBlocksBeforeSnapshot:true,idempotent:true}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){console.log(JSON.stringify(await verifyPrepareTools(await readFile(process.argv[2],'utf8'))))}
