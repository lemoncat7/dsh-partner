import { modelSelectionProjectionDefinition, type ModelSelection } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { Companion } from '../domain.js'
import { isMissingSession } from './session-recovery.js'

interface SessionModelQuery {
  observeSession(id: SessionId, options: { signal: AbortSignal }): Promise<{
    projections?: { values: { modelSelection?: { next?: ModelSelection | null } } }
    events: readonly SessionEvent[]
    [Symbol.dispose](): void
  }>
}

function recordedSelection(events: readonly SessionEvent[]): ModelSelection | undefined {
  const projection = modelSelectionProjectionDefinition
  return projection.wire.view(events.reduce(projection.apply, projection.init())).next ?? undefined
}

/** Read the live or durable model choice without waking a session or supplying a prompt. */
export async function partnerSessionModel(
  ctx: Context, companion: Pick<Companion, 'provider' | 'model'>, sessionId: string | undefined, signal: AbortSignal,
): Promise<ModelSelection> {
  signal.throwIfAborted()
  if (sessionId) {
    const id = sessionId as SessionId
    const live = ctx.agents?.get?.(id)
    const current = live?.model.current() ?? recordedSelection(ctx.get('sessions')?.get(id)?.snapshotEvents() ?? [])
    if (current) return current

    const query = ctx.get('sessionQuery' as never) as SessionModelQuery | undefined
    try {
      if (typeof query?.observeSession === 'function') {
        const result = await query.observeSession(id, { signal })
        try {
          const selected = result.projections?.values.modelSelection?.next ?? recordedSelection(result.events)
          if (selected) return selected
        } finally { result[Symbol.dispose]() }
      } else if (ctx.get('sessionPersistence')) {
        const handle = await ctx.get('sessionPersistence')!.open(id, 'read', { signal })
        try {
          const selected = recordedSelection((await handle.read(0, undefined, { signal })).events)
          if (selected) return selected
        } finally { await handle.close() }
      }
    } catch (error) {
      signal.throwIfAborted()
      const code = (error as { code?: string } | undefined)?.code
      if (!isMissingSession(error, id) && code !== 'SESSION_QUERY_SESSION_NOT_FOUND') throw error
    }
  }
  const defaults = ctx.get('agentDefaultModel')
  if (!defaults) throw Error('默认模型服务不可用')
  const current = defaults.currentSelection()
  const provider = companion.provider || current.provider, model = companion.model || current.model
  return provider === current.provider && model === current.model ? current : { provider, model }
}
