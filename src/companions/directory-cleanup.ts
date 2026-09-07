import { lstat, opendir, readFile, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'

/** Only the configured partners/<id> child is eligible; never accept a UI path. */
export async function assertOwnedDirectory(root: string, id: string, sharedPaths: readonly string[]): Promise<string> {
  if (!id || id === '.' || id === '..' || /[/\\\0]/.test(id)) throw new Error('伙伴目录标识无效')
  const base = await realpath(root)
  const parent = join(base, 'partners')
  const target = join(parent, id)
  if (!isAbsolute(target) || resolve(target) === base || resolve(target) === parent) throw new Error('拒绝清理非伙伴专属目录')
  for (const path of [parent, target]) {
    try {
      const entry = await lstat(path)
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('伙伴目录包含链接或不是普通目录，拒绝自动删除')
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  try { await assertSameDeviceTree(target, (await lstat(parent)).dev) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  for (const path of sharedPaths) {
    let shared: string
    try { shared = await realpath(path) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; shared = resolve(path) }
    if (shared === target || shared.startsWith(target + sep)) throw new Error('其他伙伴或空间仍在使用此目录，拒绝删除共享文件')
  }
  // rm must never traverse a mounted volume, including same-device bind mounts.
  if (process.platform === 'linux') {
    const mounts = await readFile('/proc/self/mountinfo', 'utf8')
    for (const line of mounts.split('\n')) {
      const mount = line.split(' ')[4]?.replace(/\\([0-7]{3})/g, (_, value: string) => String.fromCharCode(parseInt(value, 8)))
      if (mount === target || mount?.startsWith(target + sep)) throw new Error('伙伴目录包含挂载点，拒绝递归删除挂载数据')
    }
  }
  return target
}

export async function removeOwnedDirectory(root: string, id: string, sharedPaths: readonly string[]): Promise<void> {
  const target = await assertOwnedDirectory(root, id, sharedPaths)
  // Node removes nested symbolic links themselves; it does not follow them.
  await rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 })
}

async function assertSameDeviceTree(target: string, device: number): Promise<void> {
  const pending = [target]
  let inspected = 0
  while (pending.length) {
    const path = pending.pop()!
    const entry = await lstat(path)
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue
    if (entry.dev !== device) throw new Error('伙伴目录包含挂载数据，拒绝递归删除')
    if (++inspected > 100_000) throw new Error('伙伴目录过大，无法安全自动清理，请手动处理')
    const directory = await opendir(path)
    for await (const child of directory) if (child.isDirectory()) pending.push(join(path, child.name))
  }
}
