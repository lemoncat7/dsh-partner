/** Missing/duplicate/invalid statuses cannot silently become successful no-change checks. */
export function parseObservationStatuses(output: string, expected: Set<string>) {
  const text = output.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '')
  const value = JSON.parse(text) as { observations?: Array<{concernId?: unknown; checkStatus?: unknown; evidence?: unknown}> }
  if (!Array.isArray(value.observations)) throw new Error('关注结果缺少 observations')
  const completed = new Set<string>()
  const blocked: string[] = []
  const reasons: Record<string, string> = {}
  for (const id of expected) {
    const rows = value.observations.filter(item => item?.concernId === id)
    if (rows.length !== 1 || !['completed', 'blocked'].includes(String(rows[0]?.checkStatus))) throw new Error('关注结果缺少明确且唯一的检查状态')
    if (rows[0]!.checkStatus === 'completed') completed.add(id)
    else { blocked.push(id); reasons[id] = typeof rows[0]!.evidence === 'string' ? rows[0]!.evidence.slice(0, 500) : '必须步骤未核实' }
  }
  return { completed, blocked, reasons }
}
