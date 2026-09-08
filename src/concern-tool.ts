import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition, ToolRunContext, ToolRuntime } from '@deepseek-ai/dsh-tools'
import { extractConcernResources, type ConcernCandidate, type ConcernWatchKind } from './concern-domain.js'
import type { PartnerConcernStore } from './concern-store.js'
import { explicitConcernDirective } from './memory-reflection.js'
import type { PartnerStore } from './store.js'

const TOOL_NAME = 'partner_concern_suggest'

type ConcernToolContext = Context & { agents: Context['agents']; tools: ToolRuntime }

export interface ConcernSuggestion {
  subject: string
  reason: string
  evidence: string
  watchKind: ConcernWatchKind
  watchQuery: string
  priority: number
  confidence: number
}

/** One concern entry point for explicit watches and evidence-backed implicit candidates. */
export function registerPartnerConcernTool(ctx: ConcernToolContext, store: PartnerStore, concerns: PartnerConcernStore): () => void {
  const disposeTool = ctx.tools.register(concernSuggestionTool(store, concerns, new ConcernTurnSubmissionGate()))
  const disposeVisibility = installVisibility(ctx, store)
  return () => { disposeVisibility(); disposeTool() }
}

function concernSuggestionTool(store: PartnerStore, concerns: PartnerConcernStore, submissions: ConcernTurnSubmissionGate): ToolDefinition {
  return {
    name: TOOL_NAME,
    description: 'Save a concrete ongoing concern to 伙伴记忆 / 在意的事. Use this tool directly for explicit requests such as 帮我关注、关注一些、持续留意、有变化告诉我; do not create partner_schedule merely because watching requires future checks. Save each requested subject separately and report the actual saved/merged/rejected outcome. Without an explicit watch request, suggest at most one implicit concern only with direct evidence of an unresolved or recurring problem, temporary workaround, pending external result, or future changes. Never infer concerns from one-shot research, summary, writing, ordinary execution, broad interests or completed work. Evidence must quote the current user message. Fixed-time execution or scheduled reports belong to partner_schedule; cancel/stop watching is not an upsert.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        subject: { type: 'string', description: 'Specific unresolved matter, at most 120 characters.' },
        reason: { type: 'string', description: 'Why it remains open and merits later observation, at most 400 characters.' },
        evidence: { type: 'string', description: 'Exact supporting excerpt from the current user message, at most 500 characters.' },
        watchKind: { type: 'string', enum: ['auto', 'knowledge', 'workspace', 'web'] },
        watchQuery: { type: 'string', description: 'Concrete future change to check, at most 300 characters.' },
        priority: { type: 'number', minimum: 0, maximum: 1 },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['subject', 'reason', 'evidence', 'watchKind', 'watchQuery', 'priority', 'confidence'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    presentCall: () => ({ card: 'generic', title: '保存伙伴关注事项' }),
    async execute(raw, exec) {
      const agent = requireAgent(exec)
      const route = store.snapshot().sessions.find(item => item.sessionId === agent.session.id)
      if (route === undefined) throw new Error('partner_concern_suggest is only available in a partner-owned conversation')
      const companion = store.snapshot().companions.find(item => item.id === route.companionId)
      if (companion === undefined || !companion.automation.memory.enabled) throw new Error('伙伴记忆未启用，不能保存关注；请开启记忆，不要改用定时任务代替')
      const currentUser = latestUserMessage(agent)
      const currentUserText = currentUser.text
      const suggestion = validateConcernSuggestion(raw, currentUserText)
      const explicit = explicitConcernDirective(currentUserText) && explicitConcernDirective(suggestion.evidence)
      if (!explicit && !submissions.claim(agent, currentUser.seq)) return JSON.stringify({
        outcome: 'already_processed_this_turn',
        reason: '本轮已经提交过关注候选，请继续处理用户当前任务；仍可调用其他所需工具。',
      })
      const candidate: ConcernCandidate = {
        subject: suggestion.subject, reason: suggestion.reason, operation: 'upsert', priority: suggestion.priority,
        confidence: suggestion.confidence, watchKind: suggestion.watchKind, watchQuery: suggestion.watchQuery,
        resources: extractConcernResources(`${suggestion.subject} ${suggestion.reason} ${suggestion.evidence}`),
      }
      let result: Awaited<ReturnType<PartnerConcernStore['ingestCandidates']>>
      try {
        result = await concerns.ingestCandidates(route.companionId, `${route.channelId}:${route.userId}`, [candidate], explicit ? 'explicit' : 'implicit', Date.now(), {
          source: 'tool', sessionId: agent.session.id, evidence: suggestion.evidence, maxImplicitCreates: 1,
        })
      } catch (error) {
        if (!explicit) submissions.release(agent, currentUser.seq)
        throw error
      }
      const entry = result.entries[0]
      return JSON.stringify({
        outcome: entry?.decision ?? 'rejected',
        origin: explicit ? 'explicit' : 'implicit',
        destination: '在意的事',
        concernId: entry?.concern?.id,
        subject: entry?.subject ?? suggestion.subject,
        reason: entry?.reason ?? '候选未被处理',
      })
    },
  }
}

export function validateConcernSuggestion(value: unknown, currentUserText: string): ConcernSuggestion {
  const input = object(value)
  const suggestion: ConcernSuggestion = {
    subject: text(input.subject, 'subject', 120),
    reason: text(input.reason, 'reason', 400),
    evidence: text(input.evidence, 'evidence', 500),
    watchKind: watchKind(input.watchKind),
    watchQuery: text(input.watchQuery, 'watchQuery', 300),
    priority: score(input.priority, 'priority'),
    confidence: score(input.confidence, 'confidence'),
  }
  if (!normalized(currentUserText).includes(normalized(suggestion.evidence))) {
    throw new Error('evidence must be an exact excerpt from the current user message')
  }
  return suggestion
}

export function applyConcernToolVisibility(assembly: PromptAssembly, enabled: boolean): void {
  if (!enabled) assembly.tools = assembly.tools.filter(schema => schema.name !== TOOL_NAME)
}

function installVisibility(ctx: ConcernToolContext, store: PartnerStore): () => void {
  const attached = new Map<Agent, () => void>()
  const attach = (agent: Agent): void => {
    if (attached.has(agent)) return
    const dispose = agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const result = await next()
      const route = store.snapshot().sessions.find(item => item.sessionId === agent.session.id)
      const companion = route === undefined ? undefined : store.snapshot().companions.find(item => item.id === route.companionId)
      applyConcernToolVisibility(result, route !== undefined && companion?.automation.memory.enabled === true)
      return result
    })
    attached.set(agent, dispose)
  }
  for (const agent of ctx.agents.list()) attach(agent)
  const disposeCreated = ctx.on('agent/created', ({ agent }) => attach(agent))
  const disposeDisposed = ctx.on('agent/disposed', ({ agent }) => {
    attached.get(agent)?.()
    attached.delete(agent)
  })
  return () => {
    disposeDisposed()
    disposeCreated()
    for (const dispose of attached.values()) dispose()
    attached.clear()
  }
}

