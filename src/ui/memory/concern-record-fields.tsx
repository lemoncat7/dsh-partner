import type {ConcernRecordTargetView} from '../../client-api.js'
import {RecordTargetPicker} from './record-target-picker.js'

/** Shared by creation and editing, so recording semantics stay consistent. */
export function ConcernRecordFields({companionId, reason, onReason, target, onTarget}: {
  companionId: string; reason: string; onReason(value: string): void
  target: ConcernRecordTargetView | undefined; onTarget(value?: ConcernRecordTargetView): void
}) {
  return <>
    <label><span>执行说明与记录格式</span><textarea rows={5} value={reason} maxLength={800} onChange={event => onReason(event.target.value)} placeholder="例如：按照关联文档检查；结果按日期整理成表格，更新对应条目，保留人工备注。" /><small>说明如何检查、何时提醒，以及结果如何整理。可留空，最多 800 字。</small></label>
    <RecordTargetPicker companionId={companionId} value={target} onChange={onTarget} />
  </>
}
