import test from 'node:test'
import assert from 'node:assert/strict'
import {createSshTaskResolver,bindTaskSshAccess} from '../lib/collaboration/ssh-task-access.js'

const fixture=()=>{
  const task={id:'task',creatorSessionId:'parent',assigneeCompanionId:'worker',title:'检查',description:'检查磁盘',workRevision:1,status:'ready',autoRun:false}
  const companion={id:'worker',name:'石火',capabilities:['ssh']}
  const state={tasks:[task],companions:[companion],delegations:[]}
  const store={snapshot:()=>state,isCompanionRemoving:()=>false}
  return {task,companion,state,store,resolver:createSshTaskResolver(store)}
}
test('only the task creator may request access, with paused task and SSH-capable assignee',()=>{
  const f=fixture()
  assert.throws(()=>f.resolver.resolve('task','other'),/当前会话/)
  f.task.autoRun=true;assert.throws(()=>f.resolver.resolve('task','parent'),/autoRun=false/)
  f.task.autoRun=false;f.companion.capabilities=[];assert.throws(()=>f.resolver.resolve('task','parent'),/SSH 能力/)
  f.companion.capabilities=['ssh'];f.state.delegations.push({taskId:'task',status:'running'});assert.throws(()=>f.resolver.resolve('task','parent'),/autoRun=false/)
})
test('lease survives dispatch but not requirements, assignee, permission, name or terminal state changes',()=>{
  for(const change of [f=>f.task.workRevision++,f=>f.task.description='different',f=>f.task.assigneeCompanionId='other',f=>f.companion.name='changed',f=>f.companion.capabilities=[],f=>f.task.status='done',f=>f.task.status='review',f=>f.state.tasks=[]]){
    const f=fixture(),target=f.resolver.resolve('task','parent');assert.equal(target.valid(),true)
    f.task.autoRun=true;f.task.status='doing';f.task.revision=12;assert.equal(target.valid(),true)
    change(f);assert.equal(target.valid(),false)
  }
})
test('binding requires a real running delegation, exact session and executor; reviews never inherit',()=>{
  const f=fixture(),calls=[]
  const bridge={bind:input=>{calls.push(input);return {prompt:'bound',dispose(){}}}}
  const input={sourceId:'delegation',companionId:'worker',sessionId:'child'}
  assert.equal(bindTaskSshAccess(f.store,bridge,input),undefined)
  f.state.delegations.push({id:'delegation',taskId:'task',toCompanionId:'worker',executionSessionId:'child',status:'running',kind:'task'})
  assert.equal(bindTaskSshAccess(f.store,bridge,input).prompt,'bound')
  assert.equal(calls[0].taskId,'task')
  assert.equal(bindTaskSshAccess(f.store,bridge,{...input,sessionId:'other'}),undefined)
  assert.equal(bindTaskSshAccess(f.store,bridge,{...input,companionId:'other'}),undefined)
  f.state.delegations[0].kind='review';assert.equal(bindTaskSshAccess(f.store,bridge,input),undefined)
  assert.equal(bindTaskSshAccess(f.store,undefined,input),undefined)
  assert.equal(calls.length,1)
})
