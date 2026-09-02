import { inflateRawSync } from 'node:zlib'

interface MarkdownEntry { name: string; method: number; compressed: number; size: number; localOffset: number }

/** Reads one deterministic Skill Markdown entry from an archive; no archive path is written to disk. */
export function extractSkillMarkdown(bytes: Uint8Array, limit: number): string {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocd = findSignature(buffer, 0x06054b50, Math.max(0, buffer.length - 65_557))
  if (eocd < 0) throw new Error('Skill package is not a valid ZIP archive')
  const entries = buffer.readUInt16LE(eocd + 10); let offset = buffer.readUInt32LE(eocd + 16)
  const markdownEntries: MarkdownEntry[] = []
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('Skill ZIP directory is invalid')
    const method = buffer.readUInt16LE(offset + 10); const compressed = buffer.readUInt32LE(offset + 20); const size = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28); const extraLength = buffer.readUInt16LE(offset + 30); const commentLength = buffer.readUInt16LE(offset + 32)
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8').replace(/\\/g, '/')
    if (/\.md$/iu.test(name) && safeArchivePath(name)) markdownEntries.push({ name, method, compressed, size, localOffset: buffer.readUInt32LE(offset + 42) })
    offset += 46 + nameLength + extraLength + commentLength
  }
  const exact = markdownEntries.filter(entry => basename(entry.name).toLocaleLowerCase() === 'skill.md')
  const entry = shallowest(exact) ?? (markdownEntries.length === 1 ? markdownEntries[0] : undefined)
  if (!entry) {
    if (markdownEntries.length === 0) throw new Error('Skill package does not contain a Markdown skill document')
    throw new Error('Skill package contains multiple Markdown files but no identifiable SKILL.md')
  }
  if (entry.size > limit) throw new Error('Skill Markdown exceeds the size limit')
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

function safeArchivePath(name: string): boolean {
  const parts = name.split('/')
  return !name.startsWith('/') && !parts.includes('..') && !parts.includes('__MACOSX')
}
function basename(name: string): string { return name.slice(name.lastIndexOf('/') + 1) }
function shallowest(entries: MarkdownEntry[]): MarkdownEntry | undefined {
  return [...entries].sort((left, right) => left.name.split('/').length - right.name.split('/').length || left.name.localeCompare(right.name))[0]
}
function findSignature(buffer: Buffer, signature: number, start: number): number { for (let offset = buffer.length - 22; offset >= start; offset -= 1) if (buffer.readUInt32LE(offset) === signature) return offset; return -1 }
