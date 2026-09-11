import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { api } from './client-api.js'
import { registerMainPanel } from './main-panel-compat.js'
import { activatePluginWorkspace } from './workspace-ownership.js'

export interface PartnerDestination { page: 'home' | 'board' | 'schedules'; taskId?: string }
export interface PartnerController {
  open(companionId?: string, destination?: PartnerDestination): void
  destination(): PartnerDestination | undefined
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
  let destination: PartnerDestination | undefined
  let dispose: (() => void) | undefined
  const notify = (): void => { for (const listener of listeners) listener() }
  const controller: PartnerController = {
    open(companionId, target) {
      destination = target ?? { page: 'home' }
      if (companionId !== undefined) selected = companionId
      if (dispose === undefined) {
        activatePluginWorkspace(pluginId)
        dispose = registerMainPanel(ctx, pluginId, -3, props => render(props, controller), () => controller.close())
      }
      notify()
    },
    close() { const current = dispose; dispose = undefined; current?.(); notify() },
    toggle() { if (dispose === undefined) controller.open(); else controller.close() },
    isOpen: () => dispose !== undefined,
    selected: () => selected,
    destination: () => destination,
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
      controller.close()
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
