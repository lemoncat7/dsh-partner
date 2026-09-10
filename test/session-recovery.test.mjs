import test from 'node:test'
import assert from 'node:assert/strict'
import {isMissingSession, SessionRecoveryJobs} from '../lib/companions/session-recovery.js'

test('only explicit absence of the requested session permits creation', () => {
  assert.equal(isMissingSession({name:'SessionPersistenceNotFoundError',sessionId:'s'},'s'),true)
  for (const error of [new Error('session "s" already exists'),new Error('preset missing'),new Error('session "s" not found'),{name:'SessionPersistenceNotFoundError',sessionId:'other'}]) assert.equal(isMissingSession(error,'s'),false)
})
test('concurrent restoration shares one attempt and retries after failure', async () => {
  const jobs = new SessionRecoveryJobs()
  let calls = 0
  const action = async () => {calls++;throw new Error('original resume failure')}
  const a=jobs.run('s',action), b=jobs.run('s',action)
  assert.equal(a,b)
  await assert.rejects(a,/original resume failure/)
  assert.equal(calls,1)
  assert.equal(await jobs.run('s',async()=>42),42)
})
