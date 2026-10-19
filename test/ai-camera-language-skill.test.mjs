import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { PartnerStore } from '../lib/store.js'
import { SkillService } from '../lib/skills/service.js'
import { SkillRepository } from '../lib/skills/repository.js'
import { BUILTIN_SKILLS } from '../lib/skills/builtin.js'
import { loadBuiltinResources, builtinResourcesMatch } from '../lib/skills/builtin-resources.js'
import { sha256 } from '../lib/skills/loader.js'

test('camera skill is an optional offline builtin with complete, linked references', async t => {
  const root = await mkdtemp(join(tmpdir(), 'camera-builtin-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = await PartnerStore.open(join(root, 'state.json'))
  const service = new SkillService(store, new SkillRepository(join(root, 'skills')))
  await service.initialize()
  assert.deepEqual(store.snapshot().skills, [])
  const id = 'ai-camera-language'
  const builtin = BUILTIN_SKILLS.get(id)
  assert.equal(builtin.entry.name, 'AI 镜头语言与运镜')
  assert.equal(builtin.entry.sourceId, 'builtin')
  const installed = await service.installMarket('builtin', id)
  const loaded = await service.load(id)
  assert.equal(loaded.executionContext, 'inline')
  assert.equal(loaded.version, '1.0.0')
  assert.deepEqual(store.snapshot().skillBindings, [])
  const files = await loadBuiltinResources(id)
  assert.equal(files.filter(f => f.path.startsWith('references/')).length, 3)
  assert.ok(files.every(f => f.path.endsWith('.md') || f.path === 'manifest.json'))
  assert.ok(files.reduce((sum, f) => sum + f.bytes.length, 0) < 65_536)
  assert.equal(await builtinResourcesMatch(installed.rootPath, files), true)
  const manifest = JSON.parse(await readFile(join(installed.rootPath, 'manifest.json'), 'utf8'))
  const original = builtin.document.split('\n## 伙伴内置版路径与协作\n')[0].trimEnd() + '\n'
  assert.equal(sha256(original.replace('display-name: AI 镜头语言与运镜\nversion: 1.0.0\ncontext: inline\n', '')), manifest.provenance.entrySha256)
  for (const file of [{ path: 'SKILL.md', bytes: Buffer.from(builtin.document) }, ...files.filter(f => f.path.endsWith('.md'))]) {
    const markdown = Buffer.from(file.bytes).toString('utf8')
    for (const [, link] of markdown.matchAll(/\]\(([^)]+\.md(?:#[^)]*)?)\)/g)) {
      if (/^https?:/.test(link)) continue
      const target = resolve(installed.rootPath, dirname(file.path), link.split('#')[0])
      assert.ok((await readFile(target)).length > 0, `${file.path}: ${link}`)
    }
  }
  const dictionary = await readFile(join(installed.rootPath, 'references/camera-dictionary.md'), 'utf8')
  assert.deepEqual([...dictionary.matchAll(/^## (\d{2}) /gm)].map(m => Number(m[1])), Array.from({ length: 32 }, (_, i) => i + 1))
  const summary = await readFile(join(installed.rootPath, 'references/video-summary.md'), 'utf8')
  assert.deepEqual([...summary.matchAll(/^\| (\d{2}) \|/gm)].map(m => Number(m[1])), Array.from({ length: 32 }, (_, i) => i + 1))
  await service.setBinding('companion-default', id, true)
  const bindings = structuredClone(store.snapshot().skillBindings)
  const dictionaryPath = join(installed.rootPath, 'references/camera-dictionary.md')
  await rm(dictionaryPath)
  await service.initialize()
  assert.equal(await builtinResourcesMatch(installed.rootPath, files), true)
  await writeFile(dictionaryPath, 'damaged reference')
  await service.initialize()
  assert.equal(await builtinResourcesMatch(installed.rootPath, files), true)
  assert.deepEqual(store.snapshot().skillBindings, bindings)
  assert.equal(service.bindings('companion-default')[0].id, id)
  await service.setBinding('companion-default', id, false)
  await service.initialize()
  assert.deepEqual(service.bindings('companion-default'), [])
  await service.uninstall(id)
  await service.initialize()
  assert.deepEqual(store.snapshot().skills, [])
  assert.deepEqual(store.snapshot().skillBindings, [])
})
