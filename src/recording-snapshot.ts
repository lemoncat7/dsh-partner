import type {ToolDefinition} from '@deepseek-ai/dsh-tools'
import type {PartnerConcern} from './concern-domain.js'

export interface RecordingSnapshot {data: string; instructions: string; capturedAt: number}
export const SNAPSHOT_TOOL = 'heartbeat_record_checkpoint'
/** Persist verified facts before any formatting or write attempt. */
export function recordingCheckpointTool(concerns: PartnerConcern[], save: (item: PartnerConcern, snapshot: RecordingSnapshot) => Promise<void>): ToolDefinition {
  return {
    name: SNAPSHOT_TOOL,
    description: 'Checkpoint complete verified source data for later recording to the user-selected destination. Include all facts needed to update the record, not only a change summary. Never include credentials, cookies or unverified data. This queues synchronization; it does not mean the destination has been written.',
    parameters: {type:'object',additionalProperties:false,properties:{concernId:{type:'string'},data:{type:'string',maxLength:100000},instructions:{type:'string',maxLength:4000},complete:{type:'boolean'}},required:['concernId','data','instructions','complete']},
    output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:String(value)}]},
    async execute(raw) {
      const args=raw as {concernId:string;data:string;instructions:string;complete:boolean}
      const item=concerns.find(item=>item.id===args.concernId)
      if(!item?.recordTarget || args.complete!==true || typeof args.data!=='string' || !args.data.trim() || args.data.length>100000 || typeof args.instructions!=='string' || args.instructions.length>4000) throw new Error('只能暂存手动指定记录位置对应的完整已核实结果')
      await save(item,{data:args.data,instructions:args.instructions,capturedAt:Date.now()})
      return '已持久保存核验结果，记录同步独立排队；不要在检查阶段写笔记。checkStatus只表示来源核验结果，与同步状态分开。'
    },
  }
}
