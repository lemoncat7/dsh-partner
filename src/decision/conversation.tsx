import type { Context } from '@deepseek-ai/cordis'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { decisionReason, type DecisionEvent } from './events.js'

/** Log-only events: no fabricated tool call and no additional LLM messages. */
export const decisionDefinition: ConversationNodeDefinition<DecisionEvent> = {
  kind: 'partner-decision', target: 'chat',
  match: event => event.type === 'partner/decision' ? { id: (event.data as DecisionEvent).id, role: 'start' } : null,
  start: (_context, match) => match.event.data as DecisionEvent,
  update: (_context, match) => match.event.data as DecisionEvent,
  buildViewNode: context => {
    if (!context.state || !context.start) return null
    const location = context.start.location
    const closed = (location.kind === 'turn' || location.kind === 'step') && location.turn.status === 'closed'
    const data = closed && context.state.status === 'running'
      ? { ...context.state, status: 'settled' as const, reason: 'interrupted' } : context.state
    return { key: context.key, id: context.id, kind: 'partner-decision', target: 'chat',
      anchorSeq: context.start.event.seq, location, visibility: 'visible', data }
  },
}

export function DecisionCard({ data }: { data: DecisionEvent }) {
  return <section className="dsh-partner-decision-card" aria-label="自动决策">
    <div role="status" aria-atomic="true"><strong>自动决策</strong><span>{decisionReason(data.reason)}</span><small>{data.status === 'running' ? '等待响应…' : `${(data.durationMs / 1000).toFixed(2)} 秒`}</small></div>
    {data.suggestions.length > 0 && <ul>{data.suggestions.map(item => {
      const colon = item.indexOf('：')
      let label = item
      try { const value = JSON.parse(item.slice(colon + 1)); if (typeof value.name === 'string') label = `${item.slice(0, colon)}：${value.name}` } catch { /* Earlier records remain readable. */ }
      return <li key={item}>{label}</li>
    })}</ul>}
    <small>Skill · 伙伴 · 工具，仅提供建议，不代表已执行。</small>
  </section>
}

/** Published rc.2 owns uiConversation.events; newer hosts expose conversationEvents. */
export function registerDecisionCards(ctx: Context): void {
  const runtime = ctx as unknown as {
    inject(names: string[], callback: (scope: Context) => void): unknown
    slots: { inject(name: string, callback: () => unknown): unknown; register(options: { name: string; key: string }, render: (props: { node: { data: DecisionEvent } }) => JSX.Element): () => void }
  }
  const registered = new WeakSet<object>()
  const register = (scope: Context, modern: boolean) => {
    type Registry = { register(definition: ConversationNodeDefinition<DecisionEvent>): () => void }
    const registry = modern ? scope.get('conversationEvents') as Registry
      : (scope.get('uiConversation') as { events: Registry }).events
    if (registered.has(registry)) return
    registered.add(registry)
    scope.effect(() => {
      const dispose = registry.register(decisionDefinition)
      return () => { registered.delete(registry); dispose() }
    }, 'partner: decision conversation events')
  }
  runtime.inject(['uiConversation'], scope => register(scope, false))
  runtime.inject(['conversationEvents'], scope => register(scope, true))
  runtime.slots.inject('conversation.chat.node', () => runtime.slots.register(
    { name: 'conversation.chat.node', key: 'partner-decision' }, props => <DecisionCard data={props.node.data} />))
}
