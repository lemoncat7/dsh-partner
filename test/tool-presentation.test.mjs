import test from 'node:test'
import assert from 'node:assert/strict'
import {createToolPresentationSelector,ToolPresentationFlag as Flag} from '../lib/execution/tool-presentation.js'
import {trackPartnerTools} from '../lib/execution/tool-ownership.js'
const tool=name=>({name,description:name,parameters:{type:'object',properties:{interest:{type:'object'}},required:['nextActivity']}})
test('trusted flags reuse views across speakers and retain current access, schema and host admission',()=>{
 const store={},select=createToolPresentationSelector(store),tools=['partner_private','partner_chat_reply','partner_activity_finish','external_image'].map(tool)
 const release=trackPartnerTools(store,'owner',tools.slice(0,3).map(t=>t.name))
 const owner={owner:'owner',flags:0,access:{sendTools:true}},guest={...owner,access:{sendTools:true,allowedTools:['partner_chat_reply']}}
 const full=select(tools,owner);assert.equal(select([...tools],owner),full)
 const chat=select(tools,guest);assert.deepEqual(chat.map(t=>t.name),['partner_chat_reply','external_image']);assert.equal(select(tools,owner),full)
 const denied=select(tools,{...owner,access:{sendTools:false}});assert.deepEqual(denied.map(t=>t.name),['external_image'])
 const terminal=select(tools,{...owner,flags:Flag.TerminalOnly});assert.deepEqual(terminal.map(t=>t.name),['partner_chat_reply','partner_activity_finish'])
 const required=select(tools,{...owner,flags:Flag.ActivityChoice|Flag.TaskReview}).find(t=>t.name==='partner_chat_reply')
 assert.deepEqual(required.parameters.required,['interest','taskReview']);assert.deepEqual(tools[1].parameters.required,['nextActivity'])
 const replacement={...tools[1],description:'updated schema'}
 assert.equal(select([tools[0],replacement,...tools.slice(2)],owner)[1].description,'updated schema')
 assert.deepEqual(select([tools[1]],owner).map(t=>t.name),['partner_chat_reply'])
 const again=select(tools,guest);release();assert.notEqual(select(tools,guest),again);assert.ok(select(tools,guest).some(t=>t.name==='partner_private'))
})
