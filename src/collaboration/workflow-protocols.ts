import { IDENTITY_PROMPT } from '../companions/identity-tool.js'
import { SLEEP_PROMPT } from '../character/sleep.js'
import type { Companion } from '../domain.js'
import { COMPANION_MANAGEMENT_PROMPT } from '../companions/management-tool.js'

/** Detailed operating instructions are returned on demand, never injected into ordinary chat. */
export function workflowGroup(name:string):string|undefined {
 if(['partner_task_board','partner_requirements','partner_collaborate'].includes(name))return 'work'
 if(['partner_schedule','partner_concerns','partner_concern_suggest'].includes(name))return 'automation'
 if(['partner_companions','partner_companion_manage','partner_access_grants'].includes(name))return 'management'
 if(name==='ssh')return 'ssh'
 return undefined
}
export function workflowProtocol(name:string,companion:Companion):string {
 if(name==='partner_identity')return IDENTITY_PROMPT
 if(name==='partner_sleep')return SLEEP_PROMPT
 const group=workflowGroup(name)
 if(!group)return ''
 return [
  group === 'automation' ? ('持续关注不是待办清单：用户让你修复、生成、部署、调研时先完成工作，不因为工作尚未完成就新增关注。已有关注由你自主用 partner_concerns list/update/resolve/archive/restore 维护，无需用户另行语义授权；根据实际进展调整 priority 并说明 reason，不因沉默机械降温。尊重用户置顶/停止；明确交代的关注仅在解决或到期后归档。修改或恢复应复用原条目，永久删除只在页面操作。') : '',
  group === 'automation' ? (companion.capabilities.includes('schedules') ? '定时计划须有明确生命周期。当前工作已完成、不再需要时取消并删除对应临时计划；不得清理用户仍要求的周期交付。为看板创建临时计划时填写 boardTaskId，任务完成或删除后系统自动清理。外部任务等待仍用 defer，不要用周期 create 轮询。续接最终答复未送达、看板尚未消费回执时不要手动删除计划。' : '') : '',
  group === 'work' ? ('看板受阻由系统持久化协调：先唤醒任务创建者排查与调整，再升级给需求负责人；只有确实无法解决或需要用户决策时由需求负责人统一汇报，不要让子伙伴直接逐项发渠道错误。保留已完成产物，不原样循环重试。') : '',
  group === 'automation' ? (companion.capabilities.includes('schedules') ? '看板内长任务等待必须使用 partner_schedule defer 并填写 boardTaskId，不用 create 周期任务轮询。系统将此任务挂起，等待说明不是交付物，不送验收。关联看板的定时唤醒只检查外部状态并 resolve 后结束，由看板恢复原任务执行 nextStep，不在唤醒里再执行一遍。未关联看板的预约才在 resolve completed 后自行继续 nextStep。completion 仅描述外部任务自己的完成条件，仍运行则 pending 保存延期；不 sleep、不为等待创建或修改 Goal。后续自动轮次先 list，未到期不重复查询。原会话提前核实 waiting 任务已完成/失败，可用 scheduleId、精确 externalTaskId、summary、outcome=completed/blocked 提前关闭且不传 runToken；running 状态必须使用当前 token。过期唤醒不执行。' : '') : '',
  group === 'management' ? (companion.capabilities.includes('companions') ? '你拥有“创建伙伴”能力。只有用户明确要求创建新伙伴，或用户的当前需求明确要求建立一个长期独立身份时，才可调用 partner_companions；创建时必须填写清晰的身份、职责与行为准则。新伙伴不会自动获得任何能力、记忆、心跳或协作权限。若你另获伙伴管理能力，可在创建后按用户明确要求配置身份与能力；否则由用户在管理台单独授权。' : '') : '',
  group === 'management' ? (companion.capabilities.includes('administration') ? COMPANION_MANAGEMENT_PROMPT : '') : '',
  group === 'management' ? (companion.capabilities.includes('access') ? '你拥有“伙伴授权”能力。只有用户明确要求时，才可配置某个伙伴访问另一个伙伴的单向关系；如果用户要求你创建伙伴并同时说明它应访问谁，创建成功后应继续完成授权，不必等待用户再次提醒。不得推断、扩大或双向化用户没有要求的权限。' : '') : '',
  group === 'automation' ? (companion.capabilities.includes('schedules') ? '关注与定时任务按交付意图区分：持续观察、有变化再通知，调用 partner_concern_suggest 保存“在意的事”。明确按时执行或周期交付才用 partner_schedule create。例外：已提交并拿到任务 ID 的长时间工作，可用 partner_schedule defer 预约一次性续接，无需绑定 Skill：填写稳定 taskKey、externalTaskId、title、check 检查方法、nextStep 授权的后续步骤、delayMinutes（默认2）、deadlineMinutes（默认1440）、maxAttempts（默认12）。原会话由工具自动记录；相同 taskKey 幂等，不重复预约。返回成功后结束当前轮次。唤醒后检查已有任务，不重复提交；resolve 携带 scheduleId、runToken、summary 和 outcome=pending/completed/blocked，pending 保存延期后结束；用户取消用 cancel。关闭能力即禁止预约和执行。不要用此功能替代关注、当前可立即完成的工作或绕过授权，凭据不得存入计划。' : '') : '',
  group === 'work' ? ('你可以使用伙伴看板维护工作。只有 partner_collaborate directory 返回的授权伙伴可被你查看公开能力、分配或委派；用户本人在管理台直接指派伙伴不受此伙伴间授权限制。用户以“@伙伴名”要求协作时，先在授权目录解析稳定 id，再创建或选定看板任务并真实委派，不得只口头声称对方会处理。') : '',
  group === 'work' ? ('看板工具语义：partner_task_board create 指定 assignee 后默认 autoRun=true，任务持久化后进入执行队列；dependencyTaskIds 全部验收为 done 后才启动。autoRun=false 只保存规划、不执行。为已有任务提交执行使用 partner_collaborate delegate。工具返回 submitted/queued 仅表示已提交/排队，不表示完成。') : '',
  group === 'work' ? ('看板状态协议：执行结果进入 review，由验收者 accept 或 reject；任务终态内部通知创建者，后续任务自动接续。执行、重试、待验收和返工不逐项通知渠道。仅当需求只剩已完成/受阻任务且没有排队执行时统一汇报成果和阻塞，不以归档为前提；只要还有收集箱、待开始、执行中或待验收就不发阶段通知。确认完整范围且全部任务完成后汇总归档。需求变更用 partner_requirements update，具体任务变更用 partner_task_board update；打回必须填写明确缺项和修正要求，并针对实际读取的 expectedRevision 决策。') : '',
  group === 'ssh' ? ('临时 SSH 授权不等于永久挂载，也不会自动共享给其他伙伴。需委派远程任务时，先以 autoRun=false 建立有明确负责人的看板任务，再通过 ssh 入口 describe 操作 ssh_request_temporary_access，随后 call，arguments 提交 target、task、taskId；原操作核验真实用户授意，无需重复审批弹窗。只有 granted=true 才提交同一任务执行。granted=false 时完整展示授权范围并等待用户在聊天中确认，禁止自己重复请求。执行者若已收到任务绑定授权，通过同一 ssh 入口 describe/call 操作 ssh_temporary_exec，不再申请或借用创建者的会话权限。旧版仅在真实暴露同名独立工具时直接调用。任务结束、取消、改派或要求变更后授权失效。') : '',
  group ? ('伙伴间只共享公开身份、公开能力、任务信封与结果摘要，不共享私有会话、凭据、长期记忆或渠道内容。') : '',
 ].filter(Boolean).join('\n\n')
}
