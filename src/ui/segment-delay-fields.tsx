import { useId } from 'react'
import type { CharacterCard } from '../character/domain.js'

export function SegmentDelayFields({ card, onChange }: { card: CharacterCard; onChange(card: CharacterCard): void }): JSX.Element {
  const id = useId(), range = card.segmentDelay ?? { enabled: false, minSeconds: 1, maxSeconds: 3 }
  const invalid = !Number.isFinite(range.minSeconds) || !Number.isFinite(range.maxSeconds) || range.minSeconds < 0 || range.maxSeconds > 60 || range.minSeconds > range.maxSeconds
  return <div className="dsh-partner-segment-delay">
    <label className="dsh-partner-character-check"><input type="checkbox" disabled={!card.segmentedReplies} checked={range.enabled} onChange={e => onChange({ ...card, segmentDelay: { ...range, enabled: e.target.checked } })} /><span>分段随机间隔</span></label>
    {range.enabled && <div className="dsh-partner-segment-range">
      <label>最短<input aria-describedby={id} aria-invalid={invalid} disabled={!card.segmentedReplies} type="number" min="0" max="60" step="0.1" value={Number.isFinite(range.minSeconds) ? range.minSeconds : ''} onChange={e => onChange({ ...card, segmentDelay: { ...range, minSeconds: e.target.valueAsNumber } })}/></label>
      <span aria-hidden="true">—</span>
      <label>最长<input aria-describedby={id} aria-invalid={invalid} disabled={!card.segmentedReplies} type="number" min="0" max="60" step="0.1" value={Number.isFinite(range.maxSeconds) ? range.maxSeconds : ''} onChange={e => onChange({ ...card, segmentDelay: { ...range, maxSeconds: e.target.valueAsNumber } })}/></label><span>秒</span>
    </div>}
    <small id={id}>{range.enabled && invalid ? <span role="alert" className="dsh-partner-inline-error">请输入 0～60 秒，最短不能大于最长</span> : !card.segmentedReplies ? '启用分段回复后可用，已有间隔设置会保留。' : '首条立即发送，后续每条随机等待；默认关闭，不额外调用模型。'}</small>
  </div>
}
