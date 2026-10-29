import assert from 'node:assert/strict'
import test from 'node:test'
import { knowledgeToolAccess } from '../lib/execution/knowledge-tool-access.js'

test('legacy skill read permissions migrate to entry without gaining write access', () => {
  const policy = knowledgeToolAccess(['read', 'knowledge_search', 'knowledge_read'], ['read', 'knowledge', 'bash'])
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
  assert.deepEqual(knowledgeToolAccess([], ['knowledge']).allowed, [])
  assert.deepEqual(knowledgeToolAccess(['knowledge_read'], ['read']).allowed, [])
  assert.deepEqual(knowledgeToolAccess(['knowledge_read'], ['knowledge_read', 'knowledge_search']).allowed, ['knowledge_read'])
  const explicit = knowledgeToolAccess(['knowledge'], ['knowledge'])
  assert.equal(explicit.denial('knowledge', { action: 'call', tool: 'knowledge_note_create' }), undefined)
})
