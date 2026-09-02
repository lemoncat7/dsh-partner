import { inflateRawSync } from 'node:zlib'

/** Reads only the shallowest SKILL.md from an archive; no archive path is written to disk. */
export function extractSkillMarkdown(bytes: Uint8Array, limit: number): string {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocd = findSignature(buffer, 0x06054b50, Math.max(0, buffer.length - 65_557))
  if (eocd < 0) throw new Error('Skill package is not a valid ZIP archive')
  const entries = buffer.readUInt16LE(eocd + 10); let offset = buffer.readUInt32LE(eocd + 16)
  const candidates: Array<{ name: string; method: number; compressed: number; size: number; localOffset: number }> = []
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('Skill ZIP directory is invalid')
    const method = buffer.readUInt16LE(offset + 10); const compressed = buffer.readUInt32LE(offset + 20); const size = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28); const extraLength = buffer.readUInt16LE(offset + 30); const commentLength = buffer.readUInt16LE(offset + 32)
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8').replace(/\\/g, '/')
    if ((name === 'SKILL.md' || name.endsWith('/SKILL.md')) && !name.split('/').includes('..')) candidates.push({ name, method, compressed, size, localOffset: buffer.readUInt32LE(offset + 42) })
    offset += 46 + nameLength + extraLength + commentLength
  }
  const entry = candidates.sort((a, b) => a.name.split('/').length - b.name.split('/').length || a.name.localeCompare(b.name))[0]
  if (!entry) throw new Error('Skill package does not contain SKILL.md')
  if (entry.size > limit) throw new Error('SKILL.md exceeds the size limit')
  const local = entry.localOffset
  if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) throw new Error('Skill ZIP entry is invalid')
  const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28)
  const compressed = buffer.subarray(start, start + entry.compressed)
  if (compressed.length !== entry.compressed) throw new Error('Skill ZIP entry is truncated')
  const output = entry.method === 0 ? compressed : entry.method === 8 ? inflateRawSync(compressed, { maxOutputLength: limit }) : undefined
  if (!output) throw new Error(`Unsupported Skill ZIP compression method ${entry.method}`)
  if (output.length !== entry.size || output.length > limit) throw new Error('Skill ZIP entry size is invalid')
  return output.toString('utf8')
}

function findSignature(buffer: Buffer, signature: number, start: number): number { for (let offset = buffer.length - 22; offset >= start; offset -= 1) if (buffer.readUInt32LE(offset) === signature) return offset; return -1 }
