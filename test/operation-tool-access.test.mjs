import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { Session } from '@deepseek-ai/dsh-session'
import { operationToolAccess, restrictExecutionTools } from '../lib/execution/operation-tool-access.js'

test('legacy skill read permissions migrate to entry without gaining write access', () => {
  const policy = operationToolAccess(['read', 'knowledge_search', 'knowledge_read'], ['read', 'knowledge', 'bash'])
  assert.deepEqual(policy.allowed, ['read', 'knowledge'])
  assert.equal(policy.denial('knowledge', { action: 'list' }), undefined)
  for (const action of ['describe', 'call']) {
    assert.equal(policy.denial('knowledge', { action, tool: 'knowledge_read' }), undefined)
    for (const tool of ['knowledge_note_update', 'knowledge_note_confirm', 'knowledge_base_create', 'knowledge_record_incident', 'knowledge', 'bash']) {
      assert.match(policy.denial('knowledge', { action, tool }), /不会扩大/)
    }
  }
  for (const args of [null, [], {}, {action:'call'}]) assert.ok(policy.denial('knowledge', args))
})

test('empty, parent-hidden and old-plugin scopes do not gain knowledge access', () => {
  assert.deepEqual(operationToolAccess([], ['knowledge']).allowed, [])
  assert.deepEqual(operationToolAccess(['knowledge_read'], ['read']).allowed, [])
  assert.deepEqual(operationToolAccess(['knowledge_read'], ['knowledge_read', 'knowledge_search']).allowed, ['knowledge_read'])
  const explicit = operationToolAccess(['knowledge'], ['knowledge'])
  assert.equal(explicit.denial('knowledge', { action: 'call', tool: 'knowledge_note_create' }), undefined)
})

test('SSH and transfer allowlists migrate without granting other operations or entries', () => {
  const requested = ['ssh_exec', 'ssh_request_temporary_access', 'ssh_temporary_exec', 'file_upload_from_local', 'knowledge_read']
  const policy = operationToolAccess(requested, ['ssh', 'knowledge', 'bash'])
  assert.deepEqual(policy.allowed, ['ssh', 'knowledge'])
  for (const name of ['ssh', 'knowledge']) assert.equal(policy.denial(name, {action:'list'}), undefined)
  for (const action of ['describe', 'call']) {
    for (const tool of requested.slice(0,4)) assert.equal(policy.denial('ssh', {action,tool}), undefined)
    assert.equal(policy.denial('knowledge', {action,tool:'knowledge_read'}), undefined)
    for (const tool of ['ssh_forward_start', 'file_download_to_local', 'knowledge_read', 'ssh', '__proto__']) assert.ok(policy.denial('ssh', {action,tool}))
    assert.ok(policy.denial('knowledge', {action,tool:'ssh_exec'}))
  }
  for (const args of [null, [], {}, {action:'call'}, {action:'load',tool:'ssh_exec'}, {action:'call',tool:7}]) assert.ok(policy.denial('ssh',args))
  assert.ok(policy.denial('bash',{}))
});

test('explicit entries preserve existing host authorization; ordinary file tools never grant SSH', () => {
  assert.deepEqual(operationToolAccess(['file_read'], ['file_read', 'ssh']).allowed, ['file_read'])
  assert.deepEqual(operationToolAccess(['ssh_exec'], ['ssh_exec', 'ssh_list']).allowed, ['ssh_exec'])
  assert.deepEqual(operationToolAccess(['ssh_exec'], ['knowledge']).allowed, [])
  assert.deepEqual(operationToolAccess(['ssh','ssh_exec'], ['ssh','ssh']).allowed, ['ssh'])
  assert.deepEqual(operationToolAccess(['run_code'], ['run_code','ssh']).allowed, [])
  const policy = operationToolAccess(['ssh','knowledge_read'], ['ssh','knowledge'])
  assert.equal(policy.denial('ssh',{action:'call',tool:'ssh_forward_start'}),undefined)
  assert.ok(policy.denial('knowledge',{action:'call',tool:'knowledge_note_update'}))
});

function runtimeFixture(t) {
  const root = new Context()
  root.provide('systemPrompt',{tools:()=>()=>{}})
  new ToolRuntime(root)
  const agent = {session:Session.create('operation-compat'),options:{}}
  const scope = createScope(root,agent)
  agent.ctx = scope.ctx
  const calls = []
  const definition = name => ({name,description:name,parameters:{type:'object',additionalProperties:true},
    output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},
    execute:async args => {calls.push({name,args});return 'ok'}})
  const register = (name,scoped=false) => (scoped?scope.ctx:root).tools.register(definition(name))
  const invoke = (name,args={}) => root.tools.execute({callId:'test-'+name,name,arguments:args,agent,signal:new AbortController().signal})
  t.after(()=>scope.dispose())
  return {root,agent,scope,calls,register,invoke}
}

test('real runtime blocks unlisted calls, preserves host denial, and disposes operation guards', async t => {
  const f = runtimeFixture(t)
  for(const name of ['ssh','knowledge','bash']) f.register(name)
  f.register('mcp_private',true)
  const limits = createScope(f.scope.ctx,f.agent)
  restrictExecutionTools(limits.ctx,f.agent,['ssh_exec','knowledge_read'])
  assert.equal((await f.invoke('ssh',{action:'list'})).isError,false)
  assert.equal((await f.invoke('ssh',{action:'call',tool:'ssh_exec'})).isError,false)
  assert.equal((await f.invoke('knowledge',{action:'call',tool:'knowledge_read'})).isError,false)
  const before = f.calls.length
  for (const [name,args] of [['ssh',{action:'call',tool:'ssh_terminal_open'}],['knowledge',{action:'call',tool:'knowledge_note_update'}],['bash',{}],['mcp_private',{}]]) {
    assert.equal((await f.invoke(name,args)).isError,true)
  }
  assert.equal(f.calls.length,before)
  const revoke = f.scope.ctx.tools.guard(exec=>exec.name==='ssh'?'host revoked':undefined)
  assert.equal((await f.invoke('ssh',{action:'call',tool:'ssh_exec'})).isError,true)
  assert.equal(f.calls.length,before)
  revoke()
  await limits.dispose()
  assert.equal((await f.invoke('ssh',{action:'call',tool:'ssh_terminal_open'})).isError,false)
});

test('empty and parent-hidden scopes do not regain tools through migration or late registration', async t => {
  const f = runtimeFixture(t)
  f.register('ssh')
  f.scope.ctx.tools.restrict({deny:['ssh']})
  restrictExecutionTools(f.scope.ctx,f.agent,['ssh_exec'])
  f.register('later_global')
  f.register('later_scoped',true)
  for(const name of ['ssh','later_global','later_scoped']) assert.equal((await f.invoke(name,{action:'list'})).isError,true)
  assert.equal(f.calls.length,0)
});

test('an explicitly allowed scoped MCP still works beside legacy SSH operations', async t => {
  const f = runtimeFixture(t)
  f.register('ssh');f.register('mcp_allowed',true);f.register('mcp_private',true)
  restrictExecutionTools(f.scope.ctx,f.agent,['ssh_exec','mcp_allowed'])
  assert.equal((await f.invoke('mcp_allowed')).isError,false)
  assert.equal((await f.invoke('mcp_private')).isError,true)
  const assembly = {tools:f.root.tools.schemas(f.agent)}
  const filtered = await f.scope.ctx.waterfall('system-prompt/assemble',assembly,{agent:f.agent},async()=>assembly)
  assert.deepEqual(filtered.tools.map(tool=>tool.name).sort(),['mcp_allowed','ssh'])
});
