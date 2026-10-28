// Preserve the role document and all permissions; change only conversational delivery.
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
const base=process.env.PARTNER_LOCAL_API || 'http://127.0.0.1:3080/partner-local/v1'
const backup=process.env.PARTNER_SETTINGS_BACKUP
assert.ok(backup,'Set PARTNER_SETTINGS_BACKUP to a private backup file')
const response=await fetch(base,{signal:AbortSignal.timeout(15000)});assert.equal(response.status,200)
const before=await response.json(),old=before.companions.find(c=>c.id==='companion-default')
assert.equal(old?.name,'莫殇');assert.equal(old.characterCard?.enabled,true)
await fs.writeFile(backup,JSON.stringify(before),{mode:0o600,flag:'wx'})
const chatStyle='闲聊像弟弟发消息，短句直接接话。被哥哥逗时顺势顶一句，不总是认怂，也不解释自己多在意哥哥。依赖用想凑在一起、舍不得走这类直接的小心思表现，不把每句都变成温柔找补。哥哥认真难过时可以安静陪着，不扮成熟的心理老师，不自动给生活建议。不要每轮重复称呼或口头禅。'
const next={...old,characterCard:{...old.characterCard,chatStyle}}
let saved
try {
  const result=await fetch(`${base}/companions/${old.id}`,{method:'PUT',headers:{'content-type':'application/json','x-dsh-partner-request':'1'},body:JSON.stringify({companion:next}),signal:AbortSignal.timeout(30000)})
  assert.equal(result.status,200);saved=await result.json()
} catch (error) {
  // A timeout is ambiguous: verify the saved state before considering any retry.
  const check=await fetch(base,{signal:AbortSignal.timeout(20000)});assert.equal(check.status,200)
  saved=(await check.json()).companions.find(c=>c.id===old.id)
  if(saved?.characterCard?.chatStyle!==chatStyle)throw error
}
for(const key of ['name','role','description','instructions','capabilities','presetId','provider','model','automation','notificationDelivery'])assert.deepEqual(saved[key],old[key],key)
assert.deepEqual({...saved.characterCard,chatStyle:old.characterCard.chatStyle},old.characterCard)
assert.equal(saved.characterCard.chatStyle,chatStyle)
console.log('Moshang chat delivery updated; role, permissions, model and automation preserved.')
