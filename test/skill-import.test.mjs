import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { prepareSkillPackage } from '../lib/skills/package.js'
import { readSkillZip, packageCrc } from '../lib/skills/package-zip.js'
import { decodeSkillImport } from '../lib/skills/import-request.js'
import { SkillRepository } from '../lib/skills/repository.js'
import { PartnerStore } from '../lib/store.js'
import { SkillService } from '../lib/skills/service.js'

const document = '---\nname: 中文技能\ndescription: 导入测试\ncontext: inline\n---\n读取 references/guide.md 并按说明执行。'
const files = [
  { path: '示例/SKILL.md', bytes: Buffer.from(document) },
  { path: '示例/references/guide.md', bytes: Buffer.from('参考资料') },
  { path: '示例/scripts/check.sh', bytes: Buffer.from('echo test') },
  { path: '示例/assets/image.bin', bytes: Buffer.from([0, 255, 1, 128]) },
]

test('service import persists package metadata without enabling or overwriting existing skills', async t => {
  const root = await mkdtemp(join(tmpdir(), 'partner-skill-service-import-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = await PartnerStore.open(join(root, 'state.json'))
  const service = new SkillService(store, new SkillRepository(join(root, 'skills')))
  await service.initialize()
  const bindings = structuredClone(store.snapshot().skillBindings)
  const first = await service.importPackage(files)
  const second = await service.importPackage(zip(files))
  assert.notEqual(first.id, second.id)
  assert.equal(store.snapshot().skills.length, 2)
  assert.deepEqual(store.snapshot().skillBindings, bindings)
  assert.equal((await service.load(first.id)).name, '中文技能')
  assert.equal(await readFile(join(second.rootPath, 'references/guide.md'), 'utf8'), '参考资料')
})
function zip(entries, method = 8, mode = 0x8000) {
  const locals = [], centrals = []; let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.path), data = Buffer.from(entry.bytes), compressed = method === 8 ? deflateRawSync(data) : data
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(method, 8)
    local.writeUInt32LE(packageCrc(data), 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(method, 10)
    central.writeUInt32LE(packageCrc(data), 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE((mode * 65536) >>> 0, 38); central.writeUInt32LE(offset, 42)
    locals.push(local, name, compressed); centrals.push(central, name)
    offset += local.length + name.length + compressed.length
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

test('directory and stored/deflated ZIP preserve complete package including binary resources', async t => {
  const root = await mkdtemp(join(tmpdir(), 'partner-skill-import-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = new SkillRepository(root)
  for (const [index, bundle] of [prepareSkillPackage(files), await readSkillZip(zip(files)), await readSkillZip(zip(files, 0))].entries()) {
    const installed = await repository.install({ id: `fixture-${index}`, ...bundle, source: 'local', trusted: true })
    assert.equal(installed.displayName, '中文技能')
    assert.equal(await readFile(join(installed.rootPath, 'references/guide.md'), 'utf8'), '参考资料')
    assert.equal(await readFile(join(installed.rootPath, 'scripts/check.sh'), 'utf8'), 'echo test')
    assert.deepEqual(await readFile(join(installed.rootPath, 'assets/image.bin')), Buffer.from([0, 255, 1, 128]))
  }
})

test('unsafe paths, ambiguous skills, case collisions and file/directory conflicts are rejected', async () => {
  for (const path of ['../outside', '/outside', 'C:/outside', 'a/../../outside', 'a\u0000b', 'con.txt']) {
    assert.throws(() => prepareSkillPackage([...files, { path, bytes: Buffer.alloc(0) }]))
    await assert.rejects(readSkillZip(zip([...files, { path, bytes: Buffer.alloc(0) }])))
  }
  assert.throws(() => prepareSkillPackage([...files, { path: 'another/SKILL.md', bytes: Buffer.from(document) }]), /多个 Skill/)
  assert.throws(() => prepareSkillPackage([...files, { path: '示例/skill.md', bytes: Buffer.from(document) }]), /重复/)
  assert.throws(() => prepareSkillPackage([...files, { path: '示例/scripts', bytes: Buffer.alloc(0) }]), /路径冲突/)
  assert.throws(() => prepareSkillPackage([{ path: 'README.md', bytes: Buffer.from(document) }]), /没有找到 SKILL.md/)
})

test('ZIP rejects symlinks, corruption, encryption and size bombs', async () => {
  await assert.rejects(readSkillZip(zip(files, 8, 0xa000)), /符号链接/)
  const corrupt = zip(files, 0); corrupt[30 + Buffer.byteLength(files[0].path)] ^= 1
  await assert.rejects(readSkillZip(corrupt), /校验失败/)
  const encrypted = zip(files); const central = encrypted.readUInt32LE(encrypted.length - 6)
  encrypted.writeUInt16LE(1, central + 8)
  await assert.rejects(readSkillZip(encrypted), /加密/)
  const bomb = zip(files); bomb.writeUInt32LE(9 * 1024 * 1024, central + 24)
  await assert.rejects(readSkillZip(bomb), /大小/)
})

test('import transport validates base64 and bounds before decoding', () => {
  assert.equal(prepareSkillPackage(decodeSkillImport({ kind: 'directory', files: files.map(file => ({ path: file.path, data: file.bytes.toString('base64') })) })).document, document)
  assert.throws(() => decodeSkillImport({ kind: 'zip', data: '!!!=' }), /编码/)
  assert.throws(() => decodeSkillImport({ kind: 'directory', files: new Array(513).fill({ path: 'x', data: '' }) }))
})
