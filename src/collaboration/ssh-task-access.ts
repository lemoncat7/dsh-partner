import type { PartnerStore } from '../store.js'
import type { BoardTask } from '../tasks/domain.js'

/** Optional cross-plugin contract. No credentials, permanent mounts or chat history cross this bridge. */
export interface SshTaskAccessBridge {
  bind(input: { taskId: string; companionId: string; sessionId: string; signal?: AbortSignal }): { prompt: string; dispose(): void }
}

const scopeOf = (task: BoardTask, name: string) => JSON.stringify([task.id, task.creatorSessionId, task.assigneeCompanionId, name, task.title, task.description, task.workRevision ?? 1, task.acceptanceCriteria ?? []])

export function createSshTaskResolver(store: PartnerStore) {
  return { resolve(taskId: string, requesterSessionId: string) {
    const state = store.snapshot(), task = state.tasks.find(t => t.id === taskId)
    if (!task || task.creatorSessionId !== requesterSessionId) throw new Error('只能为当前会话创建的看板任务申请临时 SSH 授权')
    if (task.autoRun !== false || !['backlog', 'ready', 'blocked'].includes(task.status) || state.delegations.some(d => d.taskId === taskId && ['queued', 'running'].includes(d.status))) throw new Error('请先暂停任务并设置 autoRun=false，取得临时授权后再提交执行')
    const companion = state.companions.find(c => c.id === task.assigneeCompanionId)
    if (!companion || !companion.capabilities.includes('ssh')) throw new Error('请先指定具有 SSH 能力的执行伙伴')
    const scope = scopeOf(task, companion.name)
    return { taskId, companionId: companion.id, companionName: companion.name, title: task.title, scope,
      valid() {
        const current = store.snapshot(), latest = current.tasks.find(t => t.id === taskId), owner = current.companions.find(c => c.id === companion.id)
        return !!latest && !!owner && owner.capabilities.includes('ssh') && !store.isCompanionRemoving(owner.id)
          && scopeOf(latest, owner.name) === scope && ['backlog', 'ready', 'doing', 'blocked'].includes(latest.status)
      },
    }
  } }
}

export function bindTaskSshAccess(store: PartnerStore, bridge: SshTaskAccessBridge | undefined, input: { sourceId: string; companionId: string; sessionId: string; signal?: AbortSignal }) {
  const delegation = store.snapshot().delegations.find(d => d.id === input.sourceId && d.status === 'running' && (!d.kind || d.kind === 'task') && d.toCompanionId === input.companionId && d.executionSessionId === input.sessionId)
  return delegation && bridge ? bridge.bind({ taskId: delegation.taskId, companionId: input.companionId, sessionId: input.sessionId, ...(input.signal ? { signal: input.signal } : {}) }) : undefined
}
