import {useId} from 'react'

export const DEFAULT_CONCERN_EXECUTION = '根据本条关注的要求、检查依据和核验后的变化结果，使用已授权工具完成相关操作；没有实质变化不重复执行，超出授权的操作先询问用户。'

export function ConcernExecutionFields({value, onChange, disabled}: {value: string | null; onChange(value: string | null): void; disabled: boolean}) {
  const hint = useId()
  return <section className="dsh-partner-concern-execution">
    <header><span><strong>有变化时交给伙伴处理</strong><small id={hint}>关注只负责检查；开启后，将关注要求、依据和检查结果交给所属伙伴执行。</small></span><button type="button" className="dsh-partner-switch" role="switch" aria-label="有变化时交给伙伴处理" aria-describedby={hint} aria-checked={value !== null} data-on={value !== null} disabled={disabled} onClick={() => onChange(value === null ? DEFAULT_CONCERN_EXECUTION : null)}><i /></button></header>
    {value !== null && <label><span>后续执行要求</span><textarea rows={3} required maxLength={4000} value={value} disabled={disabled} onChange={event => onChange(event.target.value)} /><small>例如：有合适选题时生成文章并上传公众号草稿，不公开发布。同一变化不重复交办；关闭不取消已交办任务。</small></label>}
  </section>
}
