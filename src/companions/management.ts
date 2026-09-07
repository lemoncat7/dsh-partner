import { createHash } from 'node:crypto'
import { COMPANION_CAPABILITIES, CAPABILITY_LABELS, isCompanionCapability } from '../capabilities.js'
import { normalizeCompanionDraft, type Companion, type PartnerState } from '../domain.js'
import { record, requiredText, stringList } from '../core/validation.js'
import type { PartnerStore } from '../store.js'

export interface ManagementCatalog {
  presets: Array<{ id: string; name: string; broken?: string }>
  providers: Array<{ id: string; models: Array<{ id: string; name?: string }> }>
}
export interface ManagementRuntime {
  catalog(): Promise<ManagementCatalog>
  isBusy(companionId: string): boolean
  reload(companionId: string): Promise<void>
}

const PATCH_FIELDS = new Set(['name', 'role', 'description', 'instructions', 'presetId', 'provider', 'model', 'capabilities', 'skillIds', 'accessTargetIds'])

/** Privileged configuration boundary. No conversations, credentials or memory are exposed. */
export class CompanionManagementService {
  constructor(private readonly store: PartnerStore, private readonly runtime: ManagementRuntime) {}

  authorize(actorId: string, state = this.store.snapshot()): Companion {
    const actor = state.companions.find(item => item.id === actorId)
    if (!actor?.capabilities.includes('administration')) throw new Error('当前伙伴未获“伙伴管理（高权限）”授权，或权限已被撤回')
    return actor
  }

  target(actorId: string, reference: string, state = this.store.snapshot()): Companion {
    this.authorize(actorId, state)
    const key = requiredText(reference, 'target', 160).replace(/^@/, '').toLocaleLowerCase()
    const exact = state.companions.find(item => item.id.toLocaleLowerCase() === key)
    const matches = exact ? [exact] : state.companions.filter(item => item.name.toLocaleLowerCase() === key)
    if (matches.length !== 1) throw new Error(matches.length ? '伙伴名称不唯一，请使用稳定 id' : '目标伙伴不存在')
    const target = matches[0]!
    if (target.id === actorId) throw new Error('伙伴管理只能修改其他伙伴，不能查看或修改自己的管理配置')
    return target
  }

  async catalog(actorId: string) {
    this.authorize(actorId)
    const catalog = await this.runtime.catalog()
    const state = this.store.snapshot()
    this.authorize(actorId, state)
    return {
      ...catalog,
      capabilities: COMPANION_CAPABILITIES.map(id => ({ id, name: CAPABILITY_LABELS[id], userOnly: id === 'administration' })),
      companions: state.companions.map(item => ({ id: item.id, name: item.name, role: item.role, manageable: item.id !== actorId })),
      skills: state.skills.map(item => ({ id: item.id, name: item.displayName, description: item.description, trusted: item.trusted, context: item.executionContext })),
    }
  }

  inspect(actorId: string, reference: string) {
    const state = this.store.snapshot()
    return managementView(this.target(actorId, reference, state), state)
  }

