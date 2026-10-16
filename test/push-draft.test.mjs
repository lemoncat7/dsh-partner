import assert from 'node:assert/strict'
import {test} from 'node:test'
import {pushDraft, pushDraftSignature} from '../lib/ui/push-draft.js'

const channel = {id:'channel',name:'Bark',baseUrl:'https://example.test',enabled:true,notifyProblems:false,content:'summary',group:'',sound:'',openUrl:'',targets:[{id:'phone',name:'Phone',enabled:true,configured:true}],revision:1,pending:0,failed:0}

test('push draft tracks only editable fields, including masked replacement keys', () => {
  const draft = pushDraft(channel), baseline = pushDraftSignature(draft)
  assert.equal(draft.targets[0].key, '')
  assert.equal(pushDraftSignature({...draft,revision:2,pending:3,failed:1}),baseline)
  for (const patch of [{name:'Other'},{enabled:false},{baseUrl:'https://other.test'},{notifyProblems:true},{content:'title'},{group:'group'},{sound:'sound'},{openUrl:'https://app.test'}]) {
    assert.notEqual(pushDraftSignature({...draft,...patch}),baseline)
  }
  draft.targets[0].key = 'replacement'
  assert.notEqual(pushDraftSignature(draft),baseline)
  draft.targets[0].key = ''
  assert.equal(pushDraftSignature(draft),baseline)
  draft.targets.push({id:'',name:'New',enabled:true,configured:false,key:''})
  assert.notEqual(pushDraftSignature(draft),baseline)
  draft.targets.pop()
  assert.equal(pushDraftSignature(draft),baseline)
  draft.targets[0].enabled = false
  assert.notEqual(pushDraftSignature(draft),baseline)
  assert.equal(channel.targets[0].enabled,true,'draft changes do not mutate server snapshot')
})

test('pristine new forms and successfully saved snapshots are clean', () => {
  const empty = {...channel,id:'',name:'',baseUrl:'',targets:[{id:'',name:'Phone',enabled:true,configured:false}]}
  assert.equal(pushDraftSignature(pushDraft(empty)),pushDraftSignature(pushDraft(empty)))
  const edited = pushDraft(empty)
  edited.name = 'New channel'
  assert.notEqual(pushDraftSignature(edited),pushDraftSignature(pushDraft(empty)))
  const saved = pushDraft({...channel,name:edited.name,revision:2})
  assert.equal(pushDraftSignature(saved),pushDraftSignature(pushDraft({...channel,name:edited.name,revision:3})))
})
