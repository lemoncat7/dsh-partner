// Offline import from an installed @oh-story/dsh resource snapshot.
// No plugin runtime, secrets, generated adapter config or network access is copied.
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { excludedStoryResourcePrefixes, includeStoryResource } from './story-resource-policy.mjs'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const bundles = ['story-creation', 'novel-game-creation', 'video-recap-production']
if (process.argv.length !== 5) throw new Error('Usage: node scripts/bundle-story-skills.mjs STORY_ROOT GAME_ROOT VIDEO_ROOT')
for (const [i, id] of bundles.entries()) {
  const source = resolve(process.argv[i + 2])
  const upstream = JSON.parse(await readFile(resolve(source, 'manifest.json'), 'utf8'))
  if (!/^[a-f0-9]{40}$/.test(upstream.upstream?.commit) || !Array.isArray(upstream.files) || upstream.files.length > 498) throw new Error('Invalid upstream manifest')
  const files = []
  // Validate every source byte before writing any of this bundle.
  for (const entry of upstream.files) {
    if (!entry.path || entry.path.split('/').some(p => !p || p === '..' || p === '.') || /[\\:]/.test(entry.path)) throw new Error('Unsafe upstream path')
    const bytes = await readFile(resolve(source, entry.path))
    if (hash(bytes) !== entry.sha256) throw new Error(`Upstream checksum mismatch: ${id}/${entry.path}`)
    // npm renames .gitignore to .npmignore; it is repository metadata, not a skill asset.
    if (includeStoryResource(id, entry.path)) files.push({ path: `upstream/${entry.path}`, bytes })
  }
  const license = files.find(f => /\/LICENSE(?:\.upstream)?$/.test(f.path))
  if (!license || !license.bytes.toString('utf8').includes('MIT License')) throw new Error('Expected MIT license')
  files.push({ path: 'upstream/manifest.json', bytes: await readFile(resolve(source, 'manifest.json')) })
  const target = new URL(`../resources/skills/${id}/`, import.meta.url)
  for (const file of files) {
    const path = new URL(file.path, target)
    await mkdir(dirname(fileURLToPath(path)), { recursive: true })
    await writeFile(path, file.bytes)
  }
  const manifest = { schemaVersion: 1, repository: upstream.upstream.repository, commit: upstream.upstream.commit,
    releaseVersion: upstream.upstream.releaseVersion, extractedFrom: '@oh-story/dsh@0.1.12-cjsfix.1', license: 'MIT',
    excluded: ['repository-only .gitignore files', ...excludedStoryResourcePrefixes(id).map(path => `upstream/${path} (optional upstream example projects; not required by skill modules)`)],
    files: files.map(({path, bytes}) => ({path, sha256: hash(bytes)})) }
  await writeFile(new URL('manifest.json', target), JSON.stringify(manifest, null, 2) + '\n')
  // Also exclude old examples left in an existing checkout after a re-import.
  await writeFile(new URL('.npmignore', target), excludedStoryResourcePrefixes(id).map(path => `/upstream/${path}`).join('\n') + '\n')
  console.log(`${id}: ${files.length} verified resources`)
}
