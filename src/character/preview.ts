import type { Context } from '@deepseek-ai/cordis'
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model'
import { createAssistantMessage, createUserMessage, type Message } from '@deepseek-ai/dsh-llm'
import type { Companion } from '../domain.js'
import { normalizeCharacterCard, renderCharacterContext } from './domain.js'
import { renderPartnerPersona } from '../execution/agent-support.js'
const running = new Set<string>()
/** Isolated trial: no tools, session persistence, memory extraction or channel delivery. */
export async function previewCharacter(ctx: Context, companion: Companion, body: Record<string, unknown>) {
  if (running.has(companion.id)) throw new Error('该伙伴的试聊正在生成，请稍候')
  const card = normalizeCharacterCard(body.card)
  if (!card.enabled) throw new Error('请先开启人格强化再试聊')
  if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 2000) throw new Error('试聊消息须为 1–2000 字')
  const history = Array.isArray(body.history) ? body.history.slice(-8).map(entry => {
    if (!entry || typeof entry !== 'object') throw new Error('试聊历史格式无效')
    const e = entry as Record<string, unknown>
    return { user: String(e.user ?? '').slice(0, 2000), assistant: String(e.assistant ?? '').slice(0, 3000) }
  }) : []
  const defaults = ctx.get('agentDefaultModel') as AgentDefaultModelConfig | undefined
  if (!defaults) throw new Error('默认模型服务不可用')
  const selection = { ...defaults.currentSelection(), ...(companion.provider ? {provider: companion.provider} : {}), ...(companion.model ? {model: companion.model} : {}) }
  // Replay ordinary dialogue roles, as in a real conversation. A JSON transcript
  // inside one user message encourages commentary about the character instead.
  const messages: Message[] = []
  for (const entry of history) {
    if (entry.user.trim()) messages.push(createUserMessage({ content: [{ type: 'text', text: entry.user }], source: { kind: 'user' } }))
    if (entry.assistant.trim()) messages.push(createAssistantMessage({ content: [{ type: 'text', text: entry.assistant }], source: selection }))
  }
  messages.push(createUserMessage({ content: [{ type: 'text', text: body.message }], source: { kind: 'user' } }))
  running.add(companion.id)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 90_000)
  let reply = ''; let firstTokenMs: number | undefined; let completed = false
  const started = Date.now()
  try {
    for await (const chunk of ctx.llm.stream({ ...selection,
      system: `${renderPartnerPersona({ ...companion, characterCard: card }, 'local')}\n${renderCharacterContext(card, history.map(e => e.user + e.assistant).join('\n') + body.message)}\n这是独立试聊：只依据提供的对话回应，没有工具，不执行真实操作，不读取或写入正式记忆，不向任何渠道发送消息；身份里列出的工作能力在本次试聊不可用。`,
      messages,
      maxTokens: 1200, signal: controller.signal,
    })) {
      if (chunk.type === 'text-delta') { firstTokenMs ??= Date.now() - started; reply += chunk.text }
      if (chunk.type === 'finish') { if (chunk.reason.kind !== 'stop') throw new Error(`试聊未完成：${chunk.reason.kind}`); completed = true }
    }
    if (!completed || !reply.trim()) throw new Error('试聊流未完整结束，请重试')
    return { reply, firstTokenMs, durationMs: Date.now() - started, ...selection }
  } finally { clearTimeout(timeout); running.delete(companion.id) }
}
