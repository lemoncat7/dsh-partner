import { oneOf, optionalText, record, requiredText, stringList } from '../core/validation.js'

export interface TaskEvidence { criterion: number; reference: string; note?: string }
export interface TaskReviewCheck { criterion: number; verdict: 'passed' | 'failed' | 'unverified'; evidence?: string; reason?: string }

export function acceptanceCriteria(value: unknown): string[] { return stringList(value, 'acceptanceCriteria', 20, 500) }
export function resourceKeys(value: unknown): string[] { return stringList(value, 'resourceKeys', 12, 200).sort() }

export function taskEvidence(value: unknown, criteria: readonly string[]): TaskEvidence[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 40) throw new Error('evidence 最多 40 项')
  return value.map(raw => {
    const item = record(raw, 'evidence')
    const criterion = criterionIndex(item.criterion, criteria)
    const reference = requiredText(item.reference, 'reference', 1000)
    const note = optionalText(item.note, 'note', 500)
    return { criterion, reference, ...(note ? { note } : {}) }
  })
}

/** Checks report structure, not file contents or the truth of a model claim. */
export function reviewChecks(value: unknown, criteria: readonly string[], accepting: boolean): TaskReviewCheck[] {
  if (value === undefined && !criteria.length) return []
  if (!Array.isArray(value) || value.length > 20) throw new Error('请逐项提供 checks 核验结果；未核验不得通过')
  const seen = new Set<number>()
  const checks = value.map(raw => {
    const item = record(raw, 'check'), criterion = criterionIndex(item.criterion, criteria)
    if (seen.has(criterion)) throw new Error('核验项编号重复')
    seen.add(criterion)
    const verdict = oneOf(item.verdict, ['passed', 'failed', 'unverified'] as const, 'verdict')
    const evidence = optionalText(item.evidence, 'evidence', 1000), reason = optionalText(item.reason, 'reason', 1000)
    if (verdict === 'passed' && !evidence) throw new Error('通过验收项必须填写实际核验证据')
    if (verdict !== 'passed' && !reason) throw new Error('未通过项必须说明缺项或无法核验的原因')
    return { criterion, verdict, ...(evidence ? { evidence } : {}), ...(reason ? { reason } : {}) }
  })
  if (accepting && (checks.length !== criteria.length || checks.some(item => item.verdict !== 'passed'))) throw new Error('全部验收项实际核验通过后才能完成；缺项请打回或标记未验证')
  if (!accepting && criteria.length && !checks.some(item => item.verdict !== 'passed')) throw new Error('打回时至少说明一个未通过或未验证的验收项')
  return checks
}

function criterionIndex(value: unknown, criteria: readonly string[]): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > criteria.length) throw new Error('验收项编号不存在，请读取当前任务')
  return value as number
}

export const contractParameters = {
  acceptanceCriteria: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 500 }, description: 'Ordered, objectively reviewable deliverables. Evidence/checks use 1-based criterion numbers. Changes invalidate prior execution/review.' },
  resourceKeys: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 200 }, description: 'Exclusive shared-resource labels, e.g. repo:team/api or service:staging. Use the SAME canonical label for overlapping writes. Scheduler serializes matching labels; declarations are not OS locks or permissions.' },
}
export const checksParameter = { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['criterion', 'verdict'], properties: {
  criterion: { type: 'integer', minimum: 1 }, verdict: { type: 'string', enum: ['passed', 'failed', 'unverified'] }, evidence: { type: 'string' }, reason: { type: 'string' },
} }, description: 'Reviewer assessments, not machine verification. accept requires every criterion passed with actual evidence; reject identifies failed/unverified items and required corrections.' }
