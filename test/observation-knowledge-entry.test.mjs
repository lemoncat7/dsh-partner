import assert from 'node:assert/strict'
import test from 'node:test'
import { heartbeatToolDenial, heartbeatToolPolicy } from '../lib/agent-runtime.js'

test('knowledge gateway does not broaden observation privileges', () => {
  assert.equal(heartbeatToolPolicy([], ['knowledge']).allowed.has('knowledge'), true)
  assert.equal(heartbeatToolDenial('knowledge', { action: 'list' }), undefined)
  for (const action of ['describe', 'call']) {
    for (const tool of ['knowledge_base_search', 'knowledge_search', 'knowledge_read']) {
      assert.equal(heartbeatToolDenial('knowledge', { action, tool, arguments: {} }), undefined)
    }
    for (const tool of ['knowledge_note_list', 'knowledge_note_read', 'knowledge_note_update', 'knowledge_note_confirm', 'knowledge_document_group_assign', 'knowledge_base_create', 'knowledge_record_incident', 'knowledge', '__proto__']) {
      assert.match(heartbeatToolDenial('knowledge', { action, tool, arguments: {} }), /只能.*检索和读取/)
    }
  }
  for (const args of [null, [], {}, {action:'call'}, {action:'invalid'}]) assert.ok(heartbeatToolDenial('knowledge', args))
})
