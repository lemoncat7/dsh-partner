import {useState} from 'react'
import {IconCheckOutlineRegular} from '@deepseek-ai/dsh-client-ui-primitives'
import type {ModelCatalogView, PartnerSnapshot} from '../client-api.js'
import {FormField} from './partner-components.js'
import {WorkspaceDialog} from './workspace-components.js'

type RuntimeSelection = {presetId: string; provider: string; model: string}

/** Presentation only: CapabilityEditor retains autosave, rollback and permissions. */
export function RuntimeSettings({value, catalog, presets, saving, error, saved, change}: {
  value: RuntimeSelection; catalog: ModelCatalogView | undefined; presets: PartnerSnapshot['presets']
  saving: boolean; error: string | undefined; saved: boolean; change(patch: Partial<RuntimeSelection>): void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const providerId = value.provider || catalog?.defaultSelection.provider || ''
  const provider = catalog?.providers.find(item => item.id === providerId)
  const models = provider?.models ?? []
  const presetName = presets.find(item => item.id === value.presetId)?.name || value.presetId || '跟随 DSH 默认'
  const modelId = value.model || catalog?.defaultSelection.model || ''
  const modelName = models.find(item => item.id === modelId)?.name || modelId || '跟随 DSH 默认'
  const providerName = provider?.name || providerId
  const missingModel = Boolean(value.model) && !models.some(item => item.id === value.model)
  const normalized = query.trim().toLocaleLowerCase()
  const filtered = models.filter(item => `${item.name} ${item.id}`.toLocaleLowerCase().includes(normalized))
  const close = (): void => {if (!saving) setOpen(false)}
  return <>
    <section className="dsh-partner-runtime-summary" aria-label="运行配置">
      <span><small>Agent Preset</small><strong title={presetName}>{presetName}</strong></span>
      <span><small>模型{providerName ? ` · ${providerName}` : ''}</small><strong title={`${providerName} / ${modelName}`}>{modelName}</strong></span>
      <button type="button" disabled={saving} aria-haspopup="dialog" onClick={() => {setQuery(''); setOpen(true)}} aria-label="调整运行配置">调整</button>
    </section>
    {open && <WorkspaceDialog eyebrow="" title="运行配置" detail="选择自动保存；作为会话默认配置，不覆盖已有会话的选择。" close={close} className="dsh-partner-runtime-dialog">
      <div className="dsh-partner-runtime-editor">
        <div className="dsh-partner-runtime-options">
          <FormField label="Agent Preset"><select aria-label="Agent Preset" disabled={saving} value={value.presetId} onChange={event => change({presetId: event.target.value})}>
            <option value="">跟随 DSH 默认</option>
            {value.presetId && !presets.some(item => !item.broken && item.id === value.presetId) && <option value={value.presetId}>当前配置 · {value.presetId}</option>}
            {presets.filter(item => !item.broken).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></FormField>
          <FormField label="模型提供方"><select aria-label="模型提供方" disabled={saving || !catalog} value={value.provider} onChange={event => {setQuery(''); change({provider: event.target.value, model: ''})}}>
            <option value="">跟随 DSH 默认{catalog?.defaultSelection.provider ? ` · ${catalog.defaultSelection.provider}` : ''}</option>
            {value.provider && !catalog?.providers.some(item => item.id === value.provider) && <option value={value.provider}>当前配置 · {value.provider}</option>}
            {catalog?.providers.map(item => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}
          </select></FormField>
        </div>
        <label className="dsh-partner-runtime-search"><span>选择模型</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索模型名称或 ID" /></label>
        <div className="dsh-partner-runtime-models" role="group" aria-label="可用模型" aria-busy={saving}>
          {[{id: '', name: '跟随 DSH 默认模型', detail: catalog?.defaultSelection.model || '使用默认配置'}, ...(missingModel ? [{id: value.model, name: value.model, detail: '当前配置 · 不在模型目录中'}] : []), ...filtered.map(item => ({...item, detail: item.id}))].map(item => <button type="button" key={item.id} disabled={saving} aria-pressed={item.id === value.model} onClick={() => {if (item.id !== value.model) change({model: item.id})}}>
            <span><strong>{item.name || item.id}</strong><small>{item.detail}</small></span><i aria-hidden="true">{item.id === value.model && <IconCheckOutlineRegular size={16} />}</i>
          </button>)}
          {!catalog && <p role="status">模型目录尚未就绪，请稍后重开或刷新页面。</p>}
          {catalog && !filtered.length && <p role="status">{query ? '没有匹配的模型，试试其他关键词。' : '当前提供方没有可选模型。'}</p>}
        </div>
        <footer><span role="status">{saving ? '正在保存…' : error ? '保存未成功' : saved ? '已保存，下一轮生效' : '选择自动保存'}</span></footer>
        {error && <p className="dsh-partner-inline-error" role="alert">{error}</p>}
      </div>
    </WorkspaceDialog>}
  </>
}
