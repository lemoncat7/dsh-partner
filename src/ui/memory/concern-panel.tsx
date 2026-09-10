import {useEffect, useRef, useState} from 'react'
import {IconRefreshOutline16} from '@deepseek-ai/dsh-client-ui-primitives'
import {api, type CompanionView, type PartnerSnapshot, type ConcernActivityView, type ConcernView} from '../../client-api.js'
import {WorkspaceHero, WorkspaceNotice, CollectionEmpty, errorMessage} from '../workspace-components.js'
import {relativeTime} from '../partner-components.js'
import {useMemoryResource} from './use-memory-resource.js'
import {AutomationSettings} from './automation-settings.js'
import {ConcernBoard} from './concern-board.js'

export function ConcernPanel({companion, snapshot, onChanged}: {companion: CompanionView; snapshot: PartnerSnapshot; onChanged(): Promise<void>}): JSX.Element {
  const base = `/companions/${encodeURIComponent(companion.id)}`
  const resource = useMemoryResource<ConcernActivityView>(`${base}/concerns`, 15_000)
  const [settings, setSettings] = useState(false)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const awaitingCheck = useRef(false)
  const refresh = useRef({onChanged, reload: resource.reload})
  refresh.current = {onChanged, reload: resource.reload}
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    awaitingCheck.current = false
    setChecking(false)
    const poll = async () => {
      try {
        if (document.hidden) return
        const status = await api<{running: boolean; result: {sent: boolean; reason?: string} | null}>(`${base}/heartbeat/status`, {signal: controller.signal})
        if (disposed) return
        setChecking(status.running)
        if (awaitingCheck.current && !status.running) {
          awaitingCheck.current = false
          setNotice(status.result?.reason ?? (status.result?.sent ? '检查完成，已发送提醒' : '检查已结束，请查看关注活动'))
          await Promise.all([refresh.current.onChanged(), refresh.current.reload()])
        }
        if (status.running) awaitingCheck.current = true
      } catch { /* A transient status failure must not restart a background task. */ }
      finally { if (!disposed) timer = setTimeout(() => {void poll()}, 3000) }
    }
    void poll()
    return () => {disposed = true; controller.abort(); clearTimeout(timer)}
  }, [base])
  const lock = useRef(false)
  const [notice, setNotice] = useState<string>()
  const [error, setError] = useState<string>()
  const heartbeat = snapshot.heartbeatStates.find(item => item.companionId === companion.id)
  const run = async (action: () => Promise<string>): Promise<boolean> => {
    if (lock.current) return false
    lock.current = true; setBusy(true); setError(undefined); setNotice(undefined)
    try {setNotice(await action()); await resource.reload(); return true}
    catch (reason) {setError(errorMessage(reason)); return false}
    finally {lock.current = false; setBusy(false)}
  }
  const check = (concernId?: string): void => {void run(async () => {
    if (checking) return '心跳正在执行，请等待本轮结果'
    const result = await api<{running: boolean; reason?: string}>(`${base}/heartbeat/trigger`, {method: 'POST', body: JSON.stringify(concernId ? {concernId} : {})})
    setChecking(result.running)
    awaitingCheck.current = result.running
    await onChanged()
    return result.reason ?? '已开始后台检查，可离开此页面，结果会保留在关注活动中'
  })}
  const act = (item: ConcernView, action: 'watch' | 'ignore' | 'prioritize' | 'resolve'): void => {void run(async () => {
    await api(`${base}/concerns/${encodeURIComponent(item.id)}/action`, {method: 'POST', body: JSON.stringify({action})})
    return ({watch: '已恢复留意', ignore: '不再关注这件事', prioritize: '已提高关注', resolve: '已标记解决'})[action]
  })}
  return <div className="dsh-partner-memory-page is-concerns">
    <WorkspaceHero eyebrow="ONGOING WATCHES" title="持续关注" detail="只留意需要继续观察的事，有值得告诉你的变化时再出现。" actions={<><button type="button" disabled={busy || checking} aria-busy={checking} onClick={() => check()}>{checking ? '后台检查中…' : '检查到期项'}</button><button type="button" onClick={() => setSettings(true)}>关注设置</button></>} />
    <div className="dsh-partner-memory-status"><span>{companion.automation.heartbeat.enabled ? '持续感知已开启' : '持续感知已暂停'}</span><small>最近检查：{heartbeat?.lastCheckedAt ? relativeTime(heartbeat.lastCheckedAt) : '尚未'} · 今日提醒 {heartbeat?.sentCount ?? 0} 次</small><button type="button" disabled={resource.loading} aria-label="刷新关注" onClick={() => {void resource.reload()}}><IconRefreshOutline16 size={16} /></button></div>
    {(error || resource.error || heartbeat?.lastError) && <WorkspaceNotice>{error || resource.error || heartbeat?.lastError}</WorkspaceNotice>}
    {notice && <WorkspaceNotice kind="success">{notice}</WorkspaceNotice>}
    {!resource.data ? <CollectionEmpty title={resource.error ? '关注读取失败' : '正在读取关注'} action={resource.error ? <button type="button" onClick={() => {void resource.reload()}}>重试</button> : undefined} /> : <ConcernBoard companionId={companion.id} activity={resource.data} onEdited={resource.reload} value={value} busy={busy || checking} onValue={setValue} onCheck={item => check(item.id)} onAct={act} onAdd={(recordTarget, reason) => run(async () => {
      if (!value.trim()) return '请填写需要持续关注的事情'
      await api(`${base}/concerns`, {method: 'POST', body: JSON.stringify({subject: value.trim(), reason, recordTarget})})
      setValue(''); return '已加入持续关注'
    })} />}
    {settings && <AutomationSettings companion={companion} kind="heartbeat" close={() => setSettings(false)} onChanged={onChanged} />}
  </div>
}
