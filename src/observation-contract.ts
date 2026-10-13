/** Provider-neutral observation outcomes. None of these grants tool access. */
export const CHECK_OUTCOMES = ['changed', 'unchanged', 'already_processed', 'baseline_initialized', 'blocked'] as const
export const FAILURE_KINDS = ['capability_missing', 'authentication', 'rate_limited', 'network', 'source_incomplete', 'unknown'] as const

export function observationCapabilityContext(available: string[], inherited: string[]): string {
  return JSON.stringify({
    availableTools: [...new Set(available)].sort(),
    unavailableInBackground: [...new Set(inherited)].filter(name => !available.includes(name)).sort(),
    instructions: '先读取检查依据，然后核对必须步骤所需能力。本轮继承来源会话的工具能力，实际调用仍受原工具授权检查约束；应使用已授权工具完成必要核验，不能仅因后台运行就判断无权访问。能力可见不等于新增操作授权：仅执行关注明确要求且已授权的操作，不擅自发布、删除或扩大任务范围。缺少必需工具时报告 capability_missing，列出缺失步骤；授权拒绝时报告实际原因，不绕过权限，也不反复检索代替。已有凭据只通过授权方法使用；不要把匿名限流当成凭据无效。',
  })
}

export function observationRetryAt(now: number, intervalMinutes: number, detail?: { kind: string; retryAt?: number }): number {
  const ordinary = now + intervalMinutes * 60_000
  if (detail?.kind !== 'rate_limited' || !Number.isFinite(detail.retryAt)) return ordinary
  // Respect a reported reset time, with a floor to prevent polling loops and
  // a bounded horizon so an invalid remote timestamp cannot suspend forever.
  return Math.max(now + 60_000, Math.min(detail.retryAt!, now + 30 * 86400_000))
}
