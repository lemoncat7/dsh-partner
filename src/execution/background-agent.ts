import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentActivation, SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { validateJsonSchemaValue, type ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { randomUUID } from 'node:crypto'

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
  outputSchema: ObjectJsonSchema
  agentOptions?: Pick<AgentOptions, 'provider' | 'model'>
  seed?: readonly SessionEvent[]
  authorize(): void
}
export interface BackgroundAgentRuntime {
  startActivation(spec: BackgroundActivationSpec): Promise<BackgroundActivation>
  resumeActivation?(spec: BackgroundActivationSpec): Promise<BackgroundActivation>
  prepareResume?(childId: string, parent: Agent, signal: AbortSignal): Promise<{ childId: string; seed?: readonly SessionEvent[] }>
  sendMessage(parent: Agent, child: string, content: TextPart[], options: { signal: AbortSignal }): Promise<unknown>
  close?(): void
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

type Resuming = {
  spec: BackgroundActivationSpec
  runId?: string
  settled: boolean
  captured?: { value: unknown }
  acceptsInput?: () => boolean
  result: { promise: Promise<BackgroundResult>; resolve(value: BackgroundResult): void }
}

/** Native subagents own execution and discovery; Partner owns its task manifest and delivery. */
export class PartnerBackgroundAgents implements BackgroundAgentRuntime {
  private native: SubagentRuntime | undefined
  private readonly disposers: Array<() => void> = []
  private readonly seeds = new Map<string, readonly SessionEvent[]>()
  private readonly admitting = new Map<string, BackgroundActivationSpec>()
  private readonly active = new Map<string, { parent: Agent; activation: BackgroundActivation }>()
  private readonly resuming = new Map<string, Resuming>()
  private readonly deliveryOwners = new WeakMap<Agent, Set<string>>()

  constructor(private readonly ctx: Context) {
    if (ctx.get('subagents')) this.runtime()
  }

  private runtime(): SubagentRuntime {
    if (this.native) return this.native
    const native = this.ctx.get('subagents')
    if (!native) throw Error('伙伴后台任务需要加载原生 subagents 服务')
    this.disposers.push(native.registerProvider({
      name: 'partner-background',
      capabilities: { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: true },
      inheritsParentContext: false,
      prepareContinuable: async ({ sessionId, signal }) => {
        signal.throwIfAborted()
        const seed = this.seeds.get(sessionId)
        return seed ? { seed } : {}
      },
    }))
    // Native cold continuation intentionally returns an inbox receipt, not an
    // activation handle or output schema. Public lifecycle events bridge that
    // result back to the existing Partner delivery path.
    this.disposers.push(this.ctx.on('subagent/start', info => {
      const pending = this.resuming.get(info.id)
      if (pending && info.provider === 'partner-background') pending.runId = info.runId
    }))
    this.disposers.push(this.ctx.on('subagent/end', info => {
      const pending = this.resuming.get(info.id)
      if (!pending || pending.runId !== info.runId) return
      pending.settled = true
      pending.result.resolve({ stopReason: info.stopReason, ...(info.stopReason === 'completed' && pending.captured ? { structured: pending.captured.value } : {}) })
    }))
    this.disposers.push(this.ctx.on('agent/created', async ({ agent }) => {
      const pending = this.resuming.get(agent.id)
      const spec = pending?.spec ?? this.admitting.get(agent.id)
      if (!spec) {
        const { foldSubagentDescriptor } = await import('@deepseek-ai/dsh-subagent')
        if (foldSubagentDescriptor(agent.session.snapshotEvents().filter(event => agent.session.isOwnSeq(event.seq)))?.provider === 'partner-background') throw Error('请通过伙伴后台任务入口恢复，保留原任务授权和交付目标')
        return
      }
      if (agent.session.header.parentSession !== spec.parent.id) throw Error('后台任务原会话不匹配')
      spec.authorize()
      if (pending) this.attachResumeManifest(agent, pending)
    }))
    this.disposers.push(this.ctx.on('agent/pre-step', async ({ agent }, next) => {
      const decision = await next()
      const owned = this.deliveryOwners.get(agent)
      if (decision.kind !== 'enter' || !owned) return decision
      // Cold resume uses native parent notification. Its outcome is already
      // handled by Partner, so consume only those notices, keeping real inputs
      // and other plugins' child notifications intact, even in a mixed batch.
      const messages = decision.messages.filter(message => message.source.kind !== 'subagent-settled' || !owned.has(message.source.senderSessionId))
      return messages.length === decision.messages.length ? decision : messages.length ? { ...decision, messages } : { kind: 'reject' }
    }))
    this.native = native
    return native
  }