  async update(actorId: string, reference: string, expectedRevision: string, raw: unknown, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const patch = record(raw, 'patch')
    if (!Object.keys(patch).length) throw new Error('至少指定一项需要修改的配置')
    for (const key of Object.keys(patch)) if (!PATCH_FIELDS.has(key)) throw new Error(`不支持修改 ${key}；记忆、渠道、凭据和本管理权限由用户配置`)
    const before = this.inspect(actorId, reference)
    if (!expectedRevision || before.revision !== expectedRevision) throw new Error('配置已变化，请重新 inspect 后使用最新 revision')
    if (patch.capabilities !== undefined) {
      const capabilities = stringList(patch.capabilities, 'capabilities', 20, 32)
      if (capabilities.some(item => !isCompanionCapability(item))) throw new Error('能力无效，请先读取 catalog')
      if (capabilities.includes('administration') !== before.capabilities.includes('administration')) throw new Error('伙伴管理权限只能由用户在界面授予或撤回')
    }
    const skills = patch.skillIds === undefined ? undefined : stringList(patch.skillIds, 'skillIds', 500)
    const targets = patch.accessTargetIds === undefined ? undefined : stringList(patch.accessTargetIds, 'accessTargetIds', 200, 160)
    const { skillIds: _skills, accessTargetIds: _targets, ...identity } = patch
    const draft = normalizeCompanionDraft({ ...before, ...identity })
    if (['presetId', 'provider', 'model'].some(key => key in patch)) {
      const catalog = await this.runtime.catalog()
      if (draft.presetId && !catalog.presets.some(item => item.id === draft.presetId && !item.broken)) throw new Error('Agent Preset 不存在或不可用，请先读取 catalog')
      if (draft.provider || draft.model) {
        if (!draft.provider || !draft.model || !catalog.providers.some(item => item.id === draft.provider && item.models.some(model => model.id === draft.model))) {
          throw new Error('请配置有效的 provider 和 model，或同时留空跟随 DSH 默认模型')
        }
      }
    }
    const committed = await this.store.update(state => {
      signal?.throwIfAborted()
      // Recheck inside the serialized write: revocation, competing edits and
      // removed Skills must not leave a half-applied identity/access update.
      const target = this.target(actorId, before.id, state)
      if (managementView(target, state).revision !== expectedRevision) throw new Error('配置已变化，请重新 inspect 后重试')
      this.assertIdle(target.id, state)
      if (skills?.some(id => !state.skills.some(skill => skill.id === id))) throw new Error('Skill 未安装或已被删除，请先读取 catalog')
      if (skills?.length && !draft.capabilities.includes('skills')) throw new Error('绑定 Skill 前请同时启用 skills 能力')
      if (targets?.some(id => id === target.id || !state.companions.some(item => item.id === id))) throw new Error('协作对象不存在，或包含目标伙伴自己')
      Object.assign(target, draft, { updatedAt: Math.max(Date.now(), target.updatedAt + 1) })
      for (const key of ['presetId', 'provider', 'model'] as const) if (draft[key] === undefined) delete target[key]
      if (skills !== undefined) {
        const previous = new Map(state.skillBindings.filter(item => item.companionId === target.id).map(item => [item.skillId, item]))
        state.skillBindings = state.skillBindings.filter(item => item.companionId !== target.id)
        state.skillBindings.push(...skills.map(skillId => ({ ...previous.get(skillId), companionId: target.id, skillId, enabled: true })))
      }
      if (targets !== undefined) {
        const previous = new Map(state.companionAccessGrants.filter(item => item.fromCompanionId === target.id).map(item => [item.toCompanionId, item]))
        state.companionAccessGrants = state.companionAccessGrants.filter(item => item.fromCompanionId !== target.id)
        state.companionAccessGrants.push(...targets.map(toCompanionId => previous.get(toCompanionId) ?? ({ fromCompanionId: target.id, toCompanionId, createdAt: Date.now() })))
      }
    })
    const result = managementView(committed.companions.find(item => item.id === before.id)!, committed)
    try {
      await this.runtime.reload(before.id)
      return { applied: true, companion: result, changedFields: Object.keys(patch), runtime: 'reloaded' as const }
    } catch {
      // The disk transaction has committed. Never claim it failed or roll back
      // over newer UI edits if refreshing a session happens to fail.
      return { applied: true, companion: result, changedFields: Object.keys(patch), runtime: 'reopen-required' as const, warning: '配置已保存，会话刷新失败；请重新打开目标伙伴会话后再使用新配置，不要重复提交修改' }
    }
  }

  assertIdle(companionId: string, state = this.store.snapshot()): void {
    if (this.runtime.isBusy(companionId) || state.executionRuns.some(item => item.ownerCompanionId === companionId && item.status === 'running')
      || state.delegations.some(item => item.toCompanionId === companionId && item.status === 'running')) {
      throw new Error('目标伙伴正在执行任务，请结束后再修改配置；本次未写入')
    }
  }
}

function managementView(companion: Companion, state: PartnerState) {
  const { id, name, role, description, instructions, presetId, provider, model, capabilities, updatedAt } = companion
  const value = {
    id, name, role, description, instructions, presetId, provider, model, capabilities, updatedAt,
    skillIds: state.skillBindings.filter(item => item.companionId === id && item.enabled).map(item => item.skillId).sort(),
    accessTargetIds: state.companionAccessGrants.filter(item => item.fromCompanionId === id).map(item => item.toCompanionId).sort(),
  }
  return { ...value, revision: createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24) }
}
