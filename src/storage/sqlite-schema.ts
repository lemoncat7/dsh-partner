import type { DatabaseSync } from 'node:sqlite'

/** Connection options are local; schema writes run only during a version upgrade.
 * Bump the caller's version whenever its initializer changes. Do not cache by path:
 * storage migration, deletion and restoration may replace the database file.
 */
export function initializeSqliteSchema(database: DatabaseSync, version: number, initialize: () => void): void {
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('Invalid SQLite schema version')
  database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  const currentVersion = () => Number(database.prepare('PRAGMA user_version').get()?.user_version ?? 0)
  const needsUpgrade = () => {
    const current = currentVersion()
    if (current > version) throw new Error(`伙伴数据库版本 ${current} 高于当前支持的 ${version}，请升级插件`)
    return current < version
  }
  if (!needsUpgrade()) return

  // WAL cannot be enabled inside a transaction. Keep SQLite's durability defaults.
  database.exec('PRAGMA journal_mode = WAL; BEGIN IMMEDIATE;')
  try {
    // Another process may have migrated while we waited for the write lock.
    if (needsUpgrade()) {
      initialize()
      database.exec(`PRAGMA user_version = ${version}`)
    }
    database.exec('COMMIT')
  } catch (error) {
    try { database.exec('ROLLBACK') } catch { /* Preserve the original failure. */ }
    throw error
  }
}