  private authorize(spec: BackgroundActivationSpec): void {
    spec.signal.throwIfAborted()
    spec.authorize()
    if (this.ctx.agents.get(spec.parent.id) !== spec.parent) throw Error('后台任务原会话已失效')
    if (this.active.has(spec.childId) || this.admitting.has(spec.childId) || this.resuming.has(spec.childId) || this.ctx.agents.get(spec.childId as SessionId)) throw Error('后台任务已有运行中的会话')
  }

  /** Preserve legacy raw-agent history through native seeded creation, without rewriting old logs. */
  async prepareResume(childId: string, parent: Agent, signal: AbortSignal) {
    signal.throwIfAborted()
    const query = this.ctx.get('sessionQuery')
    if (!query) throw Error('恢复后台任务需要原生会话查询服务')
    const source = await query.observeSession(childId as SessionId, { signal })
    try {
      signal.throwIfAborted()
      if (source.header.parentSession !== parent.id) throw Error('后台任务原会话不匹配')
      const { foldSubagentDescriptor } = await import('@deepseek-ai/dsh-subagent')
      const descriptor = foldSubagentDescriptor(source.events.slice(source.inheritedEventCount))
      if (descriptor?.mode === 'continuable' && descriptor.provider === 'partner-background') return { childId }
      if (descriptor && (descriptor.mode !== 'one-shot' || descriptor.provider !== 'partner-background')) throw Error('后台子会话不属于伙伴任务')
      // The native factory validates the complete seed, including unfinished
      // or corrupt logs. Never fall back to executing the original prompt anew.
      return { childId: 'session-' + randomUUID(), seed: structuredClone(source.events) }
    } finally { source[Symbol.dispose]() }
  }

  async startActivation(spec: BackgroundActivationSpec): Promise<BackgroundActivation> {
    this.authorize(spec)
    const native = this.runtime()
    this.admitting.set(spec.childId, spec)
    if (spec.seed) this.seeds.set(spec.childId, spec.seed)
    let activation: SubagentActivation | undefined
    try {
      const request = { parent: spec.parent, cwd: spec.cwd, prompt: spec.prompt, outputSchema: spec.outputSchema,
        maxDepth: Math.min(1, native.resolveMaxDepth() ?? 1), ...(spec.agentOptions ? { agentOptions: spec.agentOptions } : {}) }
      // rc.5 flattened task options onto the activation spec. Carry the same
      // immutable task on both public shapes while supporting rc.1 hosts.
      const nativeSpec = {
        provider: 'partner-background', childId: spec.childId as SessionId, label: spec.label,
        signal: spec.signal, delivery: 'caller' as const, ...request, request,
      }
      activation = await native.startActivation(nativeSpec)
      spec.signal.throwIfAborted()
      spec.authorize()
      return this.track(spec, { childId: activation.childId, name: spec.label, result: activation.result, dispose: () => activation!.dispose() })
    } catch (error) {
      await activation?.dispose().catch(() => {})
      throw error
    } finally { this.seeds.delete(spec.childId); this.admitting.delete(spec.childId) }
  }

