import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { sha256 } from './loader.js'
import { packagePath, prepareSkillPackage, type SkillPackageFile } from './package.js'

/** Only explicitly bundled resources are installed; this path never fetches upstream. */
export async function loadBuiltinResources(id?: string): Promise<SkillPackageFile[]> {
  if (!id) return []
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error('Invalid built-in resource bundle')
  const root = fileURLToPath(new URL(`../../resources/skills/${id}/`, import.meta.url))
  const manifestBytes = await readFile(join(root, 'manifest.json'))
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as { schemaVersion: number; commit: string; files: Array<{ path: string; sha256: string }> }
  if (manifest.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(manifest.commit) || !Array.isArray(manifest.files) || manifest.files.length > 500) throw new Error('Invalid built-in resource manifest')
  const files: SkillPackageFile[] = []
  for (const entry of manifest.files) {
    const path = packagePath(entry.path)
    if (!path.startsWith('upstream/')) throw new Error('Invalid built-in resource path')
    const bytes = await readFile(join(root, path))
    if (sha256(bytes) !== entry.sha256) throw new Error(`内置 Skill 资源校验失败：${id}/${path}`)
    files.push({ path, bytes })
  }
  files.push({ path: 'manifest.json', bytes: manifestBytes })
  return prepareSkillPackage([{ path: 'SKILL.md', bytes: Buffer.from('# Built-in resource validation\n') }, ...files]).files
}

/** Repair missing/stale assets on startup without touching bindings or downloading updates. */
export async function builtinResourcesMatch(root: string, files: SkillPackageFile[]): Promise<boolean> {
  for (const file of files) {
    try { if (sha256(await readFile(join(root, file.path))) !== sha256(file.bytes)) return false }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  }
  return true
}
