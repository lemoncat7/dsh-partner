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
