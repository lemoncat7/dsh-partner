import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PartnerStore } from '../lib/store.js'
import { SkillService } from '../lib/skills/service.js'
import { SkillRepository } from '../lib/skills/repository.js'
import { STORY_BUILTINS } from '../lib/skills/story-builtins.js'
import { loadBuiltinResources, builtinResourcesMatch } from '../lib/skills/builtin-resources.js'
import { excludedStoryResourcePrefixes, includeStoryResource } from '../scripts/story-resource-policy.mjs'

for (const [id, builtin] of STORY_BUILTINS) test(`${id}: install offline, read resources and repair without oh-story runtime`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'story-builtin-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = await PartnerStore.open(join(root, 'state.json'))
  const service = new SkillService(store, new SkillRepository(join(root, 'skills')))
  await service.initialize()
  assert.deepEqual(store.snapshot().skills, [])
  const installed = await service.installMarket('builtin', id)
  const loaded = await service.load(id)
  assert.equal(loaded.executionContext, 'inline')
  assert.equal(installed.source, 'builtin')
  assert.deepEqual(store.snapshot().skillBindings, [])
  const files = await loadBuiltinResources(id)
  assert.equal(await builtinResourcesMatch(installed.rootPath, files), true)
  const paths = [...builtin.document.matchAll(/upstream\/[a-zA-Z0-9/-]+\.md/g)].map(m => m[0])
  assert.ok(paths.length > 0)
  for (const path of paths) assert.ok((await readFile(join(installed.rootPath, path))).length > 0, path)
  const license = files.find(f => /\/LICENSE(?:\.upstream)?$/.test(f.path))
  assert.match(Buffer.from(license.bytes).toString('utf8'), /MIT License/)
  const moduleCount = files.filter(f => /^upstream\/skills\/[^/]+\/SKILL.md$/.test(f.path)).length
  assert.equal(moduleCount, { 'story-creation': 13, 'novel-game-creation': 7, 'video-recap-production': 6 }[id])
  await service.setBinding('companion-default', id, true)
  const bindings = structuredClone(store.snapshot().skillBindings)
  await rm(join(installed.rootPath, paths[0]))
  await service.initialize()
  assert.equal(await builtinResourcesMatch(installed.rootPath, files), true)
  assert.deepEqual(store.snapshot().skillBindings, bindings)
})

test('game distribution excludes optional examples but preserves every upstream skill resource', async () => {
  const root = new URL('../resources/skills/novel-game-creation/', import.meta.url)
  const original = JSON.parse(await readFile(new URL('upstream/manifest.json', root), 'utf8'))
  const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'))
  const expected = original.files.filter(file => includeStoryResource('novel-game-creation', file.path))
  assert.deepEqual(manifest.files.filter(file => file.path !== 'upstream/manifest.json'),
    expected.map(file => ({ path: `upstream/${file.path}`, sha256: file.sha256 })))
  assert.ok(!manifest.files.some(file => file.path.startsWith('upstream/examples/')))
  assert.ok(manifest.files.some(file => file.path === 'upstream/LICENSE'))
  for (const file of original.files.filter(file => file.path.startsWith('skills/'))) {
    assert.ok(manifest.files.some(candidate => candidate.path === `upstream/${file.path}` && candidate.sha256 === file.sha256), file.path)
  }
  const ignores = (await readFile(new URL('.npmignore', root), 'utf8')).trim().split('\n')
  assert.deepEqual(ignores, excludedStoryResourcePrefixes('novel-game-creation').map(path => `/upstream/${path}`))
  assert.match(STORY_BUILTINS.get('novel-game-creation').document, /不分发上游 examples/)
  assert.equal(includeStoryResource('novel-game-creation', 'examples/new-example/build/app/assets/huge.webp'), false)
  for (const id of ['story-creation', 'video-recap-production']) {
    assert.equal(includeStoryResource(id, 'skills/module/scripts/main.py'), true)
    assert.equal(includeStoryResource(id, 'skills/module/.gitignore'), false)
    assert.deepEqual(excludedStoryResourcePrefixes(id), [])
  }
})

test('game skill upgrade removes old bundled examples and preserves authorization', async t => {
  const root = await mkdtemp(join(tmpdir(), 'game-slim-upgrade-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = await PartnerStore.open(join(root, 'state.json'))
  const repository = new SkillRepository(join(root, 'skills'))
  const service = new SkillService(store, repository)
  const id = 'novel-game-creation'
  const builtin = STORY_BUILTINS.get(id)
  const files = await loadBuiltinResources(id)
  const examplePath = 'upstream/examples/old-game/build/app/assets/example.webp'
  const installed = await repository.install({ id,
    document: builtin.document.replace('version: 1.0.1', 'version: 1.0.0'),
    files: [...files, { path: examplePath, bytes: Buffer.from('old bundled example') }],
    source: 'builtin', sourceId: 'builtin', trusted: true })
  await store.update(state => { state.skills.push(installed) })
  await service.setBinding('companion-default', id, true)
  const bindings = structuredClone(store.snapshot().skillBindings)
  await service.initialize()
  assert.equal((await service.load(id)).version, '1.0.1')
  assert.equal(await builtinResourcesMatch(installed.rootPath, files), true)
  await assert.rejects(readFile(join(installed.rootPath, examplePath)), { code: 'ENOENT' })
  assert.deepEqual(store.snapshot().skillBindings, bindings)
  assert.equal(store.snapshot().skills.length, 1)
  await service.initialize()
  assert.deepEqual(store.snapshot().skillBindings, bindings)
})
