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

test('installed 1.0 creative skills upgrade on initialize and preserve enabled/disabled bindings', async t => {
  const root = await mkdtemp(join(tmpdir(), 'creative-upgrade-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = await PartnerStore.open(join(root, 'state.json'))
  const repository = new SkillRepository(join(root, 'skills'))
  const service = new SkillService(store, repository)
  await service.initialize()
  await store.update(state => { state.companions.push({ ...structuredClone(state.companions[0]), id: 'companion-other', name: 'Other' }) })
  const ids = ['story-creation', 'drama-production', 'viora-canvas-production']
  for (const id of ids) {
    const builtin = BUILTIN_SKILLS.get(id)
    const files = (await loadBuiltinResources(builtin.resourceBundle)).filter(f => f.path !== 'references/story-handoff.md')
    const old = await repository.install({ id, document: `---\nname: ${id}\ndescription: Previous installed skill\nversion: 1.0.0\ncontext: inline\n---\nPrevious instructions`, files, source: 'builtin', sourceId: 'builtin', trusted: true })
    await store.update(state => { state.skills.push(old) })
    await service.setBinding('companion-default', id, true)
    await service.setBinding('companion-other', id, false)
  }
  const before = structuredClone(store.snapshot().skillBindings)
  await service.initialize()
  for (const id of ids) {
    assert.equal((await service.load(id)).version, '1.1.0')
    const installed = store.snapshot().skills.find(s => s.id === id)
    assert.equal(await builtinResourcesMatch(installed.rootPath, await loadBuiltinResources(BUILTIN_SKILLS.get(id).resourceBundle)), true)
  }
  assert.deepEqual(store.snapshot().skillBindings, before)
  await service.initialize()
  assert.deepEqual(store.snapshot().skillBindings, before)
  assert.equal(store.snapshot().skills.length, 3)
})

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
  assert.equal(files.filter(f => f.path.startsWith('references/')).length, 5)
  assert.equal(await builtinResourcesMatch(installed.rootPath, files), true)
  await service.setBinding('companion-default', id, true)
  const bindings = structuredClone(store.snapshot().skillBindings)
  await rm(join(installed.rootPath, 'references/canvas-contract.md'))
  await service.initialize()
  assert.equal(await builtinResourcesMatch(installed.rootPath, files), true)
  assert.deepEqual(store.snapshot().skillBindings, bindings)
})
