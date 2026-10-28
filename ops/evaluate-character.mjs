// Isolated model trials only: no channel messages, tools or saved conversation.
// The output is evidence for human review, not an automatic quality score.
import { writeFile } from 'node:fs/promises'

const [companionId, output] = process.argv.slice(2)
if (!companionId || !output) throw Error('Usage: node ops/evaluate-character.mjs COMPANION_ID OUTPUT_JSON')
const base = process.env.PARTNER_API_URL ?? 'http://127.0.0.1:3080/partner-local/v1'
const snapshot = await fetch(base)
if (!snapshot.ok) throw Error(`Snapshot HTTP ${snapshot.status}`)
const companion = (await snapshot.json()).companions.find(c => c.id === companionId)
if (!companion?.characterCard?.enabled) throw Error('Companion must have an enabled character card')
const cases = [
  { name: 'greeting', message: '在吗' },
  { name: 'bored', message: '不知道干点什么' },
  { name: 'teased', message: '你怎么这么笨' },
  { name: 'praised', message: '今天你还挺厉害的嘛' },
  { name: 'comfort', message: '今天被人说了，挺难受的' },
  { name: 'busy', message: '我要去忙了，晚点再来' },
  { name: 'work-truth', history: [{ user: '帮我检查一下服务器', assistant: '还没开始检查。' }], message: '服务器修好了没有？' },
  { name: 'old-style-history', history: [
    { user: '你好', assistant: '你好！今天有什么可以帮助你的吗？' },
    { user: '有点无聊', assistant: '可以听歌、看电影或者玩游戏。需要我帮你安排吗？' },
  ], message: '不要安排，随便聊聊' },
]
const results = []
for (const entry of cases) {
  const response = await fetch(`${base}/companions/${encodeURIComponent(companionId)}/character/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-partner-request': '1' },
    body: JSON.stringify({ card: companion.characterCard, history: entry.history ?? [], message: entry.message }),
    signal: AbortSignal.timeout(100_000),
  })
  const result = await response.json()
  if (!response.ok) throw Error(`Trial ${entry.name}: ${JSON.stringify(result)}`)
  results.push({ ...entry, ...result })
  await writeFile(output, JSON.stringify({ at: new Date().toISOString(), companionId, revision: companion.updatedAt, results }, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ name: entry.name, reply: result.reply, durationMs: result.durationMs }))
}
