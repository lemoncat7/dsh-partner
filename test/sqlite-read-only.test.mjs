import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PartnerMemoryStore } from '../lib/memory-store.js'
import { PartnerConcernStore } from '../lib/concern-store.js'
import { initializeSqliteSchema } from '../lib/storage/sqlite-schema.js'

const stores = [
  { name: 'memory', version: 2, create: root => new PartnerMemoryStore(root),
    read: store => store.renewalStatus('c'),
    mutate: (store, id) => store.enqueue({ id, companionId: 'c', scopeId: 's', sessionId: 'session', at: 1, user: id, assistant: 'ok' }),
    table: 'memory_jobs',
    legacy: `DROP TABLE persona_state; ALTER TABLE memory_jobs DROP COLUMN repair; PRAGMA user_version=1;` },
  { name: 'concerns', version: 5, create: root => new PartnerConcernStore(root),
    read: store => store.list('c'),
    mutate: (store, id) => store.createExplicit('c', 's', id),
    table: 'concerns',
    legacy: `ALTER TABLE concerns DROP COLUMN observation_progress_json; PRAGMA user_version=4;` },
]

async function fixture(t, spec) {
  const root = await mkdtemp(join(tmpdir(), 'partner-sqlite-read-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = spec.create(root)
  const path = join(root, 'partners', 'c', spec.name, `${spec.name}.sqlite`)
  return { root, store, path }
}
const version = db => Number(db.prepare('PRAGMA data_version').get().data_version)
const walSize = async path => (await stat(`${path}-wal`).catch(error => {
  if (error.code === 'ENOENT') return { size: 0 }
  throw error
})).size

for (const spec of stores) {
  test(`${spec.name}: repeated and concurrent reads, including restarted stores, never write`, async t => {
    const { root, store, path } = await fixture(t, spec)
    await spec.read(store)
    await spec.mutate(store, 'existing evidence')
    const observer = new DatabaseSync(path)
    try {
      const before = version(observer), bytes = await walSize(path)
      for (let i = 0; i < 5; i++) await spec.read(store)
      await Promise.all(Array.from({ length: 8 }, () => spec.read(spec.create(root))))
      assert.equal(version(observer), before, 'reads must not commit a database write')
      assert.equal(await walSize(path), bytes, 'reads must not append WAL frames')
      assert.equal(Number(observer.prepare('PRAGMA user_version').get().user_version), spec.version)
      assert.equal(Number(observer.prepare('PRAGMA synchronous').get().synchronous), 2, 'retain FULL durability')
      await spec.mutate(store, 'new evidence')
      assert.notEqual(version(observer), before, 'observer must detect real mutations')
    } finally { observer.close() }
    // No observer holding the WAL open: the DB file must still be unchanged by reads.
    const before = await stat(path)
    await spec.read(spec.create(root))
    assert.equal((await stat(path)).mtimeMs, before.mtimeMs)
  })

  test(`${spec.name}: legacy missing columns migrate once without losing data`, async t => {
    const { root, store, path } = await fixture(t, spec)
    await spec.mutate(store, 'preserve me')
    const legacy = new DatabaseSync(path)
    try { legacy.exec(spec.legacy) } finally { legacy.close() }
    await spec.read(spec.create(root))
    const observer = new DatabaseSync(path)
    try {
      assert.equal(Number(observer.prepare('PRAGMA user_version').get().user_version), spec.version)
      assert.equal(Number(observer.prepare(`SELECT count(*) AS n FROM ${spec.table}`).get().n), 1)
      const columns = observer.prepare(`PRAGMA table_info(${spec.name === 'memory' ? 'memory_jobs' : 'concerns'})`).all()
      assert.ok(columns.some(row => row.name === (spec.name === 'memory' ? 'repair' : 'observation_progress_json')))
      const before = version(observer)
      await spec.read(spec.create(root))
      assert.equal(version(observer), before)
    } finally { observer.close() }
  })

  test(`${spec.name}: concurrent operations persist and clear recreates schema`, async t => {
    const { root, store, path } = await fixture(t, spec)
    await Promise.all(Array.from({ length: 12 }, (_, i) => Promise.all([
      spec.mutate(store, `evidence-${i}`), spec.read(store),
    ])))
    await spec.read(spec.create(root))
    const observer = new DatabaseSync(path)
    try { assert.equal(Number(observer.prepare(`SELECT count(*) AS n FROM ${spec.table}`).get().n), 12) }
    finally { observer.close() }
    await store.clear('c')
    assert.deepEqual(await spec.read(store), [])
  })

  test(`${spec.name}: freeze rejects pending opens and subsequent access`, async t => {
    const { store, path } = await fixture(t, spec)
    const pending = assert.rejects(spec.read(store), /伙伴数据迁移中/)
    await store.freeze()
    await pending
    await assert.rejects(spec.read(store), /伙伴数据迁移中/)
    await assert.rejects(stat(path), { code: 'ENOENT' })
  })

  test(`${spec.name}: newer databases are rejected without downgrading or writing`, async t => {
    const { store, path } = await fixture(t, spec)
    await spec.read(store)
    const observer = new DatabaseSync(path)
    try {
      observer.exec('PRAGMA user_version=999')
      const before = version(observer)
      await assert.rejects(spec.read(store), /请升级插件/)
      assert.equal(version(observer), before)
      assert.equal(Number(observer.prepare('PRAGMA user_version').get().user_version), 999)
    } finally { observer.close() }
  })
}

test('schema migration rolls back DDL, data and version together; failure is retryable', () => {
  const db = new DatabaseSync(':memory:')
  try {
    initializeSqliteSchema(db, 1, () => db.exec('CREATE TABLE evidence (value TEXT); INSERT INTO evidence VALUES (\'original\')'))
    assert.throws(() => initializeSqliteSchema(db, 2, () => {
      db.exec("CREATE TABLE partial (id TEXT); UPDATE evidence SET value='wrong'")
      throw new Error('migration failure')
    }), /migration failure/)
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1)
    assert.equal(db.prepare('SELECT value FROM evidence').get().value, 'original')
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='partial'").get(), undefined)
    initializeSqliteSchema(db, 2, () => db.exec('CREATE TABLE partial (id TEXT)'))
    initializeSqliteSchema(db, 2, () => assert.fail('must not rerun initialization'))
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2)
  } finally { db.close() }
})

test('failed memory history migration rolls back and retries after malformed legacy data is repaired', async t => {
  const spec = stores[0]
  const { store, path } = await fixture(t, spec)
  await spec.mutate(store, 'history')
  const db = new DatabaseSync(path)
  try {
    const original = db.prepare('SELECT turn_json FROM memory_jobs').get().turn_json
    db.exec(`PRAGMA user_version=1; DROP TABLE persona_state;
      DELETE FROM memory_maintenance WHERE key='history-fts-v1';
      UPDATE memory_jobs SET turn_json='invalid json';`)
    await assert.rejects(spec.read(store), /JSON/)
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1)
    assert.equal(db.prepare("SELECT key FROM memory_maintenance WHERE key='history-fts-v1'").get(), undefined)
    db.prepare('UPDATE memory_jobs SET turn_json=?').run(original)
    await spec.read(store)
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2)
    assert.equal(db.prepare('SELECT count(*) AS n FROM partner_history_fts').get().n, 1)
  } finally { db.close() }
})
