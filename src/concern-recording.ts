import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { PartnerConcern } from './concern-domain.js'

export interface NoteRecordingBridge {
  version: number
  list(query: string, signal?: AbortSignal): Promise<Array<{ id: string; name: string }>>
  read(id: string, signal?: AbortSignal): Promise<{ id: string; name: string; content: string; revision: string }>
  update(id: string, content: string, revision: string, signal?: AbortSignal): Promise<unknown>
}
export const HEARTBEAT_RECORD_NOTE = 'heartbeat_record_note'

/** No model-supplied note IDs: targets come only from persisted user selection. */
export function recordingNoteTool(concerns: PartnerConcern[], bridge: () => NoteRecordingBridge | undefined, onWritten?: (concernId: string) => void): ToolDefinition {
  return {
    name: HEARTBEAT_RECORD_NOTE,
    description: 'Read or update the explicitly selected recording note for a concern. Never writes the source/instruction document. Read paginated content first; append for a new progress entry, replace only after reading the complete body. Pass the exact revision from read; if changed, reread instead of overwriting. No target means no writes.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      concernId: { type: 'string' }, operation: { type: 'string', enum: ['read', 'append', 'replace'] },
      offset: { type: 'integer', minimum: 0 }, content: { type: 'string' }, revision: { type: 'string' },
    }, required: ['concernId', 'operation'] },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(raw, exec) {
      const args = raw as Record<string, unknown>
      const concern = concerns.find(item => item.id === args.concernId)
      if (concern?.recordTarget?.kind !== 'note') throw new Error('当前关注没有明确选择记录笔记')
      const service = bridge()
      if (service?.version !== 1) throw new Error('知识库笔记记录接口不可用，请更新知识库插件')
      const current = await service.read(concern.recordTarget.locator, exec.signal)
      if (args.operation === 'read') {
        const offset = args.offset === undefined ? 0 : Number(args.offset)
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset 无效')
        return JSON.stringify({ ...current, content: current.content.slice(offset, offset + 6000), nextOffset: offset + 6000 < current.content.length ? offset + 6000 : null, totalChars: current.content.length })
      }
      if (!['append', 'replace'].includes(String(args.operation)) || typeof args.content !== 'string' || args.content.length > 100000) throw new Error('记录操作或内容无效')
      if (args.revision !== current.revision) throw new Error('记录已变化，请重新读取后再更新')
      const result = await service.update(current.id, args.operation === 'append' ? current.content + args.content : args.content, current.revision, exec.signal)
      onWritten?.(concern.id)
      return JSON.stringify(result)
    },
  }
}
