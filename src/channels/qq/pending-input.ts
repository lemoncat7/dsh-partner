import type {Agent} from '@deepseek-ai/dsh-agent'
import type {PartnerState} from '../../domain.js'
import {qqGroupRoute} from './settings.js'

/** Only verified steering from this speaker can hold an old step's not-yet-executed calls. */
export function pendingGroupInput(state:PartnerState,agent:Agent,routeId:string):boolean {
  const route=state.sessions.find(r=>r.id===routeId&&r.sessionId===agent.session.id)
  return !!route&&qqGroupRoute(route,state.channels)&&Boolean(agent.inbox?.nextStep.some(m=>m.source.kind==='user'&&route.inboundMessageIds?.includes(m.id)))
}
export const GROUP_INPUT_PENDING='同一位群成员又补充了消息，本步骤尚未执行。先在下一步合并理解新输入，再决定是否回应；不要逐条回旧消息，已完成的操作和已发送内容不要重做或重发。'
