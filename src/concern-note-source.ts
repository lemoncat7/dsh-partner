import type {ToolDefinition} from '@deepseek-ai/dsh-tools'
import type {PartnerConcern} from './concern-domain.js'
import type {NoteRecordingBridge} from './concern-recording.js'
import type {SourceReadReceipt} from './concern-knowledge-source.js'

export const CONCERN_NOTE_READ = 'heartbeat_read_note_source'
/** Read only notes already bound as checking sources; no arbitrary note access. */
export function concernNoteSourceTool(concerns: PartnerConcern[], bridge: () => NoteRecordingBridge | undefined, onRead?: SourceReadReceipt): ToolDefinition {
  return {
    name: CONCERN_NOTE_READ,
    description: 'Read a note bound as a concern checking source. Read-only; paginate until nextOffset is null. Never use the recording tool to edit a checking source.',
    parameters: {type:'object',additionalProperties:false,properties:{concernId:{type:'string'},noteId:{type:'string'},offset:{type:'integer',minimum:0}},required:['concernId','noteId']},
    output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:String(value)}]},
    async execute(raw,exec) {
      const args=raw as Record<string,unknown>
      const concern=concerns.find(item=>item.id===args.concernId)
      if(!concern?.resources.some(item=>item.kind==='note' && item.locator===args.noteId)) throw new Error('笔记不是当前关注的检查依据')
      const offset=args.offset ?? 0
      if(typeof offset!=='number' || !Number.isSafeInteger(offset) || offset<0) throw new Error('offset 无效')
      const service=bridge()
      if(service?.version!==1)throw new Error('笔记读取接口不可用，请检查知识库插件')
      const note=await service.read(String(args.noteId),exec.signal)
      if(offset>note.content.length)throw new Error('笔记长度已变化，请从 offset=0 重读')
      const page={...note,offset,content:note.content.slice(offset,offset+6000),nextOffset:offset+6000<note.content.length?offset+6000:null,totalChars:note.content.length}
      onRead?.(concern.id,'note:'+String(args.noteId),page)
      return JSON.stringify({...page, sourceKey: 'note:' + String(args.noteId)})
    },
  }
}
