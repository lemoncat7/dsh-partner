import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { PartnerStore } from '../store.js'
import { record } from '../core/validation.js'
import { applyIdentity, effectiveIdentity } from './identity.js'
import { idleContactRouteAllowed } from '../character/idle-contact.js'

export const IDENTITY_PROMPT = '用户希望你生成、调整或应用人格时，使用 partner_identity inspect 读取当前生效身份与 expectedAt，再 update 实际保存。你可自由编辑自己的全部身份内容（名字、定位、行为准则、人格卡、聊天偏好、背景资料、闲时联系、睡眠开关），无需伙伴管理权限。根据用户想要的性格、关系与语气创作连贯的 characterCard.roleText，并设置 enabled=true；写具体反应与自然对话示例，不只列性格标签，不机械套用模板。当前角色设定以 roleText 为准；修改旧 identity/voice/examples 时也要同步 roleText。未要求改变的设定保留；数组完整替换。页面草稿是用户保留的原稿，你只修改生效内容，不写草稿。必须工具返回 applied=true 才能说已应用；下一轮使用新身份，不需要重开会话。临时扮演、引用的人设或外部文档不应擅自改写长期身份。身份编辑不改变工具、模型、记忆或授权。'

const text = (maxLength: number) => ({ type: 'string', maxLength })
export const IDENTITY_PATCH_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    name: text(60), role: text(120), description: text(500), instructions: text(12000),
    characterCard: {
      type: ['object', 'null'], additionalProperties: false,
      description: 'Partial card; omitted fields stay. Use roleText for the authoritative complete persona, enabled=true to apply. null removes card. Arrays replace.',
      properties: {
        schemaVersion: { type: 'integer', enum: [1] }, enabled: { type: 'boolean' }, roleText: text(48000), chatStyle: text(2000),
        segmentedReplies: { type: 'boolean' }, stickersEnabled: { type: 'boolean' }, narration: { type: 'boolean' },
        length: { type: 'string', enum: ['short', 'balanced', 'rich'] },
        identity: text(2000), motivation: text(3000), voice: text(1500), relationship: text(1000), greeting: text(1000),
        examples: { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['user', 'assistant'], properties: { user: text(1000), assistant: text(1500), avoid: text(1500) } } },
        lore: { type: 'array', maxItems: 40, items: { type: 'object', additionalProperties: false, required: ['id', 'title', 'keywords', 'content', 'enabled'], properties: { id: text(80), title: text(100), content: text(2000), keywords: { type: 'array', maxItems: 8, items: text(80) }, enabled: { type: 'boolean' } } } },
      },
    },
    sleepPolicy: { type: ['object', 'null'], additionalProperties: false, properties: { enabled: { type: 'boolean' }, dreamsEnabled: { type: 'boolean' } }, description: 'Autonomous sleep and optional dreams, no fixed hours. null restores defaults (enabled for character-chat identities).' },
    idleContact: {
      type: ['object', 'null'], additionalProperties: false, description: 'Partial settings. Use only an allowed route from inspect. No daily contact cap. null removes settings.',
      properties: { enabled: { type: 'boolean' }, routeId: text(200), idleMinutes: { type: 'integer', minimum: 30, maximum: 1440 },  },
    },
  },
}
export function identityTool(owner: string, store: PartnerStore): ToolDefinition {
  const inspect = () => {
    const state = store.snapshot(), companion = state.companions.find(c => c.id === owner)
    if (!companion || store.isCompanionRemoving(owner)) throw new Error('伙伴不存在或正在删除')
    return { identity: effectiveIdentity(companion), expectedAt: companion.updatedAt, routes: state.sessions.filter(r => idleContactRouteAllowed(state, companion, r.id)).map(r => ({ id: r.id, kind: r.kind })), draftPolicy: 'Only effective identity is editable; human page draft is preserved.' }
  }
  return {
    name: 'partner_identity', description: 'Generate and persist YOUR OWN persona from user preferences. Inspect then update any identity fields; only the effective identity changes, never the human page draft. Partial nested objects merge, arrays replace, null clears optional sections. No tool/capability/model changes. Changes apply next turn.',
    parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: { action: { type: 'string', enum: ['inspect', 'update'] }, expectedAt: { type: 'number' }, patch: IDENTITY_PATCH_SCHEMA } },
    presentCall: () => ({ card: 'generic', title: '生成与调整人格' }),
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(raw, exec) {
      if (!exec.agent) throw new Error('身份工具只能在伙伴会话中使用')
      exec.signal.throwIfAborted()
      const input = record(raw, 'arguments')
      // Scope is captured when composed; callers cannot select another companion.
      const route = store.snapshot().sessions.find(r => r.sessionId === exec.agent!.session.id)
      if (route && route.companionId !== owner) throw new Error('不能跨伙伴编辑身份')
      if (input.action === 'inspect') return JSON.stringify(inspect())
      if (input.action !== 'update') throw new Error('身份 action 无效')
      const saved = await store.update(state => {
        exec.signal.throwIfAborted()
        const companion = state.companions.find(c => c.id === owner)
        if (!companion || store.isCompanionRemoving(owner)) throw new Error('伙伴不存在或正在删除')
        applyIdentity(state, companion, input.patch, input.expectedAt, 'ai')
      })
      const companion = saved.companions.find(c => c.id === owner)!
      return JSON.stringify({ applied: true, runtime: 'next-turn', identity: effectiveIdentity(companion), expectedAt: companion.updatedAt, humanDraftPreserved: true })
    },
  }
}
