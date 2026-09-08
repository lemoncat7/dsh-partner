import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { IconAgentPresetOutline16, IconCheckOutline14, IconPlusOutline16, IconRefreshOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { WorkspaceBlock, WorkspaceHero, WorkspaceNotice, errorMessage } from '../ui/workspace-components.js'
import { DEFAULT_PENDANT_SETTINGS, normalizePendantSettings, samePendantSettings, type StrapMaterial, type PendantFps, type CardImageFit } from './settings.js'
import { savePendantSettings, usePendantSettings } from './use-settings.js'
import { prepareCardImage } from './card-image.js'
import { StrapPreview } from './strap-preview.js'

const MATERIALS: Array<{ id: StrapMaterial; name: string; detail: string }> = [
  { id: 'woven', name: '织带', detail: '细密织纹' }, { id: 'braided', name: '编织绳', detail: '圆润绳股' }, { id: 'leather', name: '皮革', detail: '平整缝线' },
]
const FRAME_RATES: Array<{ fps: PendantFps; label: string }> = [{ fps: 24, label: '省电' }, { fps: 30, label: '均衡' }, { fps: 60, label: '流畅' }]
const IMAGE_FITS: Array<{ fit: CardImageFit; label: string; detail: string }> = [{ fit: 'contain', label: '完整显示', detail: '自适应 · 不裁切' }, { fit: 'cover', label: '铺满裁切', detail: '居中 · 无留白' }]
const COLORS = ['#617e73', '#46515b', '#b7afa0', '#997365', '#647c98', '#807388']

export function PendantSettingsPanel(): JSX.Element {
  const settings = usePendantSettings(), [draft, setDraft] = useState(() => ({ ...settings }))
  const [error, setError] = useState(''), [saved, setSaved] = useState(false), [processing, setProcessing] = useState(false)
  const file = useRef<HTMLInputElement>(null), epoch = useRef(0)
  const strapFile = useRef<HTMLInputElement>(null)
  const previous = useRef(settings)
  useEffect(() => {
    const before = previous.current
    previous.current = settings
    // Follow other tabs when clean; never discard a local edit or pending image.
    setDraft(value => samePendantSettings(value, before) ? { ...settings } : value)
  }, [settings])
  useEffect(() => () => { epoch.current++ }, [])
  const update = (patch: Partial<typeof draft>): void => { setDraft(value => ({ ...value, ...patch })); setSaved(false); setError('') }
  const validColor = /^#[0-9a-f]{6}$/i.test(draft.color)
  const previewColor = validColor ? draft.color : DEFAULT_PENDANT_SETTINGS.color
  const dirty = !samePendantSettings(draft, settings)
  const upload = async (event: ChangeEvent<HTMLInputElement>, target: 'image' | 'strapImage' = 'image'): Promise<void> => {
    const selected = event.currentTarget.files?.[0]; event.currentTarget.value = ''
    if (!selected) return
    const request = ++epoch.current
    setProcessing(true); setError(''); setSaved(false)
    try { const image = await prepareCardImage(selected, target === 'strapImage' ? 256 : 1536); if (request === epoch.current) update({ [target]: image }) }
    catch (reason) { if (request === epoch.current) setError(errorMessage(reason)) }
    finally { if (request === epoch.current) setProcessing(false) }
  }
  const save = (): void => {
    if (!validColor) { setError('绳子颜色应为六位十六进制颜色，例如 #617e73。'); return }
    try { savePendantSettings(draft); setDraft(normalizePendantSettings(draft)); setSaved(true); setError('') }
    catch (reason) { setError(errorMessage(reason)) }
  }
  return <div className="dsh-partner-feature-page dsh-partner-pendant-settings">
    <WorkspaceHero eyebrow="PERSONAL TOUCH" title="卡片设置" detail="让挂饰有自己的样子。外观仅保存在当前浏览器，不影响伙伴执行和渠道通知。" actions={<button type="button" disabled={!dirty || processing} onClick={save}><IconCheckOutline14 size={15} />保存设置</button>} />
    {error && <WorkspaceNotice>{error}</WorkspaceNotice>}
    {saved && <WorkspaceNotice kind="success">已保存，挂饰已更新。</WorkspaceNotice>}
    <div className="dsh-partner-pendant-settings-layout">
      <div className="dsh-partner-pendant-settings-fields">
        <WorkspaceBlock title="主界面挂饰" detail="关闭后停止挂饰渲染与消息轮询，随时可以重新开启。" actions={<button type="button" className="dsh-partner-feature-switch" data-on={draft.enabled} role="switch" aria-label="显示卡片挂饰" aria-checked={draft.enabled} onClick={() => update({ enabled: !draft.enabled })}><i /></button>}><p className="dsh-partner-pendant-setting-hint">消息保留在卡片内侧；正面展示图案，新消息到达时轻摆、转正并闪光。</p>
          <div className="dsh-partner-pendant-fps-row"><span>帧率上限</span><div className="dsh-partner-pendant-options" role="group" aria-label="挂饰帧率">{FRAME_RATES.map(item => <button key={item.fps} type="button" aria-pressed={draft.fps === item.fps} onClick={() => update({ fps: item.fps })}><strong>{item.fps} FPS</strong><small>{item.label}</small></button>)}</div><small>仅影响动画绘制，实际帧率取决于设备；静止时自动休眠。</small></div>
        </WorkspaceBlock>
        <WorkspaceBlock title="绳子外观" detail="材质只改变外观，保留当前的拉伸与回弹手感。">
          <label className="dsh-partner-pendant-length"><span>绳子长度 <output>{draft.strapLength}%</output></span><input type="range" min="60" max="160" step="5" aria-label="绳子长度" value={draft.strapLength} onChange={event => update({ strapLength: Number(event.target.value) })} /><small>60% 短绳 — 100% 默认 — 160% 长绳；保存后调整实际悬挂长度。</small></label>
          <div className="dsh-partner-pendant-materials" role="group" aria-label="绳子材质">{MATERIALS.map(item => <button key={item.id} type="button" aria-pressed={draft.material === item.id} onClick={() => update({ material: item.id })}><StrapPreview material={item.id} color={previewColor} swatch /><strong>{item.name}</strong><small>{item.detail}</small>{draft.material === item.id && <IconCheckOutline14 size={14} />}</button>)}</div>
          <div className="dsh-partner-pendant-color-row"><span>绳子颜色</span><div className="dsh-partner-pendant-swatches" role="group" aria-label="预设绳子颜色">{COLORS.map(color => <button key={color} type="button" aria-label={`绳子颜色 ${color}`} aria-pressed={draft.color.toLowerCase() === color} onClick={() => update({ color })}><i style={{ backgroundColor: color }} />{draft.color.toLowerCase() === color && <IconCheckOutline14 size={12} />}</button>)}</div><label className="dsh-partner-pendant-hex"><span className="dsh-partner-pendant-sr">自定义绳子颜色</span><input aria-label="自定义绳子颜色" aria-invalid={!validColor} value={draft.color} maxLength={7} spellCheck={false} onChange={event => update({ color: event.target.value })} /></label></div>
          {!validColor && <p className="dsh-partner-pendant-color-error">请输入 # 开头的六位颜色值。</p>}
          <input ref={strapFile} type="file" accept="image/png,image/jpeg,image/webp" hidden aria-label="上传绳子纹理" onChange={event => { void upload(event, 'strapImage') }} />
          <div className="dsh-partner-pendant-image-actions"><button type="button" disabled={processing} onClick={() => strapFile.current?.click()}><IconPlusOutline16 size={15} />{draft.strapImage ? '更换绳子纹理' : '自定义绳子纹理'}</button><button type="button" disabled={processing || !draft.strapImage} onClick={() => update({ strapImage: '' })}>移除纹理</button></div>
          <p className="dsh-partner-pendant-setting-hint">纹理平铺在绳子表面，建议使用无缝图案；保留所选材质的边缘和编织细节。</p>
        </WorkspaceBlock>
        <WorkspaceBlock title="正面图案" detail="支持 PNG、JPEG、WebP，最大 5 MB。保留图片比例，只在本机处理。">
          <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden aria-label="上传卡片图片" onChange={event => { void upload(event) }} />
          <div className="dsh-partner-pendant-image-actions"><button type="button" disabled={processing} onClick={() => file.current?.click()}><IconPlusOutline16 size={15} />{processing ? '正在处理…' : draft.image ? '更换图片' : '选择图片'}</button><button type="button" disabled={!draft.image || processing} onClick={() => update({ image: '' })}><IconRefreshOutline16 size={15} />恢复默认图案</button></div>
          <div className="dsh-partner-pendant-options" data-columns="2" role="group" aria-label="图片适应方式">{IMAGE_FITS.map(item => <button key={item.fit} type="button" disabled={processing} aria-pressed={draft.imageFit === item.fit} onClick={() => update({ imageFit: item.fit })}><strong>{item.label}</strong><small>{item.detail}</small></button>)}</div>
          <p className="dsh-partner-pendant-setting-hint">完整显示会按比例缩放，空余部分使用卡面底色；铺满会裁切边缘，不拉伸图片。旧版已裁切的图片需重新上传才能恢复完整内容。</p>
          <label className="dsh-partner-pendant-length"><span>卡片清晰度 <output>{draft.quality}%</output></span><input type="range" min="0" max="100" step="5" value={draft.quality} aria-label="卡片清晰度" onChange={event => update({ quality: Number(event.target.value) })} /><small>0% 标准、省资源 — 100% 高清；保存后生效，不改变帧率上限。</small></label>
          <p className="dsh-partner-pendant-setting-hint">图案优先无损保存，最长边保留至 1536 像素。已压缩的旧图片建议重新上传；高清无法恢复原图缺失的细节。</p>
        </WorkspaceBlock>
        <div className="dsh-partner-pendant-settings-footer"><button type="button" disabled={processing} onClick={() => update({ ...DEFAULT_PENDANT_SETTINGS })}>重置为默认</button><small>{dirty ? '有未保存的更改' : '设置已同步到当前浏览器'}</small></div>
      </div>
      <aside className="dsh-partner-pendant-preview" aria-label="卡片外观预览"><header><strong>外观预览</strong><small>{draft.enabled ? '保存后应用到主界面' : '挂饰将隐藏，设置仍会保留'}</small></header><div className="dsh-partner-pendant-preview-stage"><StrapPreview material={draft.material} color={previewColor} image={draft.strapImage} length={draft.strapLength} /><div className="dsh-partner-pendant-preview-card">{draft.image ? <img src={draft.image} style={{ objectFit: draft.imageFit }} alt="自定义卡片正面预览" /> : <span><IconAgentPresetOutline16 size={38} /><strong>WITH YOU</strong><small>默认伙伴图案</small></span>}</div></div><p>正面 · 图案<br /><small>内侧 · 伙伴消息</small></p></aside>
    </div>
  </div>
}
