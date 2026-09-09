import { inflateRaw } from 'node:zlib'
import { promisify } from 'node:util'
import { packagePath, prepareSkillPackage, SKILL_FILE_LIMIT, SKILL_PACKAGE_FILES, SKILL_PACKAGE_LIMIT, type SkillPackage } from './package.js'
const inflate = promisify(inflateRaw)
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  return crc >>> 0
})
export function packageCrc(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** Bounded async decompression. Never follows links or writes archive paths. */
export async function readSkillZip(bytes: Uint8Array): Promise<SkillPackage> {
  const buffer = Buffer.from(bytes)
  if (buffer.length > SKILL_PACKAGE_LIMIT) throw new Error('ZIP 超过 32 MiB')
  let end = -1
  for (let pos = buffer.length - 22; pos >= Math.max(0, buffer.length - 65557); pos--) {
    if (buffer.readUInt32LE(pos) === 0x06054b50 && pos + 22 + buffer.readUInt16LE(pos + 20) === buffer.length) { end = pos; break }
  }
  if (end < 0) throw new Error('不是有效的 ZIP 压缩包')
  const count = buffer.readUInt16LE(end + 10), centralSize = buffer.readUInt32LE(end + 12), central = buffer.readUInt32LE(end + 16)
  if (buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6) || count !== buffer.readUInt16LE(end + 8) || count > SKILL_PACKAGE_FILES * 2 || central + centralSize !== end) throw new Error('不支持分卷、ZIP64 或超出文件数量限制的 ZIP')
  let cursor = central, total = 0
  const files = []
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('ZIP 目录损坏')
    const flags = buffer.readUInt16LE(cursor + 8), method = buffer.readUInt16LE(cursor + 10), crc = buffer.readUInt32LE(cursor + 16)
    const compressed = buffer.readUInt32LE(cursor + 20), size = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28), extra = buffer.readUInt16LE(cursor + 30), comment = buffer.readUInt16LE(cursor + 32)
    const mode = buffer.readUInt32LE(cursor + 38) >>> 16, local = buffer.readUInt32LE(cursor + 42)
    if (cursor + 46 + nameLength + extra + comment > end || flags & 1 || buffer.readUInt16LE(cursor + 34)) throw new Error('ZIP 目录损坏或已加密')
    const rawName = buffer.subarray(cursor + 46, cursor + 46 + nameLength)
    const name = new TextDecoder('utf-8', { fatal: true }).decode(rawName)
    cursor += 46 + nameLength + extra + comment
    const kind = mode & 0xf000
    if (kind && kind !== 0x8000 && kind !== 0x4000) throw new Error('Skill 包不能包含符号链接或特殊文件')
    const path = packagePath(name.endsWith('/') ? name.slice(0, -1) : name)
    if (name.endsWith('/')) { if (size || compressed) throw new Error('ZIP 目录数据无效'); continue }
    total += size
    if (size > SKILL_FILE_LIMIT || total > SKILL_PACKAGE_LIMIT || files.length >= SKILL_PACKAGE_FILES) throw new Error('Skill 展开大小或文件数量超限')
    if (local + 30 > central || buffer.readUInt32LE(local) !== 0x04034b50 || buffer.readUInt16LE(local + 6) !== flags || buffer.readUInt16LE(local + 8) !== method) throw new Error('ZIP 文件头损坏')
    const localNameLength = buffer.readUInt16LE(local + 26), start = local + 30 + localNameLength + buffer.readUInt16LE(local + 28)
    if (start + compressed > central || !buffer.subarray(local + 30, local + 30 + localNameLength).equals(rawName)) throw new Error('ZIP 文件内容或路径不一致')
    const input = buffer.subarray(start, start + compressed)
    const output = method === 0 ? input : method === 8 ? await inflate(input, { maxOutputLength: Math.max(1, Math.min(size, SKILL_FILE_LIMIT)) }) : undefined
    if (!output || output.length !== size || packageCrc(output) !== crc) throw new Error('ZIP 压缩方式不支持或文件校验失败')
    files.push({ path, bytes: output })
  }
  if (cursor !== end) throw new Error('ZIP 目录长度不一致')
  return prepareSkillPackage(files)
}
