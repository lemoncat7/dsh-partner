// Enable only the newly requested chat features. Preserve identity, permissions and model.
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
const base=process.env.PARTNER_LOCAL_API||'http://127.0.0.1:3080/partner-local/v1'
const backup=process.env.PARTNER_SETTINGS_BACKUP
assert.ok(backup,'Set PARTNER_SETTINGS_BACKUP to a new private backup path')
const before=await fetch(base,{signal:AbortSignal.timeout(15000)}).then(r=>{assert.equal(r.status,200);return r.json()})
const old=before.companions.find(c=>c.id==='companion-default');assert.equal(old?.name,'莫殇');assert.equal(old.characterCard?.enabled,true)
await fs.writeFile(backup,JSON.stringify(before),{mode:0o600,flag:'wx'})
const card={...old.characterCard,segmentedReplies:true,stickersEnabled:true}
try {
  const r=await fetch(`${base}/companions/${old.id}`,{method:'PUT',headers:{'content-type':'application/json','x-dsh-partner-request':'1'},body:JSON.stringify({companion:{...old,characterCard:card}}),signal:AbortSignal.timeout(30000)})
  assert.equal(r.status,200)
}catch(error){
  const check=await fetch(base,{signal:AbortSignal.timeout(20000)}).then(r=>r.json())
  if(JSON.stringify(check.companions.find(c=>c.id===old.id)?.characterCard)!==JSON.stringify(card))throw error
}
const after=await fetch(base,{signal:AbortSignal.timeout(20000)}).then(r=>r.json())
for(const c of before.companions){const next=after.companions.find(n=>n.id===c.id);assert.ok(next);for(const key of ['name','role','description','instructions','capabilities','presetId','provider','model','automation','notificationDelivery'])assert.deepEqual(next[key],c[key],c.id+':'+key);assert.deepEqual(next.characterCard,c.id===old.id?card:c.characterCard)}
for(const s of before.sessions??[])assert.equal(after.sessions.find(n=>n.id===s.id)?.sessionId,s.sessionId)
console.log('Enabled segmented replies and stickers for Moshang; role, all permissions, model, other companions and session IDs preserved.')
