import { dirname, isAbsolute, join, resolve } from 'node:path'

/** Storage format versions are independent of package and PartnerState versions. */
export const TARGET_STORAGE_VERSION = 1
export const READABLE_STORAGE_VERSION = 1

export function storageVersion(value: unknown): number {
  if (value === undefined) return 0
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('storageVersion 必须是非负整数')
  return value
}

export function companionDirectory(root: string, id: string): string {
  if (!id || id === '.' || id === '..' || /[/\\\0:]/.test(id)) throw new Error('伙伴目录标识无效')
  return join(resolve(root), 'partners', id)
}

export function storageLayout(statePath: string, root: string) {
  // Relative paths must be resolved once at initialization, not per request.
  if (!isAbsolute(statePath) || !isAbsolute(root)) throw new Error('存储检查要求绝对路径')
  const legacyPublic = dirname(statePath)
  return {
    legacyPublic,
    publicRoot: join(legacyPublic, 'storage-v1'),
    legacySkills: join(root, 'partner-system', 'skills'),
    privateRoot: (id: string) => join(companionDirectory(root, id), '.partner'),
    legacyCompanion: (id: string) => companionDirectory(root, id),
  }
}
