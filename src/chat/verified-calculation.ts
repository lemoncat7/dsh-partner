/** Arithmetic witnesses are checked against a single, already-authorized work record.
 * They verify numeric derivation, not the truth of the surrounding prose.
 */
export interface CalculationSource {
  runId: string
  facts: string[]
  unknowns: string[]
  evidence: string[]
  artifacts: string[]
}
export interface VerifiedClockDifference {
  kind: 'same-day-clock-difference'
  runId: string
  from: string
  to: string
  totalMinutes: number
  hours: number
  minutes: number
}
export const CALCULATION_SCHEMA = {
  type: 'array', maxItems: 8,
  items: {
    type: 'object', additionalProperties: false,
    required: ['kind', 'runId', 'from', 'to'],
    properties: {
      kind: { type: 'string', enum: ['same-day-clock-difference'] },
      runId: { type: 'string', description: '来源工作记录的真实 runId。' },
      from: { type: 'string', description: '来源明确给出的起始时刻，HH:mm。' },
      to: { type: 'string', description: '同一记录中同一天的结束时刻，HH:mm，不早于起始时刻。' },
    },
  },
}
const minutesOf = (value: unknown): number | undefined => {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return
  const [hours, minutes] = value.split(':').map(Number)
  return hours! * 60 + minutes!
}
export function verifyCalculations(raw: unknown, sources: readonly CalculationSource[]): VerifiedClockDifference[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > 8) throw Error('计算依据格式无效')
  return raw.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(k => !['kind', 'runId', 'from', 'to'].includes(k)) || item.kind !== 'same-day-clock-difference') throw Error('不支持的计算依据')
    const source = sources.find(r => r.runId === item.runId)
    if (!source) throw Error('计算引用不属于本次工作结果')
    // Artifacts and source-code/log excerpts cannot establish appointment times.
    const text = source.facts.join('\n')
    const from = minutesOf(item.from), to = minutesOf(item.to)
    const clocks: string[] = text.match(/(?<![\d:+-])(?:[01]\d|2[0-3]):[0-5]\d(?![:\d])/g) ?? []
    if (from === undefined || to === undefined || to < from || !clocks.includes(item.from) || !clocks.includes(item.to)) throw Error('计算时刻缺少来源或涉及跨日')
    const temporalContext = [...source.facts, ...source.unknowns].join('\n')
    const dates = new Set(temporalContext.match(/\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?|\d{1,2}月\d{1,2}日/g) ?? [])
    if (!/当天|当日|同一天|同日|\bsame day\b|\bon that day\b/i.test(text) || dates.size > 1 ||
      /次日|翌日|隔天|明天|昨天|跨日|跨天|隔日|夏令时|冬令时|时区|UTC|GMT|\b(?:tomorrow|yesterday|next day|previous day|timezone|DST)\b|[+-]\d{2}:\d{2}/i.test(temporalContext)) throw Error('来源未明确同日同一时区，不能推算时差')
    const totalMinutes = to - from
    return { kind: 'same-day-clock-difference', runId: source.runId, from: item.from, to: item.to, totalMinutes, hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 }
  })
}
