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
      if(!item) throw new Error('[CHECKPOINT_CONCERN_INVALID] concernId 不属于本轮关注；请使用本轮给出的完整 id')
      if(!item.recordTarget) throw new Error('[CHECKPOINT_TARGET_MISSING] 此关注没有手动指定记录位置；跳过暂存，不要自行选择目标')
      if(args.complete!==true) throw new Error('[CHECKPOINT_INCOMPLETE] complete 必须为 true，且 data 必须包含本次选定事项的完整已核实结果；未核实不能改成 true 绕过')
      if(typeof args.data!=='string' || !args.data.trim()) throw new Error('[CHECKPOINT_DATA_INVALID] data 必须是非空字符串；结构化事实请先 JSON 序列化，不能直接传对象或数组')
      if(args.data.length>100000) throw new Error('[CHECKPOINT_DATA_TOO_LARGE] data 超过 100000 字，请去除无关 HTML，保留全部必要事实与来源')
      if(typeof args.instructions!=='string' || args.instructions.length>4000) throw new Error('[CHECKPOINT_INSTRUCTIONS_INVALID] instructions 必须是最多 4000 字的字符串，未指定格式时可传空字符串')
      await save(item,{data:args.data,instructions:args.instructions,capturedAt:Date.now()})
      return '已持久保存核验结果，记录同步独立排队；不要在检查阶段写笔记。checkStatus只表示来源核验结果，与同步状态分开。'
    },
  }
}
