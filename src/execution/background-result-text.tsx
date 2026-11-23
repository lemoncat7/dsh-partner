import type {Context} from '@deepseek-ai/cordis'
import type {ConversationNodeDefinition} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {backgroundArtifactReceipt, type BackgroundArtifactReceipt} from './background-artifact-receipt.js'

const KIND = 'partner-background-artifacts'

export const backgroundResultTextDefinition: ConversationNodeDefinition<BackgroundArtifactReceipt> = {
  kind: KIND, target: 'chat',
  match: event => {
    const receipt = backgroundArtifactReceipt(event)
    return receipt?.text ? {id: receipt.taskId, role: 'start'} : null
  },
  start: (_context, match) => backgroundArtifactReceipt(match.event)!,
  update: (context,match) => backgroundArtifactReceipt(match.event)??context.state,
  buildViewNode: context => {
    if (!context.start || !context.state) return null
    const {event, location} = context.start
    const anchorSeq = Math.min(event.seq, context.state.anchorSeq ?? event.seq)
    return {key: context.key, id: context.id, kind: KIND, target: 'chat', anchorSeq, location, visibility: 'visible', data: context.state}
  },
}

export function registerBackgroundResultText(ctx: Context): void {
  type Registry = {register(definition: ConversationNodeDefinition<BackgroundArtifactReceipt>): () => void}
  const runtime = ctx as unknown as {
    inject(names: string[], callback: (scope: Context) => void): unknown
    slots: {inject(name: string, callback: () => unknown): unknown; register(options: {name: string; key: string}, render: (props: {node: {data: BackgroundArtifactReceipt}}) => JSX.Element): () => void}
  }
  const registered = new WeakSet<object>()
  const register = (scope: Context, registry: Registry) => {
    if (registered.has(registry)) return
    registered.add(registry)
    scope.effect(() => {
      const dispose = registry.register(backgroundResultTextDefinition)
      return () => { registered.delete(registry); dispose() }
    }, 'partner: background result text')
  }
  runtime.inject(['uiConversation'], scope => register(scope, (scope.get('uiConversation') as {events: Registry}).events))
  runtime.inject(['conversationEvents'], scope => register(scope, scope.get('conversationEvents') as Registry))
  runtime.slots.inject('conversation.chat.node', () => runtime.slots.register({name: 'conversation.chat.node', key: KIND}, ({node}) => <div className="dsh-partner-background-result-text">{node.data.text}</div>))
}
