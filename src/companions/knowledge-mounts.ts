import { record, requiredText, stringList, oneOf, optionalBoolean } from '../core/validation.js'
import type { PartnerStore } from '../store.js'
import type { CompanionManagementService } from './management.js'

interface MountTarget { kind: 'project' | 'session'; id: string }
interface MountSettings {
  knowledgeBaseId: string; enabled: boolean; recallEnabled: boolean; writeMode: 'none' | 'audit' | 'direct'
  includeTags: string[]; excludeTags: string[]; extractionInstructions: string
}
interface KnowledgeMountBridge {
  version: 1
  catalog(signal?: AbortSignal): Promise<unknown>
  read(targets: MountTarget[], signal?: AbortSignal): Promise<unknown>
  configure(targets: MountTarget[], revision: string, settings: MountSettings, signal?: AbortSignal, beforeWrite?: () => void): Promise<unknown>
}

/** Optional integration: no package import, HTTP bypass or credential access. */
export class CompanionKnowledgeMounts {
  constructor(
    private readonly store: PartnerStore,
    private readonly management: CompanionManagementService,
    private readonly bridge: () => unknown,
    private readonly defaultProject: (companionId: string) => string,
  ) {}

  async catalog(actorId: string, signal?: AbortSignal) {
    this.management.authorize(actorId)
    const result = await this.service().catalog(signal)
    this.management.authorize(actorId)
    return result
  }

  async inspect(actorId: string, target: string, signal?: AbortSignal) {
    const scopes = this.targets(actorId, target)
    const result = await this.service().read(scopes, signal)
    this.management.authorize(actorId)
    return result
  }

  async configure(actorId: string, target: string, revision: string, raw: unknown, signal?: AbortSignal) {
    const input = record(raw, 'mount')
    const allowed = new Set(['knowledgeBaseId', 'enabled', 'recallEnabled', 'writeMode', 'includeTags', 'excludeTags', 'extractionInstructions'])
    for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`挂载不支持 ${key}；目标范围由伙伴系统确定`)
    const settings: MountSettings = {
      knowledgeBaseId: requiredText(input.knowledgeBaseId, 'knowledgeBaseId', 160),
      enabled: optionalBoolean(input.enabled, true), recallEnabled: optionalBoolean(input.recallEnabled, true),
      writeMode: oneOf(input.writeMode ?? 'audit', ['none', 'audit', 'direct'], 'writeMode'),
      includeTags: stringList(input.includeTags, 'includeTags', 32, 100), excludeTags: stringList(input.excludeTags, 'excludeTags', 32, 100),
      extractionInstructions: input.extractionInstructions === undefined ? '' : multiline(input.extractionInstructions),
    }
    if (settings.includeTags.some(tag => settings.excludeTags.includes(tag))) throw new Error('同一标签不能同时包含和排除')
    const companion = this.management.target(actorId, target)
    this.management.assertIdle(companion.id)
    const scopes = this.targets(actorId, companion.id)
    return this.service().configure(scopes, requiredText(revision, 'revision', 100), settings, signal, () => {
      signal?.throwIfAborted()
      // Remote reads may take time: recheck authority, activity and ownership
      // immediately before the knowledge provider starts its write.
      const current = this.targets(actorId, companion.id)
      this.management.assertIdle(companion.id)
      if (JSON.stringify(current) !== JSON.stringify(scopes)) throw new Error('伙伴会话范围已变化，请重新读取挂载后重试')
    })
  }

  private targets(actorId: string, target: string): MountTarget[] {
    const state = this.store.snapshot()
    const companion = this.management.target(actorId, target, state)
    const project = this.defaultProject(companion.id)
    if (state.sessions.some(item => item.companionId !== companion.id && item.cwd === project)) throw new Error('伙伴目录被其他伙伴共用，不能批量修改挂载')
    const sessions = [...new Set(state.sessions.filter(item => item.companionId === companion.id).map(item => item.sessionId))]
    if (sessions.length > 99) throw new Error('伙伴会话超过批量挂载上限，请在知识库管理台分批配置')
    return [{ kind: 'project', id: project }, ...sessions.map(id => ({ kind: 'session' as const, id }))]
  }

  private service(): KnowledgeMountBridge {
    const value = this.bridge() as Partial<KnowledgeMountBridge> | undefined
    if (value?.version !== 1 || typeof value.catalog !== 'function' || typeof value.read !== 'function' || typeof value.configure !== 'function') throw new Error('知识库挂载服务不可用，请启用支持伙伴挂载管理接口的新版知识库插件')
    return value as KnowledgeMountBridge
  }
}

function multiline(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4000) throw new Error('extractionInstructions 必须为最多 4000 字符的文本')
  return value.trim()
}