function requireAgent(exec: ToolRunContext): Agent {
  if (exec.agent === undefined) throw new Error('partner_concern_suggest requires an active agent conversation')
  return exec.agent
}

function latestUserMessage(agent: Agent): { seq: number; text: string } {
  const events = agent.session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'user/message' || event.data.source.kind !== 'user') continue
    return { seq: event.seq, text: event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim() }
  }
  throw new Error('current partner turn has no user message evidence')
}

export class ConcernTurnSubmissionGate {
  private readonly processed = new WeakMap<Agent, number>()

  claim(agent: Agent, userMessageSeq: number): boolean {
    if (this.processed.get(agent) === userMessageSeq) return false
    this.processed.set(agent, userMessageSeq)
    return true
  }

  release(agent: Agent, userMessageSeq: number): void {
    if (this.processed.get(agent) === userMessageSeq) this.processed.delete(agent)
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('arguments must be an object')
  return value as Record<string, unknown>
}
function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) throw new Error(`${name} must be a non-empty string with at most ${max} characters`)
  return value.replace(/\s+/gu, ' ').trim()
}
function score(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be a number between 0 and 1`)
  return value
}
function watchKind(value: unknown): ConcernWatchKind {
  if (value !== 'auto' && value !== 'knowledge' && value !== 'workspace' && value !== 'web') throw new Error('watchKind is invalid')
  return value
}
function normalized(value: string): string { return value.normalize('NFKC').replace(/\s+/gu, ' ').trim() }
