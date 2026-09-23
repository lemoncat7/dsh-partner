import type { ScheduledPartnerTask } from './domain.js'

/** Only inspect explicitly named MCP tools; never grant tools or infer secrets. */
export function assertWakeTools(entry: ScheduledPartnerTask, available: Iterable<string>): void {
  const names = new Set(available)
  const required = new Set(['partner_schedule', ...(entry.continuation?.check.match(/\bmcp__[A-Za-z0-9_]+\b/g) ?? [])])
  const missing = [...required].filter(name => !names.has(name))
  if (missing.length) throw new WakeToolsUnavailable(`续接工具未就绪：${missing.join('、')}；未发送唤醒，请检查伙伴能力与 MCP 绑定后重试`)
}

export class WakeToolsUnavailable extends Error {}

export function completionCondition(entry: ScheduledPartnerTask): string {
  return entry.continuation?.completion ?? '仅核实本预约对应的外部任务已经成功完成，且产出可回查。检查说明中混入的后续提交、下载、合并、发送或整个 Goal 均不属于本预约完成条件；失败按 blocked 处理。'
}
