import test from 'node:test'
import assert from 'node:assert/strict'
import {continuationChannelOrigin, savedContinuationRoute} from '../lib/scheduler/channel-origin.js'

const route={id:'mx-route',kind:'channel',sessionId:'s',companionId:'c',channelId:'mx',userId:'alice',inboundMessageIds:['inbound']}
const wake={originSessionId:'s',messageId:'wake',state:'completed',originChannel:{routeId:route.id,channelId:route.channelId,userId:route.userId}}
const notice={type:'user/message',data:{id:'wake',source:{kind:'plugin',plugin:'@lemoncat7/dsh-partner',form:'notice',summary:'伙伴长任务续接'}}}
const state={sessions:[route],schedules:[{companionId:'c',continuation:wake}]}

test('exact wake inherits source; browser input resets origin',()=>{
  assert.equal(continuationChannelOrigin(state,'c','s',[notice]),route)
  const browser={type:'user/message',data:{id:'browser',source:{kind:'user'}}}
  assert.equal(continuationChannelOrigin(state,'c','s',[notice,browser]),undefined)
  assert.equal(continuationChannelOrigin(state,'other','s',[notice]),undefined)
})

test('old, cancelled and board wakes never guess a channel',()=>{
  for(const patch of [{originChannel:undefined},{state:'cancelled'},{board:{taskId:'board'}}]){
    assert.equal(continuationChannelOrigin({...state,schedules:[{companionId:'c',continuation:{...wake,...patch}}]},'c','s',[notice]),undefined)
  }
  assert.throws(()=>savedContinuationRoute({...state,sessions:[{...route,userId:'bob'}]},'c',wake),/原渠道已移除或变更/)
})
