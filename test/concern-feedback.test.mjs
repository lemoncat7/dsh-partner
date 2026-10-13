import test from 'node:test'
import assert from 'node:assert/strict'
import {concernFeedback} from '../lib/ui/memory/concern-feedback.js'
import {readFile} from 'node:fs/promises'
test('concern panel renders exactly one result region with semantic severity',async()=>{
  const panel=await readFile(new URL('../src/ui/memory/concern-panel.tsx',import.meta.url),'utf8')
  assert.equal((panel.match(/<WorkspaceNotice\b/g)??[]).length,1)
  assert.match(panel,/kind=\{feedback.kind\}/)
})
test('blocked feedback is a single error, never a concurrent success',()=>{
  assert.deepEqual(concernFeedback({notice:'检查受阻',noticeKind:'error',lastError:'检查受阻',checking:false}),{text:'检查受阻',kind:'error'})
  assert.equal(concernFeedback({notice:'已结束',noticeKind:'success',lastError:'失败',checking:false}).kind,'error')
})
test('partial, success, retry and transport errors have consistent precedence',()=>{
  assert.equal(concernFeedback({noticeKind:'success',lastError:'部分失败',lastOutcome:'partial',checking:false}).kind,'warning')
  assert.equal(concernFeedback({noticeKind:'success',notice:'完成',checking:false}).kind,'success')
  assert.equal(concernFeedback({noticeKind:'success',notice:'检查中',lastError:'旧错误',checking:true}).text,'检查中')
  assert.equal(concernFeedback({error:'网络失败',notice:'完成',noticeKind:'success',checking:false}).text,'网络失败')
})
