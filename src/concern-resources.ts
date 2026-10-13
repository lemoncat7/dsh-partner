import type { ConcernResource } from './concern-domain.js'

export const concernResourcesSchema = {
  type: 'array', maxItems: 8,
  description: 'Read-only checking sources, NOT the recording destination. Omit to preserve existing sources on update; [] clears them. file locator is workspace-relative; knowledge locator is an exact base name or base/document name. note locator is the exact note ID (not title). Use verified references, never invent document names.',
  items: { type: 'object', additionalProperties: false, properties: {
    kind: { type: 'string', enum: ['file', 'knowledge', 'note'] },
    locator: { type: 'string', maxLength: 500 },
    label: { type: 'string', maxLength: 240 },
  }, required: ['kind', 'locator'] },
}

export function validateConcernResources(input: unknown): ConcernResource[] {
  if (!Array.isArray(input) || input.length > 8) throw new Error('resources 必须为数组，最多 8 个检查依据；清空请传 []')
  const seen = new Set<string>()
  return input.map((entry): ConcernResource => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('检查依据必须包含 kind 和 locator')
    const {kind, locator, label} = entry
    if (kind !== 'file' && kind !== 'knowledge' && kind !== 'note') throw new Error('检查依据 kind 仅支持 file、knowledge 或 note')
    if (typeof locator !== 'string' || !locator.trim() || locator.length > 500 || /[\x00-\x1f\x7f]/u.test(locator)) throw new Error('检查依据 locator 无效')
    if (label !== undefined && (typeof label !== 'string' || !label.trim() || label.length > 240)) throw new Error('检查依据 label 无效')
    const path = locator.trim().replaceAll('\\', '/')
    if (kind === 'file' && (path.startsWith('/') || /^[a-z]:/iu.test(path) || path.split('/').some((part: string) => part === '..' || /^(memory|concerns|\.partner)$/iu.test(part)))) throw new Error('文件依据必须是工作区相对路径，不得引用内部记忆目录')
    return {kind, locator: kind === 'file' ? path : locator.trim(), label: label?.trim() ?? locator.trim().slice(0, 240)}
  }).filter(item => {
    const key = `${item.kind}:${item.locator}`
    if (seen.has(key)) return false
    seen.add(key); return true
  })
}
