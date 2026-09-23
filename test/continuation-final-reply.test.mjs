import test from 'node:test'
import assert from 'node:assert/strict'
import {continuationFinalReply} from '../lib/scheduler/final-reply.js'

const notice = {seq: 1, type: 'user/message', data: {id: 'wake-message', source: {kind: 'plugin', plugin: '@lemoncat7/dsh-partner', form: 'notice', summary: '伙伴长任务续接'}}}
const answer = {seq: 3, type: 'assistant/message', data: {message: {content: [{type: 'text', text: '已经处理，结果见 /tmp/result.png'}]}}}
const end = {seq: 4, type: 'turn/end', data: {turn: 'turn-final', reason: {kind: 'completed'}}}
const entry = {id: 'schedule', continuation: {originSessionId: 'session', messageId: 'wake-message', state: 'blocked', notifiedAt: 1}}

test('error notice does not suppress a matching final answer or its file references', () => {
  const result = continuationFinalReply([entry], 'session', [notice, answer], [notice, answer], end)
  assert.equal(result.reply.text, answer.data.message.content[0].text)
  assert.deepEqual(result.reply.referenceTexts, [result.reply.text])
})

test('board, pending, cancelled, other sessions and later user turns stay excluded', () => {
  for (const patch of [{board: {taskId: 'board'}}, {state: 'waiting'}, {state: 'cancelled'}, {originSessionId: 'other'}, {messageId: 'other'}]) {
    assert.equal(continuationFinalReply([{...entry, continuation: {...entry.continuation, ...patch}}], 'session', [notice, answer], [notice, answer], end), undefined)
  }
  const user = {seq: 2, type: 'user/message', data: {source: {kind: 'user'}}}
  assert.equal(continuationFinalReply([entry], 'session', [notice, user, answer], [answer], end), undefined)
  assert.equal(continuationFinalReply([entry], 'session', [notice, answer], [answer], {...end, data: {...end.data, reason: {kind: 'failed'}}}), undefined)
})

test('tool-only progress and its file references are not delivered as final output', () => {
  const tool = {seq: 3.5, type: 'tool/result', data: {}}
  assert.equal(continuationFinalReply([entry], 'session', [notice, answer, tool], [notice, answer, tool], end), undefined)
})
