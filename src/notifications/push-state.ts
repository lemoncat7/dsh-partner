import type { PartnerState } from '../domain.js'
export function validatePushState(state: Partial<PartnerState>): void {
  if (state.pushChannels !== undefined && !Array.isArray(state.pushChannels)) throw Error('invalid push channels')
  const ids = new Set<string>()
  for (const c of state.pushChannels ?? []) {
    if (!c || typeof c.id !== 'string' || ids.has(c.id) || c.platform !== 'bark' || !state.companions?.some(owner => owner.id === c.companionId)
      || typeof c.name !== 'string' || typeof c.baseUrl !== 'string' || typeof c.enabled !== 'boolean' || !Number.isSafeInteger(c.revision)
      || !Array.isArray(c.targets) || c.targets.length > 50 || !c.targets.length
      || c.targets.some(t => !t || typeof t.id !== 'string' || typeof t.name !== 'string' || typeof t.enabled !== 'boolean' || !/^push-[a-z0-9-]+$/.test(t.credentialId) || !/^[a-f0-9]{64}$/.test(t.fingerprint))) throw Error('invalid push channel configuration')
    ids.add(c.id)
  }
  if (state.pushDeliveries !== undefined && (!Array.isArray(state.pushDeliveries) || state.pushDeliveries.length > 1000)) throw Error('invalid push outbox')
  for (const r of state.pushDeliveries ?? []) {
    if (!r || typeof r.id !== 'string' || typeof r.companionId !== 'string' || typeof r.channelId !== 'string' || typeof r.targetId !== 'string'
      || typeof r.title !== 'string' || typeof r.body !== 'string' || !Number.isFinite(r.createdAt) || !Number.isFinite(r.nextAttemptAt)
      || (r.expiresAt !== undefined && !Number.isFinite(r.expiresAt))
      || !['pending','sending','accepted','failed','canceled'].includes(r.status) || !Number.isSafeInteger(r.attempts)) throw Error('invalid push delivery')
  }
}
