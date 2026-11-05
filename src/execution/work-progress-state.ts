import type {} from '@deepseek-ai/dsh-session/types'
export type WorkProgressPhase = 'queued' | 'waiting' | 'tool' | 'completed' | 'partial' | 'failed' | 'canceled' | 'timed-out' | 'interrupted'
export interface WorkProgress {
  id: string
  phase: WorkProgressPhase
  startedAt: number
  updatedAt: number
  endedAt?: number
  completed: number
  failed: number
  catalogue: number
  active: Array<{ id: number; label: string }>
  recent: Array<{ label: string; failed: boolean }>
}
declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap { 'plugin:dsh-partner/work-progress': WorkProgress }
}
export const workProgressRunning = (phase: WorkProgressPhase): boolean => ['queued', 'waiting', 'tool'].includes(phase)
export function workProgressOf(event: { type: string; ignorable?: boolean; data: unknown }): WorkProgress | undefined {
  if (event.type !== 'plugin:dsh-partner/work-progress' || event.ignorable !== true) return
  const p = event.data as WorkProgress | null
  if (!p || typeof p.id !== 'string' || !['queued','waiting','tool','completed','partial','failed','canceled','timed-out','interrupted'].includes(p.phase) ||
    ![p.startedAt,p.updatedAt,p.completed,p.failed,p.catalogue].every(n=>Number.isFinite(n)&&n>=0) ||
    p.endedAt !== undefined && (!Number.isFinite(p.endedAt)||p.endedAt<p.startedAt) ||
    !Array.isArray(p.active) || !p.active.every(a=>a&&Number.isFinite(a.id)&&typeof a.label==='string') ||
    !Array.isArray(p.recent) || !p.recent.every(a=>a&&typeof a.label==='string'&&typeof a.failed==='boolean')) return
  return p
}
export function workProgressLabel(p: WorkProgress): string {
  if (p.phase === 'tool') return p.active.length > 1 ? `正在执行 ${p.active.length} 个操作` : `正在执行：${p.active[0]?.label ?? '工具'}`
  return ({queued:'等待工作上下文启动',waiting:'等待模型继续',completed:'工作已完成',partial:'工作结束 · 部分完成',failed:'工作失败',canceled:'工作已取消','timed-out':'工作已超时',interrupted:'工作已中断'} as const)[p.phase]
}
