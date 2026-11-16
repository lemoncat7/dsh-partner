export type ExecutionKind = 'work' | 'schedule' | 'delegation' | 'review' | 'skill'
export type ExecutionStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled' | 'timed-out'

export interface ExecutionRun {
  background?: {
    routeId:string; sourceSessionId:string; channelId:string; userId:string; inputId:string;
    accountId:string; baseUrl:string; targetId:string; label:string; cwd:string; capabilities:string[];
    childName?:string; result?:{text:string;files:{path:string;name:string;mediaType:string}[]}; deliveredAt?:number; deliveryError?:string;
  }
  id: string
  kind: ExecutionKind
  ownerCompanionId: string
  sessionId: string
  sourceId: string
  status: ExecutionStatus
  destroyAfterRun: boolean
  startedAt: number
  completedAt?: number
  outputSummary?: string
  error?: string
  toolNames: string[]
}
