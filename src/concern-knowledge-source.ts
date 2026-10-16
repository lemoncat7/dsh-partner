import type {ToolDefinition} from '@deepseek-ai/dsh-tools'
import type {Agent} from '@deepseek-ai/dsh-agent'
import type {PartnerConcern} from './concern-domain.js'

export interface ConcernSourcePage {
  id: string; name: string; revision: string; content: string
  offset: number; nextOffset: number | null; totalChars: number
}
export interface ConcernKnowledgeBridge {
  readBoundSource?(agent: Agent, binding: {sessionId: string; reference: string}, offset?: number, signal?: AbortSignal): Promise<ConcernSourcePage>
  readSource?(agent: Agent, reference: string, offset?: number, signal?: AbortSignal): Promise<ConcernSourcePage>
}
export type SourceReadReceipt = (concernId: string, key: string, page: ConcernSourcePage) => void
export const CONCERN_KNOWLEDGE_READ = 'heartbeat_read_knowledge_source'

export function concernKnowledgeSourceTool(concerns: PartnerConcern[], bridge: () => ConcernKnowledgeBridge | undefined, onRead?: SourceReadReceipt, assertCurrent?: (concern: PartnerConcern) => Promise<void>): ToolDefinition {
  return {
    name: CONCERN_KNOWLEDGE_READ,
    description: 'Read the exact knowledge document bound to this concern. Pass its unchanged reference (base/full document title), not search keywords. Paginate until nextOffset is null. Does not grant access to unmounted knowledge.',
    parameters: {type: 'object', additionalProperties: false, properties: {concernId: {type: 'string'}, reference: {type: 'string'}, offset: {type: 'integer', minimum: 0}}, required: ['concernId', 'reference']},
    output: {schema: {type: 'string'}, render: (_args, value) => [{type: 'text', text: String(value)}]},
    async execute(raw, exec) {
      const args = raw as {concernId: string; reference: string; offset?: number}
      const concern = concerns.find(c => c.id === args.concernId)
      if (typeof args.reference !== 'string' || !concern?.resources.some(r => r.kind === 'knowledge' && (r.locator === args.reference || (!r.locator.includes('/') && args.reference.startsWith(r.locator + '/'))))) throw new Error('知识文档不是当前关注的检查依据')
      const service = bridge()
      if (!service?.readSource) throw new Error('[SOURCE_READER_UNAVAILABLE] 请更新知识库插件以支持准确读取绑定文档')
      if (!exec.agent) throw new Error('缺少来源会话，不能读取知识文档')
      await assertCurrent?.(concern)
      // A whole-library binding must never turn a model-selected title into a grant.
      const exact = concern.resources.find(r => r.kind === 'knowledge' && r.locator.includes('/') && r.locator === args.reference)
      const page = exact && service.readBoundSource
        ? await service.readBoundSource(exec.agent, {sessionId: exec.agent.session.id, reference: exact.locator}, args.offset ?? 0, exec.signal)
        : await service.readSource(exec.agent, args.reference, args.offset ?? 0, exec.signal)
      await assertCurrent?.(concern)
      onRead?.(concern.id, 'knowledge:' + args.reference, page)
      return JSON.stringify({...page, sourceKey: 'knowledge:' + args.reference})
    },
  }
}
