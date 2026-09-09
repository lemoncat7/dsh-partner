import { useRef, useState, type FormEvent } from 'react'
import { api } from '../client-api.js'
import { WorkspaceDialog, WorkspaceNotice, errorMessage } from './workspace-components.js'

const LIMIT = 32 * 1024 * 1024
const encodeFile = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onerror = () => reject(new Error(`无法读取 ${file.name}`))
  reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
  reader.readAsDataURL(file)
})

export function SkillImportDialog({ close, changed }: { close(): void; changed(): Promise<void> | void }): JSX.Element {
  const zipInput = useRef<HTMLInputElement>(null), directoryInput = useRef<HTMLInputElement | null>(null)
  const [files, setFiles] = useState<File[]>([])
  const [kind, setKind] = useState<'zip' | 'directory'>('zip')
  const [busy, setBusy] = useState(false), [progress, setProgress] = useState('')
  const [error, setError] = useState<string>()
  const choose = (selected: FileList | null, nextKind: 'zip' | 'directory'): void => {
    if (!selected?.length || busy) return
    setError(undefined); setFiles([])
    const next = Array.from(selected).filter(file => !file.webkitRelativePath.split('/').some(part => ['.git', 'node_modules', '__MACOSX', '.DS_Store'].includes(part)))
    if (nextKind === 'zip' && !/\.zip$/iu.test(next[0]?.name ?? '')) { setError('请选择 ZIP 压缩包；其他格式请先解压，再选择目录导入。'); return }
    if (!next.length || next.length > 512 || next.reduce((total, file) => total + file.size, 0) > LIMIT || nextKind === 'directory' && next.some(file => file.size > 8 * 1024 * 1024)) { setError('最多 512 个文件、总计 32 MiB；目录中的单个文件不能超过 8 MiB。'); return }
    setKind(nextKind); setFiles(next)
  }
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (busy || !files.length) return
    setBusy(true); setError(undefined)
    try {
      let body: unknown
      if (kind === 'zip') { setProgress('正在读取压缩包…'); body = { kind, data: await encodeFile(files[0]!) } }
      else {
        const entries = []
        for (const [index, file] of files.entries()) {
          setProgress(`正在读取文件 ${index + 1}/${files.length}`)
          entries.push({ path: file.webkitRelativePath || file.name, data: await encodeFile(file) })
        }
        body = { kind, files: entries }
      }
      setProgress('正在校验并导入…')
      await api('/skills/import', { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(120000) })
      setProgress('导入成功，正在更新列表…')
      await changed(); close()
    } catch (reason) { setError(errorMessage(reason)) }
    finally { setBusy(false); setProgress('') }
  }
  return <WorkspaceDialog title="导入 Skill" detail="导入完整技能包，保留 scripts、references、assets 等配套文件。" close={() => { if (!busy) close() }}>
    <form className="dsh-partner-feature-form dsh-partner-skill-form" aria-busy={busy} onSubmit={event => { void submit(event) }}>
      <input hidden type="file" accept=".zip,application/zip" ref={zipInput} onChange={event => { choose(event.target.files, 'zip'); event.target.value = '' }} />
      <input hidden type="file" multiple ref={node => { directoryInput.current = node; node?.setAttribute('webkitdirectory', '') }} onChange={event => { choose(event.target.files, 'directory'); event.target.value = '' }} />
      <div className="is-wide dsh-partner-capability-actions"><button type="button" autoFocus disabled={busy} onClick={() => zipInput.current?.click()}>选择 ZIP 压缩包</button><button type="button" disabled={busy || !('webkitdirectory' in document.createElement('input'))} onClick={() => directoryInput.current?.click()}>选择目录</button></div>
      <p className="is-wide dsh-partner-form-help">每次导入一个 Skill，目录中应有 SKILL.md。安装不会执行脚本，也不会自动为伙伴启用。仅导入可信来源；其他压缩格式可先解压后导入目录。</p>
      {files.length > 0 && <p className="is-wide dsh-partner-form-help" role="status">已选择：{kind === 'zip' ? files[0]!.name : files[0]!.webkitRelativePath.split('/')[0]} · {files.length} 个文件 · {(files.reduce((total, file) => total + file.size, 0) / 1024 / 1024).toFixed(2)} MiB</p>}
      {progress && <p className="is-wide dsh-partner-form-help" role="status">{progress}</p>}
      {error && <WorkspaceNotice>{error}</WorkspaceNotice>}
      <footer><button type="button" disabled={busy} onClick={close}>取消</button><button type="submit" className="is-primary" disabled={busy || !files.length}>{busy ? '导入中…' : '导入 Skill'}</button></footer>
    </form>
  </WorkspaceDialog>
}
