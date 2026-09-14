import { readdir } from 'node:fs/promises'

// Only known legacy naming families; never sweep arbitrary user documents.
export const isLegacyMemoryBackup = (name: string): boolean => /^memory[-_](?:backup|back)(?:[-_][a-z0-9][a-z0-9._-]*)?$/i.test(name)
export async function legacyMemoryBackups(root: string): Promise<string[]> {
  try { return (await readdir(root)).filter(isLegacyMemoryBackup).sort() }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
}
