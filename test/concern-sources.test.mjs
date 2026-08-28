import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileToken, listConcernFileSources } from '../lib/concern-sources.js'

test('lists bounded companion files while excluding private state and symlinks', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-partner-sources-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'docs'), { recursive: true })
  await mkdir(join(root, 'memory'), { recursive: true })
  await writeFile(join(root, 'docs', 'road map.md'), 'plan')
  await writeFile(join(root, 'memory', 'private.json'), '{}')
  await symlink(join(root, 'docs', 'road map.md'), join(root, 'linked.md'))

  const items = await listConcernFileSources(root, 'road', 20)
  assert.deepEqual(items, [{
    kind: 'file', label: 'docs/road map.md', detail: '当前会话文件 · docs', token: '@"docs/road map.md"',
  }])
  assert.equal(fileToken('docs/notes.md'), '@docs/notes.md')
})
