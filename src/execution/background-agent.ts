import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions, AgentSetup } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

export type BackgroundResult = { stopReason: string; structured?: unknown }
export interface BackgroundActivation {
  childId: string
  name: string
  result: Promise<BackgroundResult>
  dispose(): Promise<void>
}
type TextPart = { type: 'text'; text: string }
export interface BackgroundActivationSpec {
  childId: string
  parent: Agent
  signal: AbortSignal
  label: string
  cwd: string
  prompt: TextPart[]
  outputSchema: Parameters<typeof validateJsonSchemaValue>[0]
  agentOptions?: Pick<AgentOptions, 'provider' | 'model'>
  authorize(): void
}
export interface BackgroundAgentRuntime {
  startActivation(spec: BackgroundActivationSpec): Promise<BackgroundActivation>
  resumeActivation?(spec: BackgroundActivationSpec): Promise<BackgroundActivation>
  sendMessage(parent: Agent, child: string, content: TextPart[], options: { signal: AbortSignal }): Promise<unknown>
}

export function backgroundResult(events: readonly SessionEvent[]): BackgroundResult {
  const recent = [...events].reverse()
  const end = recent.findIndex(event => event.type === 'turn/end' || event.type === 'turn/start')
  const boundary = recent[end]
  if (boundary?.type !== 'turn/end') return { stopReason: 'error' }
  const stopReason = boundary.data.reason.kind
  if (stopReason !== 'completed') return { stopReason }
  const start = recent.findIndex((event, index) => index > end && event.type === 'turn/start')
  const turn = recent.slice(end + 1, start < 0 ? undefined : start)
  const callIndex = turn.findIndex(event => event.type === 'tool/call' && event.data.name === 'structured_output')
  const call = turn[callIndex]
  if (call?.type !== 'tool/call' || !turn.slice(0, callIndex).some(event => event.type === 'tool/result' &&
    event.data.message.toolCallId === call.data.callId && !event.data.message.isError)) return { stopReason }
  const structured = typeof call.data.arguments === 'string' ? JSON.parse(call.data.arguments) : call.data.arguments
  return { stopReason, structured }
}

/** Own a DSH Agent handle and keep its task result on the plugin's delivery path. */
export class PartnerBackgroundAgents implements BackgroundAgentRuntime {
  private readonly active = new Map<string, { parent: Agent; agent: Agent }>()

  constructor(private readonly ctx: Context) {}

  startActivation(spec: BackgroundActivationSpec) { return this.activate(spec, false) }
  resumeActivation(spec: BackgroundActivationSpec) { return this.activate(spec, true) }

  async sendMessage(parent: Agent, child: string, content: TextPart[], { signal }: { signal: AbortSignal }) {
    signal.throwIfAborted()
    const active = this.active.get(child)
    if (active?.parent !== parent) throw Error('后台任务已结束或原会话已变化')
    active.agent.steer(createUserMessage({ content, source: { kind: 'user' } }))
  }

  private async activate(spec: BackgroundActivationSpec, resume: boolean): Promise<BackgroundActivation> {
    const { parent, signal, childId, cwd } = spec
    signal.throwIfAborted()
    spec.authorize()
    const agents = this.ctx.agents
    const id = childId as SessionId
    if (agents.get(parent.id) !== parent) throw Error('后台任务原会话已失效')
    if (agents.get(id)) throw Error('后台任务已有运行中的会话')
    const { appendDelegatedPolicyOverrides, applyChildComposition, captureDelegatedPolicyOverrides, resolveChildAgentOptions, resolveChildDepth } =
      await import('@deepseek-ai/dsh-subagent')
    const depth = resolveChildDepth(parent, Math.min(1, this.ctx.get('subagents')?.resolveMaxDepth?.() ?? 1))
    const policies = captureDelegatedPolicyOverrides(parent)
    const preset = parent.ctx.get('agentPresets')?.composedPreset(parent.ctx)
    const agentOptions = resolveChildAgentOptions(parent, spec.agentOptions, depth)
    const makeSetup = (restoring: boolean): AgentSetup => async (ctx, agent) => {
      if (agent.session.header.parentSession !== parent.id) throw Error('后台任务原会话不匹配')
      if (!restoring) appendDelegatedPolicyOverrides(agent.session, policies)
      await applyChildComposition(ctx, parent, restoring && agent.session.header.agentPreset
        ? { agentPreset: agent.session.header.agentPreset } : {})
      ctx.tools.register({
        name: 'structured_output',
        description: '提交本次后台工作结果和需要交付的附件。处理完所有补充后调用一次。',
        parameters: { ...spec.outputSchema },
        output: {
          schema: { type: 'object', properties: { recorded: { type: 'boolean', const: true } }, required: ['recorded'], additionalProperties: false },
          render: () => [{ type: 'text', text: '后台交付已记录。' }],
        },
        async execute(args, exec) {
          const violations = validateJsonSchemaValue(spec.outputSchema, args)
          if (violations.length) throw Error('后台交付清单格式无效')
          if (agent.inbox.nextStep.length || agent.inbox.nextTurn.length) throw Error('请先处理待接收的任务补充')
          exec.concludeTurn()
          return { recorded: true }
        },
      })
      return { commit: spec.authorize }
    }
    const handle: AgentHandle = resume
      ? await agents.resume({ resumeSessionId: id, agentOptions, setup: makeSetup(true), signal })
      : await agents.create({
        sessionId: id, agentOptions, setup: makeSetup(false), signal,
        meta: { cwd, parentSession: parent.id, origin: 'subagent', delegationDepth: depth, ...(preset ? { agentPreset: preset } : {}) },
      })
    const { agent } = handle
    const entry = { parent, agent }
    let disposal: Promise<void> | undefined
    const dispose = () => {
      if (this.active.get(childId) === entry) this.active.delete(childId)
      return disposal ??= handle.dispose()
    }
    try {
      signal.throwIfAborted()
      spec.authorize()
      const fromSeq = agent.session.snapshotEvents().at(-1)?.seq ?? -1
      this.active.set(childId, entry)
      agent.followup(createUserMessage({ content: spec.prompt, source: { kind: 'user' } }))
      const result = (async () => {
        try {
          do { await agent.whenIdle() } while (agent.status !== 'idle')
          return backgroundResult(agent.session.snapshotEvents().filter(event => event.seq > fromSeq))
        } finally { await dispose() }
      })()
      void result.catch(() => {})
      return { childId, name: spec.label, result, dispose }
    } catch (error) {
      await dispose().catch(() => {})
      throw error
    }
  }
}
