import { CHECK_OUTCOMES, FAILURE_KINDS } from './observation-contract.js'
/** Missing/duplicate/invalid statuses cannot silently become successful no-change checks. */
export function parseObservationStatuses(output: string, expected: Set<string>) {
  const text = output.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '')
  const value = JSON.parse(text) as { observations?: Array<{concernId?: unknown; checkStatus?: unknown; evidence?: unknown; outcome?: unknown; changed?: unknown; failureKind?: unknown; retryAt?: unknown; executionNeeded?: unknown; executionKey?: unknown; event?: unknown; source?: unknown}> }
  if (!Array.isArray(value.observations)) throw new Error('关注结果缺少 observations')
  const completed = new Set<string>()
  const blocked: string[] = []
  const reasons: Record<string, string> = {}
  const failures: Record<string, { kind: string; retryAt?: number }> = {}
  const outcomes: Record<string, string> = {}
  for (const id of expected) {
    const rows = value.observations.filter(item => item?.concernId === id)
    if (rows.length !== 1 || !['completed', 'blocked'].includes(String(rows[0]?.checkStatus))) throw new Error('关注结果缺少明确且唯一的检查状态')
    const row = rows[0]!
    const outcome = row.outcome ?? (row.checkStatus === 'blocked' ? 'blocked' : row.changed ? 'changed' : 'unchanged')
    if (!(CHECK_OUTCOMES as readonly unknown[]).includes(outcome)
      || (outcome === 'blocked') !== (row.checkStatus === 'blocked')
      || (row.changed === true && outcome !== 'changed')
      || (outcome === 'changed' && row.changed !== true)) throw new Error('关注结果状态矛盾：基线初始化、已处理、无变化不能标成新增')
    outcomes[id] = String(outcome)
    if (row.executionNeeded !== undefined && typeof row.executionNeeded !== 'boolean') throw new Error('关注执行判定必须是布尔值')
    if (row.executionNeeded === true && (row.checkStatus !== 'completed' || outcome === 'already_processed'
      || ![row.executionKey, row.event, row.evidence, row.source].every(v => typeof v === 'string' && v.trim().length > 0)
      || String(row.executionKey).length > 400)) throw new Error('关注待执行事项缺少稳定标识或证据，或与检查状态矛盾')
    if (row.checkStatus === 'blocked') {
      const kind = (FAILURE_KINDS as readonly unknown[]).includes(row.failureKind) ? String(row.failureKind) : 'unknown'
      const retryAt = typeof row.retryAt === 'string' ? Date.parse(row.retryAt) : NaN
      failures[id] = { kind, ...(Number.isFinite(retryAt) ? { retryAt } : {}) }
    }
    if (rows[0]!.checkStatus === 'completed') completed.add(id)
    else { blocked.push(id); reasons[id] = typeof rows[0]!.evidence === 'string' ? rows[0]!.evidence.slice(0, 500) : '必须步骤未核实' }
  }
  return { completed, blocked, reasons, failures, outcomes }
}