  async resumeActivation(spec: BackgroundActivationSpec): Promise<BackgroundActivation> {
    this.authorize(spec)
    const native = this.runtime()
    let resolve!: (value: BackgroundResult) => void
    const promise = new Promise<BackgroundResult>(done => { resolve = done })
    const pending: Resuming = { spec, settled: false, result: { promise, resolve } }
    this.resuming.set(spec.childId, pending)
    const owned = this.deliveryOwners.get(spec.parent) ?? new Set<string>()
    owned.add(spec.childId)
    this.deliveryOwners.set(spec.parent, owned)
    let disposal: Promise<void> | undefined
    const dispose = () => pending.settled || !pending.runId ? Promise.resolve() : disposal ??= (async () => {
      native.interrupt(spec.childId as SessionId, { kind: 'ancestor', agent: spec.parent })
      // A Partner pause cancels unstarted supplements too. Native interrupt
      // preserves its inbox; clearing that public inbox lets native settlement
      // release this activation before the task can be resumed again.
      this.ctx.agents.get(spec.childId as SessionId)?.inbox.clear()
      await pending.result.promise
    })()
    try {
      await native.sendMessage(spec.parent, spec.childId as SessionId, spec.prompt, { signal: spec.signal })
      spec.signal.throwIfAborted()
      spec.authorize()
      const activation = this.track(spec, { childId: spec.childId, name: spec.label, result: pending.result.promise, dispose })
      void activation.result.finally(() => { if (this.resuming.get(spec.childId) === pending) this.resuming.delete(spec.childId) }).catch(() => {})
      return activation
    } catch (error) {
      await dispose().catch(() => {})
      if (this.resuming.get(spec.childId) === pending) this.resuming.delete(spec.childId)
      throw error
    }
  }

  private track(spec: BackgroundActivationSpec, activation: BackgroundActivation): BackgroundActivation {
    const entry = { parent: spec.parent, activation }
    this.active.set(spec.childId, entry)
    void activation.result.finally(() => { if (this.active.get(spec.childId) === entry) this.active.delete(spec.childId) }).catch(() => {})
    return activation
  }

  async sendMessage(parent: Agent, child: string, content: TextPart[], { signal }: { signal: AbortSignal }) {
    signal.throwIfAborted()
    if (this.active.get(child)?.parent !== parent) throw Error('后台任务已结束或原会话已变化')
    if (this.resuming.get(child)?.acceptsInput?.() === false) throw Error('后台任务正在提交或已提交交付清单，补充未被接收')
    return this.runtime().sendMessage(parent, child as SessionId, content, { signal })
  }

  private attachResumeManifest(agent: Agent, pending: Resuming): void {
    const { outputSchema } = pending.spec
    const staged = new Map<object, unknown>()
    let transport: { token: unknown; value: unknown } | undefined
    pending.acceptsInput = () => staged.size === 0 && !transport && !pending.captured
    agent.ctx.tools.register({
      name: 'structured_output', description: '提交本次后台工作结果和需要交付的附件。处理完所有补充后调用一次。',
      parameters: { ...outputSchema },
      output: { schema: { type: 'object', properties: { recorded: { type: 'boolean', const: true } }, required: ['recorded'], additionalProperties: false }, render: () => [{ type: 'text', text: '后台交付已记录。' }] },
      async execute(args, exec) {
        if (validateJsonSchemaValue(outputSchema, args).length) throw Error('后台交付清单格式无效')
        if (agent.inbox.nextStep.length || agent.inbox.nextTurn.length) throw Error('请先处理待接收的任务补充')
        staged.set(exec, args)
        exec.concludeTurn()
        return { recorded: true }
      },
    })
    agent.ctx.tools.guard(exec => pending.captured || transport ? '后台交付已记录，不再执行后续工具：' + exec.name : undefined)
    agent.ctx.on('tools/result', (exec, result) => {
      if (exec.name === 'structured_output') {
        if (!staged.has(exec)) return
        const value = staged.get(exec)
        staged.delete(exec)
        if (result.isError) return
        if (exec.parent === undefined) pending.captured = { value }
        else transport = { token: exec.parent, value }
      } else if (transport?.token === exec.token) {
        if (!result.isError) pending.captured = { value: transport.value }
        transport = undefined
      }
    })
  }

  close(): void {
    for (const dispose of this.disposers.splice(0).reverse()) dispose()
    this.native = undefined
    this.seeds.clear()
  }
}
