import type { Capability, CompanionView } from '../client-api.js'

export function companionDraft(companion: CompanionView): { name: string; role: string; description: string; instructions: string; presetId: string; provider: string; model: string; capabilities: Capability[] } { return { name: companion.name, role: companion.role, description: companion.description, instructions: companion.instructions, presetId: companion.presetId ?? '', provider: companion.provider ?? '', model: companion.model ?? '', capabilities: [...companion.capabilities] } }
