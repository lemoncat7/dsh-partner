import Schema from '@deepseek-ai/schemastery'

export interface Config {
  statePath: string
  exposeWeb: boolean
  apiPrefix: string
  defaultCwd: string
  autoStartChannels: boolean
  timeZone: string
}

export const Config: Schema<Config> = Schema.object({
  statePath: Schema.string().required(),
  exposeWeb: Schema.boolean().default(true),
  apiPrefix: Schema.string().default('/partner-local/v1'),
  defaultCwd: Schema.string().default(''),
  autoStartChannels: Schema.boolean().default(true),
  timeZone: Schema.string().default('Asia/Shanghai'),
})

export function resolveConfig(config: Config): Config {
  if (!config.statePath?.trim()) throw new Error('dsh-partner requires statePath')
  const apiPrefix = normalizePrefix(config.apiPrefix ?? '/partner-local/v1')
  return {
    statePath: config.statePath,
    exposeWeb: config.exposeWeb ?? true,
    apiPrefix,
    defaultCwd: config.defaultCwd?.trim() || process.cwd(),
    autoStartChannels: config.autoStartChannels ?? true,
    timeZone: validTimeZone(config.timeZone?.trim() || 'Asia/Shanghai'),
  }
}

function validTimeZone(value: string): string {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format() }
  catch { throw new Error(`invalid timeZone: ${value}`) }
  return value
}

function normalizePrefix(value: string): string {
  const normalized = `${value.startsWith('/') ? '' : '/'}${value}`.replace(/\/+$/, '')
  if (!/^\/[a-zA-Z0-9/_-]+$/.test(normalized)) throw new Error('apiPrefix must be an absolute URL path')
  return normalized
}
