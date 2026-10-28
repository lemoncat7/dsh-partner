import test from 'node:test'
import assert from 'node:assert/strict'
import { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { PartnerAgentRuntime } from '../lib/agent-runtime.js'
import { createDefaultCompanion } from '../lib/domain.js'
import { normalizeCharacterCard } from '../lib/character/domain.js'
import { PartnerMemoryStore } from '../lib/memory-store.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function fixture(enabled = true) {
  const companion = createDefaultCompanion()
  companion.characterCard = normalizeCharacterCard({ enabled: true, roleText: '坦率的同行者' })
  companion.automation.memory.enabled = enabled
  const session = Session.create('context-test')
  const contexts = new Map(), sections = new Map(), calls = []
  const agent = { session, ctx: { systemPrompt: {
    section: value => { sections.set(value.name, value); return () => sections.delete(value.name) },
    context: value => { contexts.set(value.name, value); return () => contexts.delete(value.name) },
  } } }
  const route = { companionId: companion.id, channelId:'@local', userId:'owner', kind:'local', sessionId:session.id }
  const config = { companion, route, revision:'1' }
  const runtime = Object.create(PartnerAgentRuntime.prototype)
  Object.assign(runtime, { configurations:{ forSession:()=>config }, store:{snapshot:()=>({sessions:[route]})}, contextRevisions:new WeakMap(), characterContexts:new Map(),
    memory:{ characterState:async()=>undefined, recallContext:async(...args)=>{calls.push(args);return {profile:{entries:[],version:'1'},relevant:[],connections:[],scenes:[],history:[]} } } })
  const input = text => session.append('user/message',createUserMessage({content:[{type:'text',text}],source:{kind:'user'}}),{surfaceOp:'append'})
  return { runtime, agent, config, calls, contexts, sections, input }
}

test('dynamic memory is recalled once per input, never mutates stable system sections or raw history', async()=>{
  const f=fixture(), signal=new AbortController().signal
  for(const text of ['你好','今天很烦']) {
    f.input(text)
    const log=JSON.stringify(f.agent.session.snapshotEvents())
    await f.runtime.prepareConversationContext(f.agent,signal)
    await f.runtime.prepareConversationContext(f.agent,signal)
    assert.equal(JSON.stringify(f.agent.session.snapshotEvents()),log)
  }
  assert.equal(f.calls.length,2)
  assert.deepEqual(f.calls[0].at(-1),{includeHistory:false})
  assert.equal(f.sections.size,0)
  assert.equal(f.contexts.size,1)
  assert.equal(f.contexts.values().next().value.interpolate,false)
  assert.equal(f.contexts.values().next().value.required,true)
})

test('memory off skips recall and clears its old snapshot on the next preparation',async()=>{
  const f=fixture(), signal=new AbortController().signal
  f.input('你好');await f.runtime.prepareConversationContext(f.agent,signal)
  f.config.companion.automation.memory.enabled=false;f.config.revision='2'
  await f.runtime.prepareConversationContext(f.agent,signal)
  assert.equal(f.calls.length,1)
  assert.doesNotMatch(f.contexts.values().next().value.text,/联系人画像|长期记忆/)
  f.config.companion.characterCard.enabled=false;f.config.revision='3'
  await f.runtime.prepareConversationContext(f.agent,signal)
  assert.equal(f.contexts.size,0)
})

test('automatic history opt-out preserves explicit historical detail lookup and legacy recall',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'partner-recall-optout-'));t.after(()=>rm(dir,{recursive:true,force:true}))
  const memory=new PartnerMemoryStore(dir)
  await memory.enqueue({id:'old',companionId:'c',scopeId:'s',sessionId:'s',at:Date.now(),user:'配色选择',assistant:'琥珀橙 XK928'})
  assert.equal((await memory.recallContext('c','s','XK928',8,{includeHistory:false})).history.length,0)
  assert.equal((await memory.recallContext('c','s','XK928')).history[0].id,'old')
  assert.match((await memory.searchHistory('c','s','XK928'))[0].assistant,/琥珀橙/)
})
