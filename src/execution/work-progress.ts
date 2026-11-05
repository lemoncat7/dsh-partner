import { appendPluginRecord, type Session } from '@deepseek-ai/dsh-session'
import type { WorkProgress, WorkProgressPhase } from './work-progress-state.js'
const safeName = (value: unknown): string => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value) ? value : '工具'
function activity(raw: unknown): { label: string; catalogue: boolean } {
  const a = raw && typeof raw === 'object' ? raw as { action?: unknown; name?: unknown } : {}
  return a.action === 'list' ? { label: '查找可用工具', catalogue: true }
    : a.action === 'describe' ? { label: `查看 ${safeName(a.name)} 参数`, catalogue: true }
    : { label: safeName(a.name), catalogue: false }
}

/** UI-only, ignorable records: no arguments, results, model prose or surface edits. */
export class WorkProgressReporter {
  private state: WorkProgress
  private nextId = 0
  private closed = false
  constructor(private session: Session, id: string, private now = Date.now) {
    const at = now()
    this.state = { id, phase: 'queued', startedAt: at, updatedAt: at, completed: 0, failed: 0, catalogue: 0, active: [], recent: [] }
    this.publish()
  }
  private publish(): void {
    try { appendPluginRecord(this.session, 'plugin:dsh-partner/work-progress', structuredClone(this.state)) }
    catch { /* A presentation observer or unavailable history must never interrupt work. */ }
  }
  started(): void {
    if (this.closed) return
    this.state.phase = 'waiting'; this.state.updatedAt = this.now(); this.publish()
  }
  async track<T>(raw: unknown, execute: () => Promise<T>): Promise<T> {
    if (this.closed) return execute()
    const item = activity(raw), id = ++this.nextId
    this.state.active.push({ id, label: item.label }); this.state.phase = 'tool'
    this.state.updatedAt = this.now(); this.publish()
    let failed = true
    try {
      const value = await execute()
      failed = !!(value && typeof value === 'object' && 'dispatch' in value && (value as {dispatch?:{isError?:boolean}}).dispatch?.isError)
      return value
    } finally {
      if (!this.closed) {
        this.state.active = this.state.active.filter(a=>a.id!==id)
        this.state.completed++; if (failed) this.state.failed++; if (item.catalogue) this.state.catalogue++
        this.state.recent = [...this.state.recent, {label:item.label,failed}].slice(-5)
        this.state.phase = this.state.active.length ? 'tool' : 'waiting'
        this.state.updatedAt = this.now(); this.publish()
      }
    }
  }
  finish(phase: Exclude<WorkProgressPhase, 'queued'|'waiting'|'tool'>): void {
    if (this.closed) return
    this.closed = true
    this.state.phase = phase; this.state.endedAt = this.now(); this.state.updatedAt = this.state.endedAt
    this.state.active = []; this.publish()
  }
}
