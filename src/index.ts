import type { Context } from '@deepseek-ai/cordis'
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
    const agents = new PartnerAgentRuntime(ctx, store, resolved.defaultCwd, memory, reflection, concerns)
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
      disposeApi = registerPartnerApi(webServer, resolved.apiPrefix, { ctx, store, credentials, channels, agents, login, memory, concerns, heartbeat, dailyReview })
    }
    if (ctx.inject !== undefined) ctx.inject(['webServer'], mountApi)
    else if (ctx.webServer !== undefined) mountApi(ctx)
    else ctx.logger.warn('dsh-partner: webServer is unavailable; companion management is disabled')
    if (resolved.autoStartChannels) await channels.startEnabled()
    heartbeat.start()
    dailyReview.start()
    ctx.logger.info(`dsh-partner: ready with ${store.snapshot().companions.length} companion(s)`)
    return async () => {
      disposeApi?.()
      disposeSessionObserver()
      disposeConcernTool()
      await heartbeat.close()
      await dailyReview.close()
      await channels.close()
      await agents.close()
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
