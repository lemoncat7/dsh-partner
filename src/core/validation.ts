export function record(value: unknown, label = 'value'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

export function requiredText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${label} is required`)
  const normalized = value.replace(/\s+/gu, ' ').trim()
  if (!normalized) throw new Error(`${label} is required`)
  if (normalized.length > max) throw new Error(`${label} is too long`)
  return normalized
}

export function optionalText(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return requiredText(value, label, max)
}

export function oneOf<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) throw new Error(`${label} is invalid`)
  return value as T[number]
}

export function stringList(value: unknown, label: string, limit = 32, itemMax = 120): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > limit) throw new Error(`${label} must be an array with at most ${limit} items`)
  return [...new Set(value.map(item => requiredText(item, label, itemMax)))]
}

export function optionalBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new Error('value must be a boolean')
  return value
}
