import type {ToolDefinition} from '@deepseek-ai/dsh-tools'
import type {PartnerStore} from './store.js'
import type {PartnerConcernStore} from './concern-store.js'
import {concernNoteSourceTool} from './concern-note-source.js'
import {recordingNoteTool, type NoteRecordingBridge} from './concern-recording.js'
import {concernKnowledgeSourceTool, type ConcernKnowledgeBridge} from './concern-knowledge-source.js'

/** Temporary, target-bound access. Never relax the general knowledge note tools. */
export async function concernExecutionNotes(input: {
  store: PartnerStore; concerns: PartnerConcernStore; companionId: string; sourceId: string; sessionId: string
  bridge(): NoteRecordingBridge | undefined
  knowledgeBridge?(): ConcernKnowledgeBridge | undefined
}): Promise<{tools: ToolDefinition[]; prompt: string; dispose(): void}> {
  let active = true
  const deadline = Date.now() + 30 * 60_000
  const resolve = async () => {
    const state = input.store.snapshot()
    const direct = state.concernExecutions?.find(r => r.id === input.sourceId && r.companionId === input.companionId && r.sessionId === input.sessionId && r.status === 'running')
    if (direct) {
      if (!active || Date.now() >= deadline) return undefined
      return (await input.concerns.list(input.companionId)).find(c => c.id === direct.concernId && c.executionInstructions && ['active','watching'].includes(c.state) && c.control !== 'stopped')
    }
    const delegation = state.delegations.find(d => d.id === input.sourceId && d.status === 'running' && d.toCompanionId === input.companionId && d.executionSessionId === input.sessionId && (!d.kind || d.kind === 'task'))
    const task = delegation && state.tasks.find(t => t.id === delegation.taskId && t.status === 'doing' && t.assigneeCompanionId === input.companionId)
    if (!active || Date.now() >= deadline || !task) return undefined
    const receipts = (state.planReceipts ?? []).filter(r => r.requirementId === task.requirementId && r.tasks.some(t => t.id === task.id))
    return (await input.concerns.list(input.companionId)).find(c => c.executionInstructions && ['active','watching'].includes(c.state) && c.control !== 'stopped' && receipts.some(r => r.key.startsWith(`concern:${c.id}:`)))
  }
  const resolved = await resolve()
  if (!resolved) return {tools: [], prompt: '', dispose() {active = false}}
  const concern = structuredClone(resolved)
  const wrap = (tool: ToolDefinition): ToolDefinition => ({...tool, async execute(args, exec) {
    if (exec.agent?.session.id !== input.sessionId) throw new Error('临时笔记授权不属于当前会话')
    const current = await resolve()
    if (!current || current.id !== concern.id || JSON.stringify(current.resources) !== JSON.stringify(concern.resources) || JSON.stringify(current.recordTarget) !== JSON.stringify(concern.recordTarget)) throw new Error('临时笔记授权已结束或关注配置已变化，请重新执行任务')
    const result = await tool.execute(args, exec)
    const after = await resolve()
    if (!after || after.id !== concern.id || JSON.stringify(after.resources) !== JSON.stringify(concern.resources) || JSON.stringify(after.recordTarget) !== JSON.stringify(concern.recordTarget)) throw new Error('临时授权在调用期间已撤销或配置改变，请重新核验状态')
    return result
  }})
  const tools: ToolDefinition[] = []
  if (concern.resources.some(r => r.kind === 'note')) tools.push(wrap(concernNoteSourceTool([concern], input.bridge)))
  if (input.knowledgeBridge && concern.resources.some(r => r.kind === 'knowledge')) tools.push(wrap(concernKnowledgeSourceTool([concern], input.knowledgeBridge)))
  if (concern.recordTarget?.kind === 'note' && !concern.resources.some(r => r.kind === 'note' && r.locator === concern.recordTarget?.locator)) tools.push(wrap(recordingNoteTool([concern], input.bridge)))
  return {tools, dispose() {active = false}, prompt: tools.length ? `\n本次关注执行已获得临时定向依据访问，concernId=${concern.id}。使用 heartbeat_read_note_source 读取已绑定的依据笔记，heartbeat_read_knowledge_source 以完整 reference 读取绑定知识文档，使用 heartbeat_record_note 读取并更新指定结果笔记（先读 revision）。只使用本轮实际提供的工具；知识文档仍须处于当前会话挂载范围。不要用 knowledge_note_search 搜索整个笔记库；不得修改检查依据。授权随本次任务结束撤销。` : ''}
}
