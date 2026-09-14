import Schema from '@deepseek-ai/schemastery'
import { READABLE_STORAGE_VERSION, storageVersion } from './storage/layout.js'

export interface Config {
  statePath: string
  storageVersion?: number
  exposeWeb: boolean
  apiPrefix: string
  defaultCwd: string
  autoStartChannels: boolean
  timeZone: string
}

export const Config: Schema<Config> = Schema.object({
  statePath: Schema.string().required(),
  storageVersion: Schema.number().min(0).step(1).default(0).description('数据目录版本，由升级迁移流程维护，请勿手动修改。'),
  exposeWeb: Schema.boolean().default(true),
  apiPrefix: Schema.string().default('/partner-local/v1'),
  defaultCwd: Schema.string().default(''),
  autoStartChannels: Schema.boolean().default(true),
  timeZone: Schema.string().default('Asia/Shanghai'),
})

export function resolveConfig(config: Config): Config {
  if (!config.statePath?.trim()) throw new Error('dsh-partner requires statePath')
  const version = storageVersion(config.storageVersion)
  if (version > READABLE_STORAGE_VERSION) throw new Error('此插件尚不能读取该 storageVersion，已阻止写入；请使用支持该数据版本的插件。')
  const apiPrefix = normalizePrefix(config.apiPrefix ?? '/partner-local/v1')
  return {
    statePath: config.statePath,
    storageVersion: version,
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
