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
export function recordingNoteTool(concerns: PartnerConcern[], bridge: () => NoteRecordingBridge | undefined, onWritten?: (concernId: string) => void, mode: 'normal' | 'read' | 'sync' = 'normal'): ToolDefinition {
  return {
    name: HEARTBEAT_RECORD_NOTE,
    description: (mode === 'read' ? 'Read-only inspection. Only read is available. ' : mode === 'sync' ? 'Synchronization: read the complete paginated note, then use patch for a unique existing section (oldText + content) or replace for the complete body. No append. Preserve unrelated content. ' : '') + 'Read or update the explicitly selected recording note for a concern. Never writes the source/instruction document. Read paginated content first; use only the operations exposed in this schema; replace only after reading the complete body. Pass the exact revision from read; if changed, reread instead of overwriting. No target means no writes.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      concernId: { type: 'string' }, operation: { type: 'string', enum: mode === 'read' ? ['read'] : mode === 'sync' ? ['read', 'patch', 'replace'] : ['read', 'append', 'patch', 'replace'] },
      oldText: { type: 'string', description: 'Exact unique existing section to replace; required for patch.' },
      offset: { type: 'integer', minimum: 0 }, content: { type: 'string' }, revision: { type: 'string' },
    }, required: ['concernId', 'operation'] },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(raw, exec) {
      const args = raw as Record<string, unknown>
      if (mode === 'read' && args.operation !== 'read' || mode === 'sync' && args.operation === 'append') throw new Error('当前阶段不允许此记录操作，请使用工具列出的操作')
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
      if (!['append', 'patch', 'replace'].includes(String(args.operation)) || typeof args.content !== 'string' || args.content.length > 100000) throw new Error('记录操作或内容无效')
      if (args.revision !== current.revision) throw new Error('记录已变化，请重新读取后再更新')
      let next = args.operation === 'append' ? current.content + args.content : args.content
      if (args.operation === 'patch') {
        if (typeof args.oldText !== 'string' || !args.oldText || current.content.split(args.oldText).length !== 2) throw new Error('替换片段必须在当前笔记中唯一匹配，请重新读取定位')
        next = current.content.replace(args.oldText, () => args.content as string)
      }
      const result = await service.update(current.id, next, current.revision, exec.signal)
      onWritten?.(concern.id)
      return JSON.stringify(result)
    },
  }
}
