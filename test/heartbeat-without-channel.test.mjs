import test from 'node:test'
import assert from 'node:assert/strict'
import {HeartbeatScheduler} from '../lib/heartbeat.js'

for(const mode of ['local','new','disabled','sync']) test(`attention executes without a notification destination: ${mode}`,async()=>{
  const companion={id:'c',automation:{heartbeat:{enabled:true,intervalMinutes:30,dailyLimit:1,quietStartHour:0,quietEndHour:23}}}
  const route={kind:mode==='disabled'?'channel':'local',companionId:'c',channelId:mode==='disabled'?'w':'@local',userId:'u',sessionId:'s',lastMessageAt:0}
  const state={companions:[companion],sessions:mode==='new'?[]:[route],channels:[],pairings:mode==='disabled'?[{channelId:'w',userId:'u',status:'approved'}]:[],heartbeatStates:[]}
  const item={id:'watch',subject:'检查笔记',scopeId:'*'}
  let executions=0,recorded=0,activities=0,synced=false
  const scheduler=new HeartbeatScheduler({logger:{warn(){}}},{snapshot:()=>state,isCompanionRemoving:()=>false,update:async fn=>fn(state)}, {
    ensureLocalSessionRecord:async()=>{state.sessions.push(route);return route},
    heartbeat:async(_companion,actual,items)=>{assert.equal(actual,route);assert.equal(items[0].id,item.id);executions++;return {concerns:items,candidates:[],startedAt:0,completedAt:1,recording:mode==='sync'?[{concernId:item.id,state:'synced'}]:[]}},
    recordHeartbeatActivity:async()=>{activities++},
  },{sendProactive:async()=>assert.fail('no channel must not notify')},{
    pendingRecording:async()=>item,settleRecording:async(_item,ok)=>{synced=ok},
    pendingNotifications:async()=>assert.fail('no channel must not flush notifications'),due:async()=>[item],
    recordSyncState:async()=>{},recordObservations:async()=>{recorded++;return {observations:[{id:'o'}],notifications:[{id:'o',event:'change'}]}},
  })
  const result=await scheduler.trigger('c',{recordingOnly:mode==='sync'})
  assert.equal(result.sent,false);assert.equal(executions,1);assert.equal(activities,1)
  if(mode==='sync')assert.equal(synced,true)
  else {assert.equal(result.checked,true);assert.equal(recorded,1);assert.match(result.reason,/不投递通知/)}
})
