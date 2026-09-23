import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PartnerStore } from '../lib/store.js'
import { SkillService } from '../lib/skills/service.js'
import { SkillRepository } from '../lib/skills/repository.js'
import { BUILTIN_SKILLS } from '../lib/skills/builtin.js'
import { loadBuiltinResources, builtinResourcesMatch } from '../lib/skills/builtin-resources.js'
import { parseSkillDocument, sha256 } from '../lib/skills/loader.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'partner-director-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = await PartnerStore.open(join(root, 'state.json'))
  const repository = new SkillRepository(join(root, 'skills'))
  return { root, store, repository, service: new SkillService(store, repository) }
}

test('new installations neither install nor authorize director skills automatically', async t => {
  const { service, store } = await fixture(t)
  await service.initialize()
  assert.deepEqual(store.snapshot().skills, [])
  assert.deepEqual(store.snapshot().skillBindings, [])
})

for (const id of ['director-skills', 'cinematic-director']) {
  test(`${id}: offline install keeps templates, licenses, source and a thin compatible entrypoint`, async t => {
    const { service, store } = await fixture(t)
    const bindings = structuredClone(store.snapshot().skillBindings)
    const entry = BUILTIN_SKILLS.get(id)
    assert.equal(parseSkillDocument(entry.document).metadata.get('context'), 'inline')
    assert.ok(entry.document.length < 4500)
    const installed = await service.installMarket('builtin', id)
    assert.deepEqual(store.snapshot().skillBindings, bindings)
    assert.equal((await service.load(id)).executionContext, 'inline')
    const files = await loadBuiltinResources(id)
    assert.equal(await builtinResourcesMatch(installed.rootPath, files), true)
    const manifest = JSON.parse(await readFile(join(installed.rootPath, 'manifest.json'), 'utf8'))
    assert.equal(manifest.license, 'MIT')
    assert.match(entry.document, new RegExp(manifest.commit))
    assert.ok(manifest.files.some(f => f.path.includes('/references/')))
    assert.match(await readFile(join(installed.rootPath, 'upstream/LICENSE'), 'utf8'), /Permission is hereby granted/)
    for (const file of manifest.files) assert.equal(sha256(await readFile(join(installed.rootPath, file.path))), file.sha256)
    if (id === 'director-skills') assert.equal(manifest.files.filter(f => /^upstream\/skills\/[^/]+\/SKILL.md$/.test(f.path)).length, 9)
    else {
      assert.equal(manifest.files.filter(f => /director_styles\/\d\d_/.test(f.path)).length, 20)
      const raw = await readFile(join(installed.rootPath, 'upstream/SKILL.md'), 'utf8')
      assert.match(raw, /description: >-/)
      assert.match(raw, /metadata:/)
    }
  })

  test(`${id}: upgrades repair missing or stale resources and preserve bindings`, async t => {
    const { service, store } = await fixture(t)
    const installed = await service.installMarket('builtin', id)
    await service.setBinding('companion-default', id, true)
    const bindings = structuredClone(store.snapshot().skillBindings)
    const files = await loadBuiltinResources(id)
    const target = files.find(f => f.path.includes('/references/'))
    await rm(join(installed.rootPath, target.path))
    assert.equal(await builtinResourcesMatch(installed.rootPath, files), false)
    await service.initialize()
    assert.equal(await builtinResourcesMatch(installed.rootPath, files), true)
    assert.deepEqual(store.snapshot().skillBindings, bindings)
    await writeFile(join(installed.rootPath, target.path), 'stale resource')
    await service.initialize()
    assert.equal(await builtinResourcesMatch(installed.rootPath, files), true)
    const updatedAt = store.snapshot().skills[0].updatedAt
    await service.initialize()
    assert.equal(store.snapshot().skills[0].updatedAt, updatedAt)
  })
}

test('resource bundle IDs cannot escape the bundled directory', async () => {
  await assert.rejects(loadBuiltinResources('../private'), /Invalid/)
  assert.deepEqual(await loadBuiltinResources(), [])
})
