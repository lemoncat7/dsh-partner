import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { ToolRuntime, defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { executeObservationLoop, observationToolNames } from '../lib/observation-loop.js'

test('observation inherits session plugin capabilities without granting absent tools', () => {
  const names = observationToolNames(['read', 'ssh_exec', 'custom_authorized_lookup', 'write', 'edit', 'str_replace_editor'].map(name => ({name})), false, false)
  assert.deepEqual([...names], ['read', 'ssh_exec', 'custom_authorized_lookup'])
  assert.equal(names.has('unavailable_tool'), false)
})

test('recording retries retain their narrow target-only capability set', () => {
  const inherited = ['read', 'ssh_exec', 'custom_lookup', 'write', 'edit'].map(name => ({name}))
  assert.deepEqual([...observationToolNames(inherited, true, false)], ['read'])
  assert.deepEqual([...observationToolNames(inherited, true, true)], ['read', 'write', 'edit'])
})

test('inherited plugin execution retains parent authorization guards', async () => {
  const ctx = new Context()
  ctx.provide('systemPrompt', {tools: () => () => {}})
  new ToolRuntime(ctx)
  const source = createScope(ctx, {})
  const agent = {session: {header: {}}, options: {}}
  const child = createScope(ctx, agent, {parent: (await import('@deepseek-ai/dsh-scope')).scopeOf(source.ctx)})
  agent.ctx = child.ctx
  let calls = 0
  source.ctx.tools.register(defineContentToolFixture({
    name: 'custom_authorized_lookup', description: 'test lookup', parameters: {},
    execute: async () => { calls++; return [{type: 'text', text: 'ok'}] },
  }))
  try {
    assert.equal(observationToolNames(ctx.tools.schemas(agent), false, false).has('custom_authorized_lookup'), true)
    const invoke = () => ctx.tools.execute({callId: 'test', name: 'custom_authorized_lookup', arguments: {}, agent, signal: new AbortController().signal})
    assert.equal((await invoke()).isError, false)
    source.ctx.tools.guard(() => 'source authorization denied')
    assert.equal((await invoke()).isError, true)
    assert.equal(calls, 1)
  } finally { await child.dispose(); await source.dispose() }
})

test('lightweight observation fails closed without inherited tool scope', async () => {
  const result = await executeObservationLoop({ ctx: {}, conversation: { ctx: new Context() }, companion: {}, concerns: [], guard: () => {}, parse: () => assert.fail('must not parse an unchecked observation') })
  assert.match(result.error, /继承/)
  assert.deepEqual(result.candidates, [])
  assert.deepEqual(result.tools, [])
})

test('lightweight runner retains bounded private messages and native tool execution', async () => {
  const source = await readFile(new URL('../src/observation-loop.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /executor\.execute|agents\.create|session\.append|tools\.restrict\(/)
  assert.match(source, /ctx\.tools\.execute/)
  assert.doesNotMatch(source, /calls >= 24|stageRemainingMs|150_000/)
  assert.match(source, /AbortSignal\.timeout\(OBSERVATION_MODEL_TIMEOUT_MS\)/)
  assert.match(source, /await scope\.dispose\(\)/)
  assert.match(source, /recordTarget\?\.kind === 'note'/)
  assert.match(source, /signal: modelSignal/)
  assert.match(source, /open && modelSignal\.aborted/)
  assert.match(source, /finalizing = true; continue/)
  assert.match(source, /!open && pending\.length/)
  assert.match(source, /modelMs: Date\.now\(\) - modelAt/)
})

async function runScript(t, script, resources = [], setup = () => {}) {
  const ctx=new Context()
  ctx.provide('systemPrompt',{tools:()=>()=>{}})
  ctx.provide('agentDefaultModel',{currentSelection:()=>({provider:'test',model:'test'})})
  let round=0
  ctx.provide('llm',{prepareCall:async()=>({config:{provider:'test',model:'test'},async *stream(input){
    const blocks=script(round++,input)
    for(const [index,block] of blocks.entries())yield block.type==='finish' ? block : {type:'block-end',index,block}
  }})})
  ctx.provide('dshKnowledgeNoteRecording',{version:1,read:async()=>({id:'n',name:'规则',revision:'v1',content:'检查来源后生成草稿'})})
  new ToolRuntime(ctx)
  const conversation={id:'s',options:{},session:{id:'s',header:{cwd:'/workspace'}}}
  const parent=createScope(ctx,conversation);conversation.ctx=parent.ctx
  setup(ctx,conversation)
  t.after(()=>parent.dispose())
  const progress=[]
  const result=await executeObservationLoop({ctx,conversation,companion:{name:'测试',role:'检查',capabilities:[]},concerns:[{id:'c',subject:'检查来源',reason:'观察变化',resources,nextCheckAt:1,executionInstructions:'生成草稿'}],guard:()=>undefined,
    parse:(output,ids)=>JSON.parse(output).observations.filter(o=>ids.has(o.concernId)),
    saveProgress:async(_item,value)=>progress.push(value)})
  return {result,round,progress}
}
const call=(name,args)=>({type:'tool-call',id:Math.random().toString(),name,arguments:JSON.stringify(args)})
const final=()=>[{type:'text',text:JSON.stringify({observations:[{concernId:'c',checkStatus:'completed',changed:false,outcome:'unchanged',executionNeeded:false}]})}]
const plannedStep={id:'verify',phase:'check',instruction:'核验来源',source:'concern',method:'原始来源只读核验',criterion:'已完整取得目标数据'}

test('private checks keep original session permissions but cannot wake its agent via background jobs',async t=>{
  let executed=0
  const {result}=await runScript(t,round=>{
    if(round===0)return [call('bash',{command:'read-only probe'})]
    if(round===1)return [call('bash',{command:'background probe',run_in_background:true})]
    if(round===2)return [call('heartbeat_check_workflow',{concernId:'c',operation:'plan',steps:[plannedStep]}),call('heartbeat_check_workflow',{concernId:'c',operation:'update',stepId:'verify',status:'completed',evidence:'核验完成'})]
    return final()
  },[],(_ctx,conversation)=>conversation.ctx.tools.register(defineContentToolFixture({
    name:'bash',description:'probe',parameters:{},execute:async(args,exec)=>{
      executed++
      assert.notEqual(exec.agent.id,conversation.id)
      assert.match(exec.agent.id,/^observation-/)
      assert.equal(exec.agent.session,conversation.session)
      assert.equal(args.run_in_background,false)
      assert.equal(args.timeoutMs,50000)
      return [{type:'text',text:'ok'}]
    },
  })))
  assert.equal(executed,1)
  assert.equal(result.error,undefined)
  assert.equal(result.tools[1].status,'failed')
  assert.match(result.tools[1].output,/后台命令/)
})

test('real scoped loop corrects premature success and persists the document workflow',async t=>{
  const {result,round,progress}=await runScript(t,(round,input)=>{
    if(round===0)return final() // Missing sources/plan cannot pass.
    if(round===1){assert.match(JSON.stringify(input.messages),/尚未满足步骤契约/);return [call('heartbeat_read_note_source',{concernId:'c',noteId:'n'})]}
    if(round===2)return [call('heartbeat_check_workflow',{concernId:'c',operation:'plan',steps:[plannedStep,{...plannedStep,id:'draft',phase:'execute',source:'executionInstructions',instruction:'生成草稿'}]})]
    if(round===3)return [call('heartbeat_check_workflow',{concernId:'c',operation:'update',stepId:'verify',status:'completed',evidence:'原始时间和内容已核实'})]
    return final()
  },[{kind:'note',locator:'n'}])
  assert.equal(result.error,undefined)
  assert.equal(round,5)
  assert.deepEqual(result.blocked,[])
  assert.equal(result.candidates[0].workflow.steps[1].status,'pending')
  assert.equal(result.tools.every(t=>t.status==='completed'),true)
  assert.ok(progress.some(p=>p?.workflow?.steps[0].status==='completed'))
  assert.equal(progress.at(-1),null)
})

test('repeated false success is bounded and never dispatches an unchecked candidate',async t=>{
  const {result,round}=await runScript(t,()=>final())
  assert.equal(result.error,undefined)
  assert.ok(round<=13)
  assert.deepEqual(result.candidates,[])
  assert.deepEqual(result.blocked,['c'])
  assert.equal(result.failures.c.kind,'source_incomplete')
})

test('final budget round accepts verified check evidence without another bookkeeping call',async t=>{
  const {result,round}=await runScript(t,(round,input)=>{
    if(round===0)return [call('heartbeat_read_note_source',{concernId:'c',noteId:'n'})]
    if(round===1)return [call('heartbeat_check_workflow',{concernId:'c',operation:'plan',steps:[plannedStep]} )]
    if(round<20)return [call('heartbeat_read_note_source',{concernId:'c',noteId:'n'})]
    assert.equal(input.tools.length,0)
    const response=JSON.parse(final()[0].text)
    response.observations[0].workflowChecks=[{stepId:'verify',status:'completed',evidence:'已完整读取并核验来源，登记与最终判定一并提交'}]
    return [{type:'text',text:JSON.stringify(response)}]
  },[{kind:'note',locator:'n'}])
  assert.equal(round,21)
  assert.equal(result.error,undefined)
  assert.deepEqual(result.blocked,[])
  assert.equal(result.candidates[0].workflow.steps[0].status,'completed')
})

test('a failed model stream is retried without replaying previous tools or executing partial calls',async t=>{
  const {result,round}=await runScript(t,(attempt,input)=>{
    if(attempt===0)return [call('heartbeat_read_note_source',{concernId:'c',noteId:'n'})]
    if(attempt===1)return [call('heartbeat_read_note_source',{concernId:'c',noteId:'n'}),{type:'finish',reason:{kind:'error',failure:{code:'SERVER',status:500,message:'TLS handshake: EOF'}}}]
    if(attempt===2){
      assert.equal(input.messages.filter(m=>m.role==='assistant'&&m.content.some(b=>b.type==='tool-call'&&b.name==='heartbeat_read_note_source')).length,1)
      return [call('heartbeat_check_workflow',{concernId:'c',operation:'plan',steps:[plannedStep]}),call('heartbeat_check_workflow',{concernId:'c',operation:'update',stepId:'verify',status:'completed',evidence:'已核验'})]
    }
    return final()
  },[{kind:'note',locator:'n'}])
  assert.equal(result.error,undefined)
  assert.equal(round,4)
  assert.equal(result.tools.filter(t=>t.name==='heartbeat_read_note_source').length,1)
  assert.equal(result.rounds.length,3)
  assert.equal(result.rounds[1].retries.length,1)
  assert.deepEqual(result.blocked,[])
})

test('model authorization errors are classified without retries or tools',async t=>{
  const {result,round}=await runScript(t,()=>[{type:'finish',reason:{kind:'error',failure:{code:'AUTH_ERROR',status:401,message:'Unauthorized'}}}])
  assert.equal(round,1)
  assert.equal(result.failures.c.kind,'authentication')
  assert.equal(result.tools.length,0)
  assert.match(result.error,/HTTP 401/)
})
