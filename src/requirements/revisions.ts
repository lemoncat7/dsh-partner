import type { BoardRequirement } from './domain.js'

/** revision guards complete snapshots; controlRevision is the last edit requiring a reread.
 * Keep both in the same sequence so existing clients can continue sending revision.
 * Legacy records conservatively start at their current revision, never at 1.
 */
export function advanceRequirementRevision(item: BoardRequirement, control = false): void {
  item.controlRevision ??= item.revision
  item.revision++
  if (control) item.controlRevision = item.revision
  item.updatedAt = Date.now()
}

export function assertRequirementRevision(item: BoardRequirement, expected: number, snapshot = false): void {
  const minimum = snapshot ? item.revision : item.controlRevision ?? item.revision
  if (!Number.isSafeInteger(expected) || expected < minimum || expected > item.revision) {
    throw new RequirementConflictError(item, expected, snapshot)
  }
}

export class RequirementError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

export class RequirementConflictError extends RequirementError {
  readonly code = 'REQUIREMENT_REVISION_CONFLICT'
  readonly current: Pick<BoardRequirement, 'id' | 'title' | 'description' | 'status' | 'ownerCompanionId' | 'revision' | 'controlRevision'>
  readonly recovery: string
  constructor(item: BoardRequirement, readonly expectedRevision: number, snapshot: boolean) {
    const recovery = snapshot
      ? '请查询此需求的最新子任务、验收结果及评论，重新核对汇总结论后再 finish；不要只替换版本号提交旧总结。'
      : '请核对返回的最新需求内容和状态，必要时查询子任务，再基于最新 revision 调整操作；不要重复创建需求或盲目重试。'
    super(409, `需求内容已更新（${item.id}，提交版本 ${expectedRevision}，当前版本 ${item.revision}，范围/控制版本 ${item.controlRevision ?? item.revision}，状态 ${item.status}）。${recovery}`)
    this.recovery = recovery
    this.current = { id: item.id, title: item.title, description: item.description, status: item.status,
      ...(item.ownerCompanionId ? { ownerCompanionId: item.ownerCompanionId } : {}), revision: item.revision, controlRevision: item.controlRevision ?? item.revision }
  }
}
