import type { BoardTaskView } from '../client-api.js'
import type { TaskReviewCheck } from '../tasks/contract.js'

/** Compact read view; only an explicit review exposes per-item controls. */
export function TaskContractPanel({ task, checks, setChecks, busy }: { task: BoardTaskView; checks: TaskReviewCheck[]; setChecks(value: TaskReviewCheck[]): void; busy: boolean }): JSX.Element | null {
  if (!task.acceptanceCriteria?.length && !task.resourceKeys?.length) return null
  const editing = task.status === 'review'
  const change = (criterion: number, patch: Partial<TaskReviewCheck>): void => setChecks((task.acceptanceCriteria ?? []).map((_, i) => ({ criterion: i + 1, verdict: 'unverified' as const, ...checks.find(c => c.criterion === i + 1), ...(criterion === i + 1 ? patch : {}) })))
  return <section className="dsh-partner-task-contract">{Boolean(task.acceptanceCriteria?.length) && <header><strong>验收清单 · {task.acceptanceCriteria?.length}</strong><small>伙伴 / 人工核验，不等于程序验证</small></header>}
    <ol>{task.acceptanceCriteria?.map((text, i) => {
      const criterion = i + 1, check = checks.find(c => c.criterion === criterion)
      const saved = task.reviewChecks?.find(c => c.criterion === criterion)
      const previous = task.previousAttempt?.reviewChecks?.find(c => c.criterion === criterion)
      const evidence = (task.evidence ?? []).filter(e => e.criterion === criterion)
      return <li key={criterion}><p>{text}</p>
        {evidence.length > 0 && <details className="dsh-partner-requirement-disclosure"><summary>执行证据 · {evidence.length} · 尚需核验</summary>{evidence.map((e, j) => <div key={j}><code>{e.reference}</code>{e.note && <small>{e.note}</small>}</div>)}</details>}
        {previous?.reason && <small>上次核验：{previous.reason}</small>}
        {editing ? <div className="dsh-partner-task-fields">
          <label><span>第 {criterion} 项结论</span><select disabled={busy} value={check?.verdict ?? 'unverified'} onChange={e => change(criterion, { verdict: e.target.value as TaskReviewCheck['verdict'] })}><option value="unverified">未验证</option><option value="passed">已核验通过</option><option value="failed">未通过</option></select></label>
          <label><span>{check?.verdict === 'passed' ? '实际核验证据' : '缺项 / 无法核验的原因'}</span><textarea rows={2} maxLength={1000} disabled={busy} value={(check?.verdict === 'passed' ? check.evidence : check?.reason) ?? ''} onChange={e => change(criterion, check?.verdict === 'passed' ? { evidence: e.target.value } : { reason: e.target.value })} /></label>
        </div> : saved && <small>{saved.verdict === 'passed' ? '核验通过' : saved.verdict === 'failed' ? '未通过' : '未验证'} · {saved.evidence ?? saved.reason}</small>}
      </li>
    })}</ol>
    {task.resourceKeys?.length ? <details className="dsh-partner-requirement-disclosure"><summary>独占资源声明 · {task.resourceKeys.length}</summary>{task.resourceKeys.map(key => <code key={key}>{key}</code>)}<small>仅约束看板内相同声明，不是操作系统锁。</small></details> : null}
  </section>
}
