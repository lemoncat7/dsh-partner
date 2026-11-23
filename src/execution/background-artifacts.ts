import {realpath, stat} from 'node:fs/promises'
import {basename, dirname, isAbsolute, relative, resolve, sep} from 'node:path'
import {ToolCallId} from '@deepseek-ai/dsh-llm'
import {appendPluginRecord, type Session, type SessionEvent} from '@deepseek-ai/dsh-session'
import type {PresentedFile} from '@deepseek-ai/dsh-tool-present/types'
import {runtimeSnapshot} from '../companions/runtime-policy.js'
import type {ChannelSession} from '../domain.js'
import type {PartnerStore} from '../store.js'
import {BACKGROUND_ARTIFACT_RECORD, backgroundArtifactReceipt} from './background-artifact-receipt.js'
import {backgroundRunRoute, backgroundSourceAllowed} from './background-routing.js'
import type {ExecutionRun} from './domain.js'

export function assertBackgroundArtifactOrigin(store: PartnerStore, run: ExecutionRun, unavailable: (route: ChannelSession) => boolean): void {
  const state = runtimeSnapshot(store)
  const live = state.executionRuns.find(item => item.id === run.id)?.background
  const origin = backgroundRunRoute(state.sessions, run)
  if (!live?.result || live.discardedAt || (live.attempt ?? 0) !== (run.background?.attempt ?? 0) || !origin || unavailable(origin) ||
    !backgroundSourceAllowed(state, run) || store.isCompanionRemoving(run.ownerCompanionId)) throw Error('后台交付原会话已失效，成果已保存')
}

const inside = (path: string): boolean => !!path && path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path)
export const backgroundPresentationCallId = (taskId: string) => ToolCallId(`partner-background:${taskId}`)

function messageTurn(events: readonly SessionEvent[], messageId: string, completed: boolean): number | undefined {
  let turn: number | undefined
  let matched = false
  for (const event of events) {
    if (event.type === 'turn/start') {
      turn = event.data.turn
      matched = false
    } else if (event.type === 'user/message' && event.data.id === messageId) {
      if (!completed) return turn
      matched = true
    } else if (event.type === 'user/message' && event.data.source.kind === 'user') {
      matched = false
    } else if (event.type === 'turn/end') {
      if (matched && turn === event.data.turn && event.data.reason.kind === 'completed') return turn
      matched = false
      turn = undefined
    }
  }
}

/** Publish the host's native present event against the existing origin turn. */
export async function recordBackgroundArtifacts(session: Session, run: ExecutionRun, current: () => void, presentation: {text?: string | undefined; foregroundMessageId?: string | undefined} = {}): Promise<void> {
  const source = run.background
  if (!source?.result || source.sourceSessionId !== session.id || (!source.result.files.length && !presentation.text)) return

  const events = session.snapshotEvents()
  const callId = backgroundPresentationCallId(run.id)
  const presented = (event: SessionEvent) => event.type === 'deliverables/presented' && event.data.callId === callId
  let prior: ReturnType<typeof backgroundArtifactReceipt>
  for (let index = events.length - 1; index >= 0; index--) {
    const receipt = backgroundArtifactReceipt(events[index]!)
    if (receipt?.taskId !== run.id) continue
    prior = receipt
    break
  }
  const foregroundId = presentation.foregroundMessageId ?? source.foregroundMessageId
  const legacyAnchor = prior?.anchorSeq === undefined ? undefined : events.find(event => event.seq === prior.anchorSeq && event.type === 'turn/end')
  const turn = (foregroundId ? messageTurn(events, foregroundId, true) : undefined)
    ?? messageTurn(events, source.inputId, false)
    ?? (legacyAnchor?.type === 'turn/end' ? legacyAnchor.data.turn : undefined)

  const files = new Map<string, PresentedFile>()
  if (turn !== undefined && source.result.files.length && !events.some(presented)) {
    current()
    const parent = session.header.cwd ?? source.sourceCwd ?? (basename(source.cwd) === run.id && basename(dirname(source.cwd)) === '.partner-background' ? dirname(dirname(source.cwd)) : undefined)
    const workspace = parent && await realpath(parent).catch(() => undefined)
    const taskDirectory = await realpath(source.cwd).catch(() => undefined)
    if (workspace && taskDirectory && taskDirectory === resolve(source.cwd)) {
      for (const file of source.result.files) {
        const path = await realpath(file.path).catch(() => undefined)
        if (!path || path !== resolve(file.path) || !inside(relative(taskDirectory, path)) || !inside(relative(workspace, path))) continue
        const within = relative(workspace, path)
        if (/[\\\x00-\x1f\x7f]/u.test(within) || !(await stat(path).catch(() => undefined))?.isFile()) continue
        const name = basename(file.name.replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f]/g, '').trim()
        files.set(path, name && name !== basename(path) ? {path, description: name} : {path})
      }
    }
  }

  const text = presentation.text?.trim()
  if (!files.size && (!text || prior?.text)) return
  current()
  const latest = session.snapshotEvents()
  if (files.size && turn !== undefined && !latest.some(presented)) {
    session.append('deliverables/presented', {turn, callId, files: [...files.values()]})
  }
  if (text && !latest.some(event => {
    const receipt = backgroundArtifactReceipt(event)
    return receipt?.taskId === run.id && !!receipt.text
  })) appendPluginRecord(session, BACKGROUND_ARTIFACT_RECORD, {taskId: run.id, files: [], text})
}
