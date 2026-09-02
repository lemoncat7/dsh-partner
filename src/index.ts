import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { AgentPresets } from '@deepseek-ai/dsh-agent-presets'
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { Config as ConfigSchema, resolveConfig, type Config as PartnerConfig } from './config.js'
import { PartnerStore } from './store.js'
import { PartnerCredentialVault } from './credentials.js'
import { PartnerAgentRuntime } from './agent-runtime.js'
import { ChannelManager } from './channels/manager.js'
import { WeixinLoginManager } from './channels/weixin/login.js'
import { registerPartnerApi, type WebServerLike } from './api.js'
import { HeartbeatScheduler } from './heartbeat.js'
import { PartnerMemoryStore } from './memory-store.js'
import { MemoryReflectionService } from './memory-reflection.js'
import { DailyReviewScheduler } from './daily-review.js'
import { PartnerConcernStore, type LegacyConcernSeed } from './concern-store.js'
import { registerPartnerConcernTool } from './concern-tool.js'
import { SkillRepository } from './skills/repository.js'
import { SkillService } from './skills/service.js'
import { TaskBoardService } from './tasks/service.js'
import { EphemeralExecutionService } from './execution/service.js'
import { PartnerCollaborationService } from './collaboration/service.js'
import { PartnerSchedulerService } from './scheduler/service.js'
import { PartnerAgentComposition } from './collaboration/composition.js'

export const Config = ConfigSchema
export type Config = PartnerConfig
export * from './domain.js'
export const name = 'dsh-partner'
export const inject = ['credentials', 'attachments', 'agents', 'agentDefaultModel', 'agentPresets', 'apiProxy', 'settings', 'systemPrompt', 'tools', 'workspaceRegistry', 'llm']

type RuntimeContext = Context & {
  credentials: CredentialProvider
  agentDefaultModel: AgentDefaultModelConfig
  workspaceRegistry: WorkspaceRegistry
  agentPresets: AgentPresets
  tools: ToolRuntime
  webServer?: WebServerLike
  inject?(services: string[], callback: (ctx: RuntimeContext) => void): unknown
}

export function apply(context: Context, config: PartnerConfig): void {
  const ctx = context as RuntimeContext
  const resolved = resolveConfig(config)
  ctx.effect(async () => {
    const store = await PartnerStore.open(resolved.statePath)
    const credentials = new PartnerCredentialVault(ctx.credentials)
    const memory = new PartnerMemoryStore(resolved.defaultCwd, resolved.timeZone)
    const concerns = new PartnerConcernStore(resolved.defaultCwd)
    for (const companion of store.snapshot().companions) {
      const migrated = await memory.migrateLegacy(companion.id)
      if (migrated > 0) ctx.logger.info(`dsh-partner: migrated ${migrated} legacy memory records for ${companion.id}`)
      const legacyRows = await memory.legacyHeartbeatFocuses(companion.id)
      const seeds: LegacyConcernSeed[] = [
        ...legacyTopics(companion.automation.heartbeat.legacyFocus).map(subject => ({
          scopeId: '*', subject, reason: '用户在旧版心跳中明确要求留意', confidence: 1, origin: 'explicit' as const,
        })),
        ...legacyRows.map(item => ({ ...item, origin: 'implicit' as const })),
      ]
      await concerns.migrateLegacy(companion.id, seeds)
      await memory.dropLegacyHeartbeatFocuses(companion.id)
    }
    if (store.snapshot().companions.some(item => item.automation.heartbeat.legacyFocus)) await store.update(state => {
      for (const companion of state.companions) delete companion.automation.heartbeat.legacyFocus
    })
    const reflection = new MemoryReflectionService(ctx, memory, concerns)
    const skills = new SkillService(store, new SkillRepository(join(resolved.defaultCwd, 'partner-system', 'skills')))
    await skills.initialize()
    const tasks = new TaskBoardService(store)
    const executor = new EphemeralExecutionService(ctx, store, resolved.defaultCwd)
    const collaboration = new PartnerCollaborationService(store, skills, tasks, executor)
    const scheduler = new PartnerSchedulerService(store, executor, resolved.timeZone)
    const composer = new PartnerAgentComposition(store, skills, tasks, collaboration, scheduler, executor)
    const agents = new PartnerAgentRuntime(ctx, store, resolved.defaultCwd, memory, reflection, concerns, composer)
    collaboration.setSessionExecutor({ execute: input => agents.executeTask(input) })
    tasks.setProgressNotifier((task, previousStatus) => agents.notifyTaskProgress(task, previousStatus).catch(error => {
      ctx.logger.warn(`dsh-partner task progress notification failed: ${error instanceof Error ? error.message : String(error)}`)
    }))
    const disposeConcernTool = registerPartnerConcernTool(ctx, store, concerns)
    const channels = new ChannelManager(ctx, store, credentials, agents)
    const disposeSessionObserver = ctx.on('session/event', (session, event) => {
      void agents.observeSessionEvent(session, event).catch(error => ctx.logger.warn(`dsh-partner memory reflection failed: ${error instanceof Error ? error.message : String(error)}`))
      void channels.observeAutonomousResult(session, event).catch(error => ctx.logger.warn(`dsh-partner autonomous delivery failed: ${error instanceof Error ? error.message : String(error)}`))
    })
    channels.startInteractionBridge()
    const heartbeat = new HeartbeatScheduler(ctx, store, agents, channels, concerns, resolved.timeZone)
    const dailyReview = new DailyReviewScheduler(ctx, store, memory, reflection, agents, resolved.timeZone)
    const login = new WeixinLoginManager()
    let disposeApi: (() => void) | undefined
    const mountApi = (runtime: RuntimeContext): void => {
      if (!resolved.exposeWeb) return
      const webServer = runtime.webServer ?? runtime.get('webServer') as WebServerLike | undefined
      if (webServer === undefined) throw new Error('dsh-partner exposeWeb requires webServer')
      disposeApi = registerPartnerApi(webServer, resolved.apiPrefix, { ctx, store, credentials, channels, agents, login, memory, concerns, heartbeat, dailyReview, skills, tasks, collaboration, scheduler })
    }
    if (ctx.inject !== undefined) ctx.inject(['webServer'], mountApi)
    else if (ctx.webServer !== undefined) mountApi(ctx)
    else ctx.logger.warn('dsh-partner: webServer is unavailable; companion management is disabled')
    if (resolved.autoStartChannels) await channels.startEnabled()
    heartbeat.start()
    dailyReview.start()
    scheduler.start()
    ctx.logger.info(`dsh-partner: ready with ${store.snapshot().companions.length} companion(s)`)
    return async () => {
      disposeApi?.()
      disposeSessionObserver()
      disposeConcernTool()
      await scheduler.close()
      await heartbeat.close()
      await dailyReview.close()
      await channels.close()
      await agents.close()
      await executor.close()
    }
  }, 'dsh-partner.runtime')
}

function legacyTopics(value: string | undefined): string[] {
  if (!value) return []
  const seen = new Set<string>()
  return value.split(/[\r\n;；]+/).map(item => item.replace(/\s+/g, ' ').trim()).filter(item => {
    const key = item.toLocaleLowerCase().replace(/\s+/g, '')
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}
