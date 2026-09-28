import test from 'node:test'
import assert from 'node:assert/strict'
import { waitForPendantStartup } from '../lib/pendant/startup.js'

function fixture(t) {
  let now = 0, id = 0
  const jobs = new Map(), listeners = new Map()
  t.mock.method(Date, 'now', () => now)
  const doc = { hidden: false, defaultView: {
    setTimeout(fn, ms) { jobs.set(++id, { fn, at: now + ms }); return id },
    clearTimeout(id) { jobs.delete(id) },
  }, addEventListener(type, fn) { listeners.set(type, fn) }, removeEventListener(type) { listeners.delete(type) } }
  return { doc, jobs, listeners,
    emit(type) { listeners.get(type)?.() },
    advance(end) { while(jobs.size) { const [key,job]=[...jobs].sort((a,b)=>a[1].at-b[1].at)[0]; if(job.at>end)break; jobs.delete(key); now=job.at;job.fn() } now=end },
  }
}
test('decoration waits for initial UI and an input quiet interval; cleans listeners', async t => {
  const f=fixture(t), controller=new AbortController();let ready=false
  const promise=waitForPendantStartup(controller.signal,f.doc).then(()=>{ready=true})
  f.advance(1900);f.emit('pointerdown');f.advance(2000);await Promise.resolve();assert.equal(ready,false)
  f.advance(2500);await promise;assert.equal(ready,true);assert.equal(f.listeners.size,0);assert.equal(f.jobs.size,0)
})
test('hidden startup waits for visibility; abort leaves no work', async t => {
  const f=fixture(t), controller=new AbortController();f.doc.hidden=true
  const promise=waitForPendantStartup(controller.signal,f.doc)
  assert.equal(f.jobs.size,0);f.advance(5000);f.doc.hidden=false;f.emit('visibilitychange');assert.equal(f.jobs.size,1)
  const rejected=assert.rejects(promise,{name:'AbortError'});controller.abort();await rejected
  assert.equal(f.jobs.size,0);assert.equal(f.listeners.size,0)
})
test('already aborted startup never schedules work', async t => {
  const f=fixture(t), controller=new AbortController();controller.abort()
  await assert.rejects(waitForPendantStartup(controller.signal,f.doc),{name:'AbortError'})
  assert.equal(f.jobs.size,0);assert.equal(f.listeners.size,0)
})
