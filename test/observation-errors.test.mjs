import test from 'node:test'
import assert from 'node:assert/strict'
import { observationFailure, ObservationModelError, redactObservationError } from '../lib/observation-errors.js'

const context = {phase:'模型响应',round:3,elapsedMs:46_000}
test('model failure retains stage, code, HTTP status and safe summary', () => {
  const error = new ObservationModelError({code:'RATE_LIMIT',status:429,message:'Too many requests'})
  const text = observationFailure(error,context)
  for (const part of ['模型响应','第 3 轮','46 秒','RATE_LIMIT','HTTP 429','Too many requests']) assert.ok(text.includes(part))
})
test('thrown adapter failures and cancellation retain distinct causes', () => {
  assert.match(observationFailure({failure:{code:'NETWORK_ERROR',message:'connection reset'}},context),/NETWORK_ERROR.*connection reset/)
  assert.match(observationFailure(new Error('abort'),{...context,totalAborted:true}),/180 秒总时限/)
  assert.match(observationFailure(new Error('abort'),{...context,toolAborted:true}),/30 秒执行时限/)
  assert.match(observationFailure({name:'AbortError'},context),/调用被取消/)
  assert.match(observationFailure({},context),/未提供/)
})
test('diagnostics redact known credentials, URLs, keys and headers without serializing bodies', () => {
  const text = observationFailure({code:'AUTH_ERROR',status:401,message:'Bad response https://user:pass@site/?token=abc\nAuthorization: Bearer secret-value',body:'PRIVATE BODY'},context)
  assert.doesNotMatch(text,/user:pass|token=abc|secret-value|PRIVATE BODY/)
  assert.match(text,/HTTP 401/)
  assert.doesNotMatch(redactObservationError('unusual-secret', ['unusual-secret']),/unusual-secret/)
  assert.doesNotMatch(redactObservationError('sk-secret123 tk-other123 登录账号 user/password'),/secret123|other123|user\/password/)
  assert.ok(redactObservationError('x'.repeat(2000)).length<=500)
})
