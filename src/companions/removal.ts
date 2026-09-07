import type { PartnerState } from '../domain.js'
import type { PartnerStore } from '../store.js'

export interface CompanionRemovalLifecycle {
  isBusy(id: string): boolean
  detachWorkspace(id: string): Promise<void>
  resetSessions(id: string): Promise<void>
  clearMemory(id: string): Promise<void>
  clearConcerns(id: string): Promise<void>
  validateDirectory?(id: string): Promise<void>
  removeDirectory?(id: string): Promise<void>
}

/** Serialize destructive lifecycle operations, including different targets. */
export class CompanionRemovalService {
  private tail: Promise<void> = Promise.resolve()
  constructor(private readonly store: PartnerStore) {}

  remove(id: string, lifecycle: CompanionRemovalLifecycle): Promise<void> {
    const job = this.tail.then(() => this.run(id, lifecycle))
    this.tail = job.catch(() => {})
    return job
  }

  private async run(id: string, lifecycle: CompanionRemovalLifecycle): Promise<void> {
    const unlock = this.store.beginCompanionRemoval(id)
    try { await this.removeLocked(id, lifecycle) } finally { unlock() }
  }

  private async removeLocked(id: string, lifecycle: CompanionRemovalLifecycle): Promise<void> {
    assertRemovable(this.store.snapshot(), id, lifecycle)
    await lifecycle.validateDirectory?.(id)
    // Fail registration cleanup before removing identity/session links.
    await lifecycle.detachWorkspace(id)
    assertRemovable(this.store.snapshot(), id, lifecycle)
    await lifecycle.resetSessions(id)
    // Finish disk cleanup before dropping the identity: failures remain visible
    // and retryable on the same companion, never on the next selected one.
    if (lifecycle.removeDirectory) await lifecycle.removeDirectory(id)
    else { await lifecycle.clearMemory(id); await lifecycle.clearConcerns(id) }
    await this.store.update(state => {
      assertRemovable(state, id, lifecycle)
      state.companions = state.companions.filter(item => item.id !== id)
      state.sessions = state.sessions.filter(item => item.companionId !== id)
      state.skillBindings = state.skillBindings.filter(item => item.companionId !== id)
      state.companionAccessGrants = state.companionAccessGrants.filter(grant => grant.fromCompanionId !== id && grant.toCompanionId !== id)
      state.schedules = state.schedules.filter(item => item.companionId !== id)
      state.heartbeatStates = state.heartbeatStates.filter(item => item.companionId !== id)
      for (const task of state.tasks) {
        let changed = false
        if (task.assigneeCompanionId === id) { delete task.assigneeCompanionId; task.autoRun = false; changed = true }
        if (task.reviewerCompanionId === id) { delete task.reviewerCompanionId; changed = true }
        if (changed) { task.revision += 1; task.updatedAt = Date.now() }
      }
      for (const item of state.delegations) if (item.status === 'queued' && (item.fromCompanionId === id || item.toCompanionId === id)) {
        item.status = 'canceled'; item.error = '关联伙伴已删除，取消尚未执行的任务'; item.completedAt = Date.now(); delete item.nextAttemptAt
      }
    })
  }
}

function assertRemovable(state: PartnerState, id: string, lifecycle: CompanionRemovalLifecycle): void {
  if (!state.companions.some(item => item.id === id)) throw failure(404, '伙伴不存在或已删除')
  if (state.companions.length <= 1) throw failure(409, '至少保留一个伙伴')
  if (state.channels.some(item => item.companionId === id)) throw failure(409, '请先删除或换绑该伙伴的微信渠道')
  if (lifecycle.isBusy(id) || state.executionRuns.some(item => item.ownerCompanionId === id && item.status === 'running')
    || state.delegations.some(item => item.status === 'running' && (item.fromCompanionId === id || item.toCompanionId === id))) {
    throw failure(409, '伙伴仍有正在执行的会话或任务，请等待完成后再删除')
  }
}

function failure(status: number, message: string): Error & { status: number } { return Object.assign(new Error(message), { status }) }
