import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PartnerStore } from '../lib/store.js'
import { SkillService } from '../lib/skills/service.js'
import { SkillRepository } from '../lib/skills/repository.js'
import { BUILTIN_SKILLS } from '../lib/skills/builtin.js'
import { loadBuiltinResources, builtinResourcesMatch } from '../lib/skills/builtin-resources.js'

test('drama is one optional offline builtin with all eleven upstream modules and repairable resources', async t => {
  const root = await mkdtemp(join(tmpdir(), 'drama-builtin-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = await PartnerStore.open(join(root, 'state.json'))
  const service = new SkillService(store, new SkillRepository(join(root, 'skills')))
  await service.initialize()
  assert.deepEqual(store.snapshot().skills, [])
  const id = 'drama-production'
  assert.equal(BUILTIN_SKILLS.get(id).entry.name, '漫剧制作')
  const installed = await service.installMarket('builtin', id)
  assert.equal(installed.source, 'builtin')
  assert.equal((await service.load(id)).executionContext, 'inline')
  assert.deepEqual(store.snapshot().skillBindings, [])
  const files = await loadBuiltinResources(id)
  assert.equal(files.filter(f => /^upstream\/skills\/[^/]+\/SKILL.md$/.test(f.path)).length, 11)
  assert.ok(files.some(f => f.path === 'upstream/skills/short-drama/scripts/project_tool.py'))
  assert.ok(files.some(f => f.path === 'upstream/skills/short-drama-produce/scripts/production_tool.py'))
  assert.match(await readFile(join(installed.rootPath, 'upstream/LICENSE'), 'utf8'), /MIT License/)
  assert.equal(await builtinResourcesMatch(installed.rootPath, files), true)
  await service.setBinding('companion-default', id, true)
  const bindings = structuredClone(store.snapshot().skillBindings)
  await rm(join(installed.rootPath, 'upstream/skills/short-drama/SKILL.md'))
  await service.initialize()
  assert.equal(await builtinResourcesMatch(installed.rootPath, files), true)
  assert.deepEqual(store.snapshot().skillBindings, bindings)
})
