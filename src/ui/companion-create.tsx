import { useState, type FormEvent } from 'react'
import { IconPlusOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { WorkspaceDialog, WorkspaceNotice, errorMessage } from './workspace-components.js'

export interface NewCompanionDraft {
  name: string
  role: string
  description: string
  instructions: string
}

export function CompanionCreateDialog({ close, create }: { close(): void; create(value: NewCompanionDraft): Promise<void> }): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    setBusy(true); setError(undefined)
    try {
      await create({
        name: String(data.get('name') ?? '').trim(),
        role: String(data.get('role') ?? '').trim(),
        description: String(data.get('description') ?? '').trim(),
        instructions: String(data.get('instructions') ?? '').trim(),
      })
    } catch (reason) { setError(errorMessage(reason)) } finally { setBusy(false) }
  }
  return <WorkspaceDialog title="新建伙伴" detail="先建立清晰的身份和职责。模型、工具、Skill 与协作权限会在创建后单独配置。" close={close} width="wide">
    <form className="dsh-partner-feature-form dsh-partner-companion-create-form" aria-busy={busy} onSubmit={event => { void submit(event) }}>
      <label><span>伙伴名字</span><input name="name" required maxLength={60} autoFocus placeholder="例如：小黑" /></label>
      <label><span>主要角色</span><input name="role" required maxLength={120} placeholder="例如：产品与工程协作伙伴" /></label>
      <label className="is-wide"><span>一句话定位</span><input name="description" maxLength={500} placeholder="它主要负责什么，什么时候应该找它" /></label>
      <label className="is-wide"><span>初始行为准则</span><textarea name="instructions" maxLength={12000} rows={7} placeholder="写清职责、表达方式、工作边界和交付标准；也可以创建后再完善" /></label>
      {error && <WorkspaceNotice>{error}</WorkspaceNotice>}
      <footer><button type="button" disabled={busy} onClick={close}>取消</button><button type="submit" className="is-primary" disabled={busy}><IconPlusOutline16 size={14} />{busy ? '正在创建…' : '创建伙伴'}</button></footer>
    </form>
  </WorkspaceDialog>
}
