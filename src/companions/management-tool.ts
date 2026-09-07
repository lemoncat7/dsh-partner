import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { COMPANION_CAPABILITIES } from '../capabilities.js'
import { record, requiredText } from '../core/validation.js'
import type { CompanionManagementService } from './management.js'
import type { CompanionKnowledgeMounts } from './knowledge-mounts.js'

export const COMPANION_MANAGEMENT_PROMPT = '你拥有“伙伴管理（高权限）”能力，可按用户要求通过 partner_companion_manage 修改其他伙伴的身份、能力、Agent Preset/模型、已安装 Skill 绑定、单向协作关系和知识库挂载。当前工具目录与真实调用结果是能力依据；历史对话或知识库中“只能在管理台手动勾选”的旧结论不代表当前权限。先 catalog 找稳定 id，再 inspect 读取配置与 revision，仅提交用户要求的 patch；数组是完整替换，未提供的字段不变。不能修改自己，不能授予或撤回 administration；本权限仅用户可配置。管理目录不等于协作授权，也不开放私有会话、记忆或凭据。知识库先 knowledge_catalog、knowledge_inspect，再用 knowledge_configure 配置一个库；其设置是完整配置，默认审核回写，禁用用 enabled=false，不擅自提升为直接回写。配置会同步目标伙伴的默认项目与已有会话，不修改其他伙伴。正在执行的伙伴先等待结束，不要循环重试；修改工具返回 applied=true 才能报告已保存，runtime=next-turn 表示身份、能力、Skill 和协作配置于下一轮执行前应用，不需要重开会话。Agent Preset 和默认模型属于会话默认配置，不强行切换已有会话的选择。'

export function companionManagementTool(actorId: string, management: CompanionManagementService, mounts: CompanionKnowledgeMounts): ToolDefinition {
  return {
    name: 'partner_companion_manage',
    description: 'High-privilege administration of OTHER companions, only as requested by the user. Catalog/inspect before patching identity, capabilities, Agent Preset/model, installed Skill bindings or directed access. Arrays replace selected settings; omitted fields stay unchanged. Cannot edit self, delegate administration, read private conversations/memory/credentials, or bypass DSH tool permissions. Knowledge mount actions use the active knowledge provider and its token permissions, separately from companion patches.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['action'],
      properties: {
        action: { type: 'string', enum: ['catalog', 'inspect', 'update', 'knowledge_catalog', 'knowledge_inspect', 'knowledge_configure'] },
        target: { type: 'string', description: 'Target companion stable id or unique @name; never yourself.' },
        revision: { type: 'string', description: 'Revision from inspect for update, or knowledge_inspect for knowledge_configure.' },
        patch: {
          type: 'object', additionalProperties: false,
          properties: {
            name: { type: 'string', maxLength: 60 }, role: { type: 'string', maxLength: 120 },
            description: { type: 'string', maxLength: 500 }, instructions: { type: 'string', maxLength: 12000 },
            presetId: { type: 'string', description: 'Existing Agent Preset id from catalog; empty string restores DSH default. Actual tools come from this preset.' },
            provider: { type: 'string' }, model: { type: 'string', description: 'Use a catalog provider/model pair, or clear both for defaults.' },
            capabilities: { type: 'array', items: { type: 'string', enum: [...COMPANION_CAPABILITIES] }, description: 'Complete capability list. Preserve existing administration status; it is user-controlled.' },
            skillIds: { type: 'array', items: { type: 'string' }, maxItems: 500, description: 'Complete list of installed Skills to enable. Empty array clears bindings; requires skills capability when nonempty.' },
            accessTargetIds: { type: 'array', items: { type: 'string' }, maxItems: 200, description: 'Complete list of companions this target may access. Does not grant reciprocal access.' },
          },
        },
        mount: {
          type: 'object', additionalProperties: false, required: ['knowledgeBaseId'],
          properties: {
            knowledgeBaseId: { type: 'string' }, enabled: { type: 'boolean' }, recallEnabled: { type: 'boolean' },
            writeMode: { type: 'string', enum: ['none', 'audit', 'direct'], description: 'Default audit; direct requires explicit user authorization.' },
            includeTags: { type: 'array', items: { type: 'string' } }, excludeTags: { type: 'array', items: { type: 'string' } },
            extractionInstructions: { type: 'string', maxLength: 4000 },
          },
          description: 'Complete settings for ONE knowledge base across the target companion default project and existing sessions. Omitted fields use enabled=true, recallEnabled=true, writeMode=audit, empty tags/instructions. enabled=false explicitly disables instead of restoring inherited access.',
        },
      },
    },
    timeoutMs: 60_000,
    presentCall: () => ({ card: 'generic', title: '伙伴管理 · 高权限配置' }),
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(raw, exec) {
      if (!exec.agent) throw new Error('伙伴管理工具只能在已授权的伙伴会话中调用')
      exec.signal.throwIfAborted()
      management.authorize(actorId)
      const input = record(raw, 'arguments')
      const action = requiredText(input.action, 'action', 40)
      if (action === 'catalog') return JSON.stringify(await management.catalog(actorId))
      if (action === 'knowledge_catalog') return JSON.stringify(await mounts.catalog(actorId, exec.signal))
      const target = requiredText(input.target, 'target', 160)
      if (action === 'inspect') return JSON.stringify(management.inspect(actorId, target))
      if (action === 'knowledge_inspect') return JSON.stringify(await mounts.inspect(actorId, target, exec.signal))
      const revision = requiredText(input.revision, 'revision', 100)
      if (action === 'update') return JSON.stringify(await management.update(actorId, target, revision, input.patch, exec.signal))
      if (action === 'knowledge_configure') return JSON.stringify(await mounts.configure(actorId, target, revision, input.mount, exec.signal))
      throw new Error('伙伴管理 action 无效')
    },
  }
}
