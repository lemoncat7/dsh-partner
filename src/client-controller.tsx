import type { ClientContext, ISessions, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { api } from './client-api.js'
import { activatePluginWorkspace } from './workspace-ownership.js'

export interface PartnerController {
  open(companionId?: string): void
  close(): void
  toggle(): void
  isOpen(): boolean
  selected(): string | undefined
  openSession(routeId: string, sessionId: string): Promise<void>
  startSession(companionId: string): Promise<void>
  renewSession(routeId: string): Promise<void>
  subscribe(listener: () => void): () => void
}

export function createPartnerController(ctx: ClientContext, pluginId: string, render: (props: PropsRuntime<'conversation'>, controller: PartnerController) => JSX.Element): PartnerController {
  const listeners = new Set<() => void>()
  let selected: string | undefined
  let dispose: (() => void) | undefined
  const notify = (): void => { for (const listener of listeners) listener() }
  const controller: PartnerController = {
    open(companionId) {
      if (companionId !== undefined) selected = companionId
      if (dispose === undefined) {
        activatePluginWorkspace(pluginId)
        dispose = ctx.slots.register({ name: 'conversation', priority: -3 }, props => render(props, controller))
      }
      notify()
    },
    close() { const current = dispose; dispose = undefined; current?.(); notify() },
    toggle() { if (dispose === undefined) controller.open(); else controller.close() },
    isOpen: () => dispose !== undefined,
    selected: () => selected,
    async openSession(routeId, sessionId) {
      const prepared = await api<{ sessionId: string }>(`/sessions/${encodeURIComponent(routeId)}/prepare`, { method: 'POST' })
      if (prepared.sessionId !== sessionId) throw new Error('伙伴会话标识不一致')
      await waitForClientSession(ctx, sessionId)
      controller.close()
      sessions(ctx).open(sessionId as SessionId)
    },
    async startSession(companionId) {
      const created = await api<{ routeId: string; sessionId: string }>(`/companions/${encodeURIComponent(companionId)}/session`, { method: 'POST' })
      await waitForClientSession(ctx, created.sessionId)
      dispose?.(); dispose = undefined
      sessions(ctx).open(created.sessionId as SessionId)
    },
    async renewSession(routeId) {
      const renewed = await api<{ routeId: string; sessionId: string }>(`/sessions/${encodeURIComponent(routeId)}/renew`, { method: 'POST' })
      await waitForClientSession(ctx, renewed.sessionId)
      controller.close()
      sessions(ctx).open(renewed.sessionId as SessionId)
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
  }
  return controller
}

function waitForClientSession(ctx: ClientContext, sessionId: string): Promise<void> {
  const id = sessionId as SessionId
  const clientSessions = sessions(ctx)
  if (clientSessions.list.getSnapshot().byId[id] !== undefined) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let stop = (): void => {}
    const timeout = window.setTimeout(() => { stop(); reject(new Error('伙伴会话尚未同步到网页，请稍后重试')) }, 5_000)
    stop = clientSessions.list.subscribe(() => {
      if (clientSessions.list.getSnapshot().byId[id] === undefined) return
      window.clearTimeout(timeout); stop(); resolve()
    })
  })
}

function sessions(ctx: ClientContext): ISessions { return ctx.sessions as unknown as ISessions }
