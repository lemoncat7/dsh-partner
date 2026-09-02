import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model'
import type { AgentPresets } from '@deepseek-ai/dsh-agent-presets'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import { appendBounded } from '../core/collections.js'
import { AsyncSemaphore } from '../core/semaphore.js'
import type { Companion } from '../domain.js'
import type { PartnerStore } from '../store.js'
import type { ExecutionKind, ExecutionRun, ExecutionStatus } from './domain.js'
import { assistantTextAfter, renderPartnerPersona, renderToolProtocol, resolvePartnerAgentOptions } from './agent-support.js'

type ExecutionContext = Context & {
  agents: Context['agents']
  agentDefaultModel: AgentDefaultModelConfig
  agentPresets: AgentPresets
  tools: ToolRuntime
  workspaceRegistry: WorkspaceRegistry
}

export interface EphemeralExecutionRequest {
  kind: ExecutionKind
  sourceId: string
  companion: Companion
  prompt: string
  cwd?: string
  parentSessionId?: string
  allowedTools?: string[]
  systemInstruction?: string
  timeoutMinutes?: number
  destroyAfterRun?: boolean
}

export interface EphemeralExecutionResult { run: ExecutionRun; output: string }

export class EphemeralExecutionService {
  private readonly semaphore = new AsyncSemaphore(3)
  private readonly retained = new Map<string, AgentHandle>()
  private readonly active = new Map<string, AgentHandle>()
  private closed = false

  constructor(private readonly ctx: ExecutionContext, private readonly store: PartnerStore, private readonly defaultCwd: string) {}

  execute(request: EphemeralExecutionRequest): Promise<EphemeralExecutionResult> {
    if (this.closed) return Promise.reject(new Error('Ephemeral execution service is closed'))
    return this.semaphore.use(() => this.run(request))
  }

  async close(): Promise<void> {
    this.closed = true
    for (const handle of this.active.values()) handle.agent.cancel({ kind: 'disposed' })
    await Promise.all([...new Set([...this.active.values(), ...this.retained.values()])].map(handle => handle.dispose().catch(() => {})))
    this.active.clear()
    this.retained.clear()
  }

  private async run(request: EphemeralExecutionRequest): Promise<EphemeralExecutionResult> {
    if (this.closed) throw new Error('Ephemeral execution service is closed')
    const sessionId = `partner-run-${randomUUID()}`
    const runId = `run-${randomUUID()}`
    const destroyAfterRun = request.destroyAfterRun ?? true
    const run: ExecutionRun = {
      id: runId, kind: request.kind, ownerCompanionId: request.companion.id, sessionId, sourceId: request.sourceId,
      status: 'running', destroyAfterRun, startedAt: Date.now(), toolNames: request.allowedTools ?? [],
    }
    await this.saveRun(run)
    const cwd = request.cwd ?? join(this.defaultCwd, 'partners', request.companion.id, 'runs', runId)
    await mkdir(cwd, { recursive: true, mode: 0o700 })
    let handle: AgentHandle | undefined
    let status: ExecutionStatus = 'failed'
    let output = ''
    let error: string | undefined
    const timeoutMs = Math.min(120, Math.max(1, request.timeoutMinutes ?? 10)) * 60_000
    let timedOut = false
    try {
      handle = await this.ctx.agents.create({
        sessionId: sessionId as SessionId,
        meta: {
          cwd,
          ...(request.parentSessionId ? { parentSession: request.parentSessionId as SessionId, origin: 'subagent' as const, delegationDepth: 1 } : {}),
          ...(request.companion.presetId ? { agentPreset: request.companion.presetId } : {}),
        },
        agentOptions: resolvePartnerAgentOptions(this.ctx.agentDefaultModel, request.companion),
        setup: async agentCtx => {
          const presets = agentCtx.get('agentPresets') as AgentPresets | undefined
          if (!presets) throw new Error('Temporary partner session is missing Agent Presets')
          await presets.mount(agentCtx, request.companion.presetId)
          agentCtx.systemPrompt.section({ name: 'partner-identity', order: -10, text: renderPartnerPersona(request.companion, 'ephemeral') })
          agentCtx.systemPrompt.section({ name: 'partner-tool-routing', order: -9, text: renderToolProtocol() })
          if (request.systemInstruction) agentCtx.systemPrompt.section({ name: 'partner-ephemeral-task', order: -8, text: request.systemInstruction })
          agentCtx.tools.presentAs('native')
          if (request.allowedTools !== undefined) restrictTools(agentCtx as ExecutionContext, request.allowedTools)
        },
      })
      this.active.set(sessionId, handle)
      if (this.closed) throw new Error('Ephemeral execution service closed while creating a session')
      if (!destroyAfterRun) {
        const workspace = await this.ctx.workspaceRegistry.create(cwd, `伙伴任务 · ${request.companion.name}`)
        await workspace.attachSession(sessionId as SessionId)
      }
      const startSeq = handle.agent.session.seq
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: request.prompt }],
        source: { kind: 'plugin', plugin: '@lemoncat7/dsh-partner', form: 'notice', summary: executionSummary(request.kind) },
      }))
      const timer = setTimeout(() => { timedOut = true; handle?.agent.cancel({ kind: 'hook', reason: 'partner temporary execution timed out' }) }, timeoutMs)
      timer.unref?.()
      try { await handle.agent.whenIdle() } finally { clearTimeout(timer) }
      output = assistantTextAfter(handle.agent, startSeq)
      if (timedOut) { status = 'timed-out'; error = 'Temporary execution exceeded its time limit' }
      else if (!output) { status = 'failed'; error = 'Temporary execution produced no text result' }
      else status = 'completed'
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason)
      status = timedOut ? 'timed-out' : 'failed'
    } finally {
      Object.assign(run, {
        status, completedAt: Date.now(),
        ...(output ? { outputSummary: output.slice(0, 2000) } : {}),
        ...(error ? { error } : {}),
      })
      await this.saveRun(run)
      if (handle) {
        this.active.delete(sessionId)
        if (destroyAfterRun || status !== 'completed') await handle.dispose().catch(() => {})
        else this.retained.set(sessionId, handle)
      }
    }
    if (status !== 'completed') throw new ExecutionFailedError(run)
    return { run, output }
  }

  private async saveRun(run: ExecutionRun): Promise<void> {
    await this.store.update(state => {
      state.executionRuns = state.executionRuns.filter(item => item.id !== run.id)
      appendBounded(state.executionRuns, structuredClone(run), 500)
    })
  }
}

export class ExecutionFailedError extends Error {
  constructor(readonly run: ExecutionRun) { super(run.error ?? 'Temporary execution failed') }
}

function restrictTools(ctx: ExecutionContext, requested: string[]): void {
  const agent = ctx.agent
  if (!agent) throw new Error('Temporary agent scope is unavailable')
  const visible = ctx.tools.schemas(agent).map(tool => tool.name).filter(name => name !== 'run_code')
  const requestedSet = new Set(requested)
  const allowed = visible.filter(name => requestedSet.has(name))
  if (allowed.length > 0) ctx.tools.restrict({ allow: allowed })
  else if (visible.length > 0) ctx.tools.restrict({ deny: visible })
}

function executionSummary(kind: ExecutionKind): string {
  return ({ skill: '伙伴执行 Skill', delegation: '伙伴执行委派任务', review: '伙伴核验看板任务', schedule: '伙伴执行定时任务' })[kind]
}
