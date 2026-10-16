import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react'
import { api } from '../client-api.js'
import type { PushChannelView, PushDelivery } from '../notifications/push-domain.js'
import { errorMessage } from './workspace-components.js'
import { pushDraft, pushDraftSignature } from './push-draft.js'

const statusText: Record<PushDelivery['status'], string> = { pending: '等待发送 / 重试', sending: '发送中', accepted: '服务端已接受', failed: '发送失败', canceled: '已取消' }
export function BarkEditor({ initial, onSaved, onChanged, onDelete, onBusy, onDirty }: {
  initial: PushChannelView; onSaved(channel: PushChannelView): void; onChanged(): Promise<void>; onDelete(channel: PushChannelView): void; onBusy(busy: boolean): void; onDirty(dirty: boolean): void
}): JSX.Element {
  const [form, setForm] = useState(() => pushDraft(initial))
  const [baseline, setBaseline] = useState(() => pushDraftSignature(pushDraft(initial)))
  const [busy, setBusy] = useState(false), [feedback, setFeedback] = useState(''), [failed, setFailed] = useState(false)
  const dirty = pushDraftSignature(form) !== baseline
  const [records, setRecords] = useState<PushDelivery[]>()
  const [confirmClear, setConfirmClear] = useState(false)
  useLayoutEffect(() => onDirty(dirty), [dirty, onDirty])
  const recordsOpen = records !== undefined
  useEffect(() => {
    if (!recordsOpen || !initial.id || busy) return
    let active = true, loading = false
    const timer = window.setInterval(() => {
      if (loading || document.hidden) return
      loading = true
      void api<PushDelivery[]>(`/push-channels/${initial.id}/deliveries`).then(rows => { if (active) setRecords(rows) }).catch(() => {}).finally(() => { loading = false })
    }, 5000)
    return () => { active = false; clearInterval(timer) }
  }, [recordsOpen, initial.id, busy])
  const update = (patch: Partial<typeof form>) => { setForm(f => ({ ...f, ...patch })); setFeedback('') }
  const target = (index: number, patch: Partial<typeof form.targets[number]>) => update({ targets: form.targets.map((t, i) => i === index ? { ...t, ...patch } : t) })
  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true); onBusy(true); setFeedback(''); setFailed(false)
    try { await action() } catch (e) { setFailed(true); setFeedback(errorMessage(e)) }
    finally { setBusy(false); onBusy(false) }
  }
  const save = async () => {
    const saved = await api<PushChannelView>(initial.id ? `/push-channels/${initial.id}` : '/push-channels', { method: initial.id ? 'PUT' : 'POST', body: JSON.stringify(form) })
    const draft = pushDraft(saved)
    setForm(draft); setBaseline(pushDraftSignature(draft)); onSaved(saved)
    try { await onChanged() }
    catch { setFailed(true); setFeedback('渠道已保存，但列表刷新失败。请刷新页面，无需重复保存。'); return }
    setFeedback('已保存，下一次完成事件起自动通知。')
  }
  const importAddress = (index: number, value: string): boolean => {
    if (!/^https?:\/\//i.test(value)) return false
    try {
      const url = new URL(value.trim()), segments = url.pathname.split('/').filter(Boolean), key = segments.pop()
      if (!key || !/^[A-Za-z0-9_-]+$/.test(key) || ['push','ping'].includes(key) || url.search || url.hash || url.username || url.password) throw Error()
      url.pathname = segments.length ? `/${segments.join('/')}` : '/'
      const baseUrl = url.toString().replace(/\/$/, '')
      if (form.targets.some((t,i) => i !== index && (t.configured || t.key)) && form.baseUrl && baseUrl !== form.baseUrl.replace(/\/$/, '')) {
        setFailed(true); setFeedback('此地址属于另一个服务器，请另建 Bark 渠道。'); return true
      }
      update({ baseUrl, targets: form.targets.map((t,i) => i === index ? { ...t, key } : t) }); return true
    } catch { setFailed(true); setFeedback('请粘贴“服务器/设备Key”地址，不包含通知标题、正文或查询参数。'); return true }
  }
  return <form className="dsh-partner-feature-form dsh-partner-channel-form dsh-partner-push-form" aria-busy={busy} onSubmit={e => { e.preventDefault(); void run(save) }}>
    <div className="dsh-partner-push-heading"><label className="dsh-partner-check"><input type="checkbox" checked={form.enabled} disabled={busy} onChange={e => update({ enabled: e.target.checked })}/><i aria-hidden="true"/><span>启用完成通知</span></label><small>单向推送，不接收回复</small></div>
    <div className="dsh-partner-push-fields">
      <Field label="渠道名称"><input disabled={busy} maxLength={80} value={form.name} onChange={e => update({ name: e.target.value })} placeholder="例如：我的 Bark" /></Field>
      <Field label="服务器地址"><input disabled={busy} required type="url" value={form.baseUrl} onChange={e => update({ baseUrl: e.target.value })} placeholder="https://api.day.app" /></Field>
    </div>
    <p>支持自建或内网地址，但必须能从 DSH 服务端访问。HTTP 会明文传输 Key，建议使用 HTTPS。</p>
    <div className="dsh-partner-push-heading"><strong>发送目标</strong><button type="button" disabled={busy || form.targets.length >= 50} onClick={() => update({ targets: [...form.targets, { id: '', name: '', key: '', enabled: true, configured: false }] })}>添加目标</button></div>
    <div className="dsh-partner-push-targets">
      {form.targets.map((t, index) => <div className="dsh-partner-push-target" key={t.id || `new-${index}`}>
        <label className="dsh-partner-push-enable dsh-partner-check"><input type="checkbox" disabled={busy} checked={t.enabled} onChange={e => target(index, { enabled: e.target.checked })} aria-label={`启用目标 ${index+1}`}/><i aria-hidden="true"/></label>
        <Field label={`设备名称 ${index+1}`}><input disabled={busy} maxLength={80} value={t.name} onChange={e => target(index, { name: e.target.value })} placeholder="我的 iPhone" /></Field>
        <Field label={`Device Key ${index+1}`}><input disabled={busy} type="password" autoComplete="new-password" required={!t.configured} value={t.key} onChange={e => { if (!importAddress(index, e.target.value)) target(index, { key: e.target.value }) }} onPaste={e => { const value=e.clipboardData.getData('text'); if (/^https?:\/\//i.test(value)) { e.preventDefault(); importAddress(index,value) } }} placeholder={t.configured ? '已保存 · 留空不修改' : '设备 Key 或完整推送地址'} /></Field>
        <div className="dsh-partner-push-target-actions"><button type="button" disabled={busy || dirty || !t.id} title={dirty ? '请先保存配置再测试' : '向此设备发送测试通知'} onClick={() => void run(async () => {
          const result = await api<{ message: string }>(`/push-channels/${initial.id}/test`, { method: 'POST', body: JSON.stringify({ targetId: t.id }) }); setFeedback(result.message)
        })}>测试</button><button type="button" disabled={busy || form.targets.length === 1} aria-label={`移除目标 ${index+1}`} onClick={() => update({ targets: form.targets.filter((_,i) => i !== index) })}>移除</button></div>
      </div>)}
    </div>
    <small>保存后可逐个测试。修改或停用渠道会取消旧的待发送通知，避免改发到新设备。</small>
    <details><summary>高级选项</summary><div className="dsh-partner-push-fields">
      <Field label="通知内容"><select disabled={busy} value={form.content} onChange={e => update({ content: e.target.value as 'summary' | 'title' })}><option value="summary">标题和简短摘要</option><option value="title">仅标题，隐藏结果内容</option></select></Field>
      <Field label="通知分组"><input disabled={busy} maxLength={80} value={form.group} onChange={e => update({ group: e.target.value })} placeholder="DSH 伙伴" /></Field>
      <Field label="提示音名称"><input disabled={busy} maxLength={80} value={form.sound} onChange={e => update({ sound: e.target.value })} placeholder="留空使用设备默认声音" /></Field>
      <Field label="点击跳转地址"><input disabled={busy} type="url" value={form.openUrl} onChange={e => update({ openUrl: e.target.value })} placeholder="手机可访问的 DSH 地址（可选）" /></Field>
    </div><label className="dsh-partner-check"><input type="checkbox" disabled={busy} checked={form.notifyProblems} onChange={e => update({ notifyProblems: e.target.checked })}/><i aria-hidden="true"/><span>同时通知最终失败或需要处理的受阻结果</span></label></details>
    {feedback && <p role={failed ? 'alert' : 'status'}>{feedback}</p>}
    <footer>{initial.id && <><button type="button" disabled={busy} className="is-danger" onClick={() => onDelete(initial)}>删除渠道</button><button type="button" disabled={busy} onClick={() => void run(async () => setRecords(await api<PushDelivery[]>(`/push-channels/${initial.id}/deliveries`)))}>发送记录</button></>}<button className="is-primary" disabled={busy || !dirty}>{busy ? '处理中…' : '保存渠道'}</button></footer>
    {records && <section className="dsh-partner-push-records"><div className="dsh-partner-push-heading"><strong>最近发送记录 · 自动更新</strong><button type="button" onClick={() => setRecords(undefined)}>收起</button></div>
      <div className="dsh-partner-push-heading"><small>仅保留最近记录；重试不会重发已成功的目标。</small><button type="button" disabled={busy} onClick={() => setConfirmClear(true)}>清理已结束记录</button></div>
      {confirmClear && <div role="group" aria-label="确认清理发送记录"><p>只清理已接受和已取消的记录，待发送和失败记录保留。</p><button type="button" disabled={busy} onClick={() => setConfirmClear(false)}>取消</button><button type="button" disabled={busy} onClick={() => void run(async () => { await api(`/push-channels/${initial.id}/deliveries`, {method:'DELETE'}); setRecords(await api<PushDelivery[]>(`/push-channels/${initial.id}/deliveries`)); setConfirmClear(false); await onChanged() })}>确认清理</button></div>}
      {!records.length && <p>暂无通知。保存只影响之后的新结果，不补发历史对话。</p>}
      {records.map(row => <div key={row.id}><span><strong>{row.title}</strong><small>{new Date(row.createdAt).toLocaleString()} · {form.targets.find(t=>t.id===row.targetId)?.name ?? '已移除目标'} · {statusText[row.status]}</small>{row.lastError && <small>{row.lastError}</small>}</span>
        {row.status === 'failed' && <button type="button" disabled={busy} onClick={() => void run(async () => { await api(`/push-channels/${initial.id}/deliveries/${row.id}/retry`, { method:'POST' }); setRecords(await api<PushDelivery[]>(`/push-channels/${initial.id}/deliveries`)); await onChanged() })}>重试</button>}</div>)}
    </section>}
  </form>
}
function Field({ label, children }: { label: string; children: ReactNode }): JSX.Element { return <label className="dsh-partner-channel-field"><span>{label}</span>{children}</label> }
