import {basename} from 'node:path'
import {appendPluginRecord, type Session} from '@deepseek-ai/dsh-session'
import type {AttachmentDeliveryService} from '../attachments/service.js'
import {runtimeSnapshot} from '../companions/runtime-policy.js'
import type {ChannelSession} from '../domain.js'
import type {PartnerStore} from '../store.js'
import {BACKGROUND_ARTIFACT_RECORD, backgroundArtifactReceipt, type BackgroundArtifactReceipt} from './background-artifact-receipt.js'
import {backgroundRunRoute, backgroundSourceAllowed} from './background-routing.js'
import type {ExecutionRun} from './domain.js'

export interface BackgroundArtifactDelivery {
  service: AttachmentDeliveryService
  prefix: string
}

export function assertBackgroundArtifactOrigin(store: PartnerStore, run: ExecutionRun, unavailable: (route: ChannelSession) => boolean): void {
  const state = runtimeSnapshot(store)
  const live = state.executionRuns.find(item => item.id === run.id)?.background
  const origin = backgroundRunRoute(state.sessions, run)
  if (!live?.result || live.discardedAt || (live.attempt ?? 0) !== (run.background?.attempt ?? 0) || !origin || unavailable(origin) ||
    !backgroundSourceAllowed(state, run) || store.isCompanionRemoving(run.ownerCompanionId)) throw Error('后台交付原会话已失效，成果已保存')
}

/** Record the finished task in the transcript without admitting a new model message. */
export async function recordBackgroundArtifacts(session: Session, run: ExecutionRun, delivery: BackgroundArtifactDelivery, current: () => void, presentation: {text?: string; anchorSeq?: number} = {}): Promise<void> {
  const source = run.background
  if (!source?.result || source.sourceSessionId !== session.id || !source.result.files.length && !presentation.text) return
  const recorded = () => session.snapshotEvents().some(event => backgroundArtifactReceipt(event)?.taskId === run.id)
  if (recorded()) return
  current()
  const files: BackgroundArtifactReceipt['files'] = []
  for (const file of source.result.files) {
    const name = basename(file.name.replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f]/g, '').trim() || basename(file.path)
    current()
    try {
      const item = await delivery.service.prepareTaskArtifact({
        companionId: run.ownerCompanionId, sessionId: session.id, taskId: run.id,
        cwd: source.cwd, path: file.path, name,
      }, new AbortController().signal)
      files.push({name, url: `${delivery.prefix}/attachments/${item.id}`})
    } catch {
      files.push({name})
    }
  }
  current()
  if (!recorded()) appendPluginRecord(session, BACKGROUND_ARTIFACT_RECORD, {taskId: run.id, files, ...presentation})
}
