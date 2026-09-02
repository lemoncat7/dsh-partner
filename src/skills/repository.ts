import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { loadSkill, skillMetadata } from './loader.js'
import type { LoadedSkill, PartnerSkill, SkillSourceKind } from './domain.js'

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,119}$/i

export class SkillRepository {
  constructor(readonly root: string) {}

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
  }

  async read(skill: PartnerSkill): Promise<LoadedSkill> {
    assertInside(this.root, skill.rootPath)
    return loadSkill({
      id: skill.id, rootPath: skill.rootPath, source: skill.source, ...(skill.sourceId ? { sourceId: skill.sourceId } : {}),
      trusted: skill.trusted, installedAt: skill.installedAt, updatedAt: skill.updatedAt,
    })
  }

  async install(input: { id: string; document: string; source: SkillSourceKind; sourceId?: string; trusted: boolean; now?: number }): Promise<PartnerSkill> {
    if (!SAFE_ID.test(input.id)) throw new Error('Skill id is invalid')
    if (Buffer.byteLength(input.document) > 512 * 1024) throw new Error('SKILL.md exceeds the 512 KiB limit')
    await this.initialize()
    const now = input.now ?? Date.now()
    const target = join(this.root, input.id)
    const temporary = join(this.root, `.${input.id}.${randomUUID()}.tmp`)
    const backup = join(this.root, `.${input.id}.${randomUUID()}.backup`)
    await mkdir(temporary, { recursive: false, mode: 0o700 })
    try {
      await writeFile(join(temporary, 'SKILL.md'), input.document, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      const loaded = await loadSkill({
        id: input.id, rootPath: temporary, source: input.source, ...(input.sourceId ? { sourceId: input.sourceId } : {}),
        trusted: input.trusted, installedAt: now, updatedAt: now,
      })
      let replaced = false
      try { await rename(target, backup); replaced = true } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      try { await rename(temporary, target) }
      catch (error) {
        if (replaced) await rename(backup, target).catch(() => {})
        throw error
      }
      await rm(backup, { recursive: true, force: true })
      return { ...skillMetadata(loaded), rootPath: target }
    } finally {
      await rm(temporary, { recursive: true, force: true }).catch(() => {})
    }
  }

  async remove(skill: PartnerSkill): Promise<void> {
    assertInside(this.root, skill.rootPath)
    await rm(skill.rootPath, { recursive: true, force: true })
  }

}

function assertInside(root: string, path: string): void {
  const base = resolve(root)
  const candidate = resolve(path)
  const rel = relative(base, candidate)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Skill path escapes the repository')
  if (dirname(candidate) !== base) throw new Error('Skill path must be a direct repository child')
}
