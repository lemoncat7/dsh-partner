import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PartnerStore } from '../lib/store.js'
import { SkillService } from '../lib/skills/service.js'
import { SkillRepository } from '../lib/skills/repository.js'
import { BUILTIN_SKILLS } from '../lib/skills/builtin.js'
import { loadBuiltinResources, builtinResourcesMatch } from '../lib/skills/builtin-resources.js'

test('Viora is bundled offline, optional, and repairs resources without changing authorization', async t => {
  const root = await mkdtemp(join(tmpdir(), 'viora-builtin-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = await PartnerStore.open(join(root, 'state.json'))
  const service = new SkillService(store, new SkillRepository(join(root, 'skills')))
  await service.initialize()
  assert.deepEqual(store.snapshot().skills, [])
  const id = 'viora-canvas-production'
  assert.equal(BUILTIN_SKILLS.get(id).entry.sourceId, 'builtin')
  const installed = await service.installMarket('builtin', id)
  assert.equal(installed.source, 'builtin')
  assert.equal((await service.load(id)).executionContext, 'inline')
  assert.deepEqual(store.snapshot().skillBindings, [])
  const files = await loadBuiltinResources(id)
  assert.equal(files.filter(f => f.path.startsWith('references/')).length, 4)
  assert.equal(await builtinResourcesMatch(installed.rootPath, files), true)
  await service.setBinding('companion-default', id, true)
  const bindings = structuredClone(store.snapshot().skillBindings)
  await rm(join(installed.rootPath, 'references/canvas-contract.md'))
  await service.initialize()
  assert.equal(await builtinResourcesMatch(installed.rootPath, files), true)
  assert.deepEqual(store.snapshot().skillBindings, bindings)
})
