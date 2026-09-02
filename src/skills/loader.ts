import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { SKILL_CONTEXTS, type LoadedSkill, type PartnerSkill, type SkillExecutionContext, type SkillSourceKind } from './domain.js'

const MAX_SKILL_BYTES = 512 * 1024
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,79}$/i

export interface SkillLoadInput {
  id: string
  rootPath: string
  source: SkillSourceKind
  sourceId?: string
  trusted: boolean
  installedAt: number
  updatedAt: number
}
export async function loadSkill(input: SkillLoadInput): Promise<LoadedSkill> {
  const file = resolve(input.rootPath, 'SKILL.md')
  const buffer = await readFile(file)
  if (buffer.byteLength > MAX_SKILL_BYTES) throw new Error('SKILL.md exceeds the 512 KiB limit')
  const raw = buffer.toString('utf8')
  const { metadata, body } = parseSkillDocument(raw)
  const name = field(metadata, 'name') ?? basename(input.rootPath)
  if (!SAFE_NAME.test(name)) throw new Error('Skill name must use letters, numbers, dot, underscore or dash')
  const description = field(metadata, 'description') ?? firstSentence(body)
  if (!description) throw new Error('Skill description is required')
  const requestedContext = enumField(metadata, 'context', SKILL_CONTEXTS) ?? 'fork'
  const executionContext: SkillExecutionContext = input.trusted ? requestedContext : 'fork'
  const skill: LoadedSkill = {
    id: input.id,
    name,
    displayName: field(metadata, 'display-name') ?? name,
    description: description.slice(0, 600),
    version: field(metadata, 'version') ?? '0.0.0',
    source: input.source,
    ...(input.sourceId ? { sourceId: input.sourceId } : {}),
    rootPath: input.rootPath,
    checksum: sha256(raw),
    allowedTools: listField(metadata, 'allowed-tools'),
    executionContext,
    userInvocable: booleanField(metadata, 'user-invocable', true),
    trusted: input.trusted,
    installedAt: input.installedAt,
    updatedAt: input.updatedAt,
    body: body.trim(),
  }
  if (!skill.body) throw new Error('Skill body is empty')
  return skill
}

export function skillMetadata(skill: LoadedSkill): PartnerSkill {
  const { body: _body, ...metadata } = skill
  return metadata
}

export function parseSkillDocument(raw: string): { metadata: Map<string, string>; body: string } {
  const metadata = new Map<string, string>()
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) return { metadata, body: raw }
  const lines = raw.replace(/\r\n/g, '\n').split('\n')
  const end = lines.indexOf('---', 1)
  if (end < 0) throw new Error('Skill frontmatter is not closed')
  for (const line of lines.slice(1, end)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const separator = line.indexOf(':')
    if (separator < 1) throw new Error(`Invalid Skill frontmatter line: ${line}`)
    const key = line.slice(0, separator).trim().toLocaleLowerCase()
    const value = unquote(line.slice(separator + 1).trim())
    if (metadata.has(key)) throw new Error(`Duplicate Skill frontmatter field: ${key}`)
    metadata.set(key, value)
  }
  return { metadata, body: lines.slice(end + 1).join('\n') }
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function field(metadata: Map<string, string>, key: string): string | undefined {
  const value = metadata.get(key)?.trim()
  return value || undefined
}
function enumField<const T extends readonly string[]>(metadata: Map<string, string>, key: string, values: T): T[number] | undefined {
  const value = field(metadata, key)
  if (value === undefined) return undefined
  if (!values.includes(value)) throw new Error(`${key} is invalid`)
  return value as T[number]
}
function booleanField(metadata: Map<string, string>, key: string, fallback: boolean): boolean {
  const value = field(metadata, key)?.toLocaleLowerCase()
  if (value === undefined) return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`${key} must be true or false`)
}
function listField(metadata: Map<string, string>, key: string): string[] {
  const raw = field(metadata, key)
  if (!raw) return []
  const value = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw
  return [...new Set(value.split(',').map(item => unquote(item.trim())).filter(Boolean))].slice(0, 64)
}
function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1)
  return value
}
function firstSentence(body: string): string {
  return body.split('\n').map(line => line.replace(/^#+\s*/, '').trim()).find(Boolean)?.slice(0, 600) ?? ''
}
