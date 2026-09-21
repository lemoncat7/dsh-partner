import test from 'node:test'
import assert from 'node:assert/strict'
import { automaticReviewCandidates } from '../lib/collaboration/review-dispatch.js'
import { planParameters } from '../lib/requirements/plan-schema.js'
const task = { id: 'task', status: 'review', autoRun: true, resultSummary: '已保存结果', reviewerCompanionId: 'reviewer', creatorCompanionId: 'owner', workRevision: 1 }
const state = (extra = {}) => ({ tasks: [{ ...task }], companions: [{ id: 'owner' }, { id: 'reviewer' }], companionAccessGrants: [{ fromCompanionId: 'owner', toCompanionId: 'reviewer' }], delegations: [], ...extra })
test('plan tool requires explicit reviewer rather than silently choosing creator', () => {
  assert.ok(planParameters.tasks.items.required.includes('reviewerCompanionId'))
})
test('committed results missing review work are recovered for designated reviewer', () => {
  const s = state(), jobs = automaticReviewCandidates(s)
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].toCompanionId, 'reviewer')
  assert.equal(jobs[0].kind, 'review')
  assert.equal(jobs[0].automaticReview, true)
  s.delegations.push(jobs[0])
  assert.equal(automaticReviewCandidates(s).length, 0)
  assert.equal(automaticReviewCandidates(JSON.parse(JSON.stringify(s))).length, 0)
})
test('no replay after failure, manual cancellation, or successful advisory review', () => {
  for (const status of ['queued', 'running', 'failed', 'canceled', 'completed']) {
    const s = state(), [job] = automaticReviewCandidates(s)
    s.delegations.push({ ...job, status })
    assert.equal(automaticReviewCandidates(s).length, 0, status)
  }
})
test('new work or reassignment permits a new review; no permission or missing result does not', () => {
  const s = state(), [job] = automaticReviewCandidates(s)
  s.delegations.push({ ...job, status: 'failed' })
  s.tasks[0].workRevision++
  assert.equal(automaticReviewCandidates(s).length, 1)
  for (const changes of [{autoRun:false}, {resultSummary:''}, {reviewSummary:'已核验'}, {replanRequested:true}, {status:'done'}, {reviewerCompanionId:undefined}]) {
    assert.equal(automaticReviewCandidates(state({tasks:[{...task,...changes}]})).length,0)
  }
  assert.equal(automaticReviewCandidates(state({companionAccessGrants:[]})).length,0)
})
