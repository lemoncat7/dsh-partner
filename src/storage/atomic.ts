import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const file = await open(path, 'r'); try { await file.sync() } finally { await file.close() }
}
export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    const file = await open(temp, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync() } finally { await file.close() }
    // Never unlink the previous committed file as a Windows fallback.
    await rename(temp, path)
    await syncDirectory(dirname(path))
  } finally { await rm(temp, { force: true }).catch(() => {}) }
}
