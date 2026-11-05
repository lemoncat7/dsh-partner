import test from 'node:test'
import assert from 'node:assert/strict'
import {Session} from '@deepseek-ai/dsh-session'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {WorkProgressReporter} from '../lib/execution/work-progress.js'
import {workProgressOf} from '../lib/execution/work-progress-state.js'
import {workProgressDefinition,WorkProgressCard,registerWorkProgressCards} from '../lib/execution/work-progress-card.js'
const records=s=>s.snapshotEvents().filter(e=>e.type==='plugin:dsh-partner/work-progress')

test('progress is ignorable, restorable, never adds model messages or rewrites history',async()=>{
 const s=Session.create('progress');s.append('turn/start',{turn:1});s.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'查资料'}]}),{surfaceOp:'append'})
 const messages=s.deriveMessages(),old=s.snapshotEvents();let clock=1000
 const p=new WorkProgressReporter(s,'work-call',()=>clock)
 p.started();clock+=2000
 await p.track({action:'describe',name:'read',query:'private query'},async()=>({secret:'private output'}))
 await p.track({action:'call',name:'read',argumentsJson:'private args'},async()=>({dispatch:{isError:true}}))
 clock+=1000;p.finish('partial')
 assert.deepEqual(s.deriveMessages(),messages);assert.deepEqual(s.snapshotEvents().slice(0,old.length),old)
 for(const e of records(s)){assert.equal(e.ignorable,true);assert.equal(e.surfaceOp,undefined);assert.ok(workProgressOf(e))}
 const restored=Session.create('progress',s.snapshotEvents());assert.deepEqual(restored.deriveMessages(),messages)
 const last=workProgressOf(records(restored).at(-1));assert.equal(last.phase,'partial');assert.equal(last.completed,2);assert.equal(last.failed,1);assert.equal(last.catalogue,1);assert.equal(last.endedAt,4000)
 assert.doesNotMatch(JSON.stringify(records(s)),/private query|private output|private args/)
})
test('concurrent operations stay visible until each settles and late completions never reopen canceled work',async()=>{
 const s=Session.create('concurrent'),p=new WorkProgressReporter(s,'call');let release1,release2
 const one=p.track({action:'call',name:'read'},()=>new Promise(r=>release1=r))
 const two=p.track({action:'call',name:'web_search'},()=>new Promise(r=>release2=r))
 assert.equal(workProgressOf(records(s).at(-1)).active.length,2)
 release1({});await one
 assert.equal(workProgressOf(records(s).at(-1)).phase,'tool');assert.equal(workProgressOf(records(s).at(-1)).active[0].label,'web_search')
 p.finish('canceled');const count=records(s).length;release2({});await two;p.started();p.finish('completed')
 assert.equal(records(s).length,count);assert.equal(workProgressOf(records(s).at(-1)).phase,'canceled')
})
test('progress failures do not alter tool result or error; no arguments or arbitrary label text leaks',async()=>{
 const p=new WorkProgressReporter({append(){throw Error('unavailable')}},'call')
 assert.equal(await p.track({},async()=>42),42)
 await assert.rejects(p.track({},async()=>{throw Error('actual failure')}),/actual failure/)
 const s=Session.create('labels'),q=new WorkProgressReporter(s,'call')
 await assert.rejects(q.track({action:'call',name:'secret prompt with spaces'},async()=>{throw Error('secret error')}))
 const last=workProgressOf(records(s).at(-1));assert.equal(last.failed,1);assert.equal(last.recent[0].label,'工具')
 assert.doesNotMatch(JSON.stringify(records(s)),/secret/)
})
function fixture(){const s=Session.create('view'),p=new WorkProgressReporter(s,'work-1',()=>1000);p.started();return {s,p}}
for(const modern of [false,true])test(`card registers with ${modern?'new':'published'} conversation service and restores the latest single node`,()=>{
 const {s,p}=fixture();p.finish('partial');const entries=records(s),cleanups=[],registered=[];let renderer
 const registry={register(d){registered.push(d);return()=>registered.pop()}}
 const services=modern?{conversationEvents:registry}:{uiConversation:{events:registry}}
 const ctx={get:n=>services[n],effect:f=>cleanups.push(f()),inject(names,cb){if(names.every(n=>services[n]))cb(ctx)},slots:{inject(_n,cb){cb()},register(options,render){assert.equal(options.key,'partner-work-progress');renderer=render;return()=>{}}}}
 registerWorkProgressCards(ctx);assert.deepEqual(registered,[workProgressDefinition])
 const start={event:entries[0],location:{kind:'turn',turn:{status:'open'}}},context={key:'progress',id:'work-1',start}
 let state=workProgressDefinition.start(context,start)
 for(const event of entries.slice(1)){assert.equal(workProgressDefinition.match(event).id,'work-1');state=workProgressDefinition.update({...context,state},{event})}
 const node=workProgressDefinition.buildViewNode({...context,state})
 assert.equal(node.anchorSeq,entries[0].seq);assert.equal(node.data.phase,'partial')
 assert.match(renderToStaticMarkup(renderer({node})),/部分完成/)
 assert.equal(workProgressDefinition.start({}, {event:entries.at(-1)}).phase,'partial')
 cleanups.forEach(f=>f());assert.equal(registered.length,0)
})
test('closed parent turns settle stale progress; failed and timed-out cards never imply completion or delivery',()=>{
 const {s}=fixture(),event=records(s).at(-1),state=workProgressOf(event)
 const node=workProgressDefinition.buildViewNode({key:'p',id:'work-1',state,start:{event,location:{kind:'turn',turn:{status:'closed',end:{time:5000}}}}})
 assert.equal(node.data.phase,'interrupted');assert.equal(node.data.endedAt,5000)
 for(const phase of ['failed','timed-out','canceled','interrupted']){
  const html=renderToStaticMarkup(createElement(WorkProgressCard,{data:{...state,phase,endedAt:5000}}))
  assert.doesNotMatch(html,/等待模型|工作已完成|执行结果已返回/);assert.match(html,/工作已停止/)
 }
 assert.equal(workProgressDefinition.match({type:event.type,data:state}),null)
 assert.equal(workProgressDefinition.match({...event,data:{...state,active:null}}),null)
})
