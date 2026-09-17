import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { AvatarImage } from './direct/avatar.js'

const LIMIT = 2 * 1024 * 1024
export async function readAvatarImage(cwd: string, path: string, signal: AbortSignal): Promise<AvatarImage> {
  signal.throwIfAborted()
  if (!path || path.length > 4096 || path.includes('\0') || /^[a-z]+:\/\//i.test(path)) throw new Error('头像必须使用当前会话目录内的本地图片路径')
  const root = await realpath(cwd), actual = await realpath(resolve(root, path))
  const rel = relative(root, actual)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('头像图片超出当前会话目录，不能读取其他伙伴或系统文件')
  const file = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size < 4 || before.size > LIMIT) throw new Error('头像必须是 2 MB 以内的 PNG/JPEG 普通文件')
    const bytes = Buffer.alloc(before.size + 1)
    let size = 0
    while (size < bytes.length) {
      signal.throwIfAborted()
      const read = await file.read(bytes, size, bytes.length - size, size)
      if (!read.bytesRead) break
      size += read.bytesRead
    }
    const after = await file.stat()
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('头像文件在读取时发生变化，请重试')
    const data = bytes.subarray(0, size)
    const png = data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && data.toString('ascii', 12, 16) === 'IHDR'
    const jpeg = data[0] === 255 && data[1] === 216 && data[2] === 255
    if (!png && !jpeg) throw new Error('头像文件不是有效的 PNG/JPEG 图片；不支持 SVG、HTML 或仅修改扩展名的文件')
    if (png && (!data.readUInt32BE(16) || !data.readUInt32BE(20) || data.readUInt32BE(16) > 4096 || data.readUInt32BE(20) > 4096)) throw new Error('PNG 头像尺寸不得超过 4096 × 4096')
    return { bytes: data, mediaType: png ? 'image/png' : 'image/jpeg' }
  } finally { await file.close() }
}
