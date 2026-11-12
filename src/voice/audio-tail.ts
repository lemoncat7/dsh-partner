/** Preserve generated PCM samples and leave a half-second release at the end.
 * Leave at least 250ms after audible samples even when QQ rounds duration to seconds.
 * Compressed/unknown WAV layouts and user-supplied files are not rewritten.
 */
export function withSpeechTail(bytes: Buffer, maxBytes: number): Buffer {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) + 8 !== bytes.length) return bytes
  let fmt = -1, data = -1, size = 0
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const length = bytes.readUInt32LE(offset + 4), end = offset + 8 + length + length % 2
    if (end > bytes.length) return bytes
    const tag = bytes.toString('ascii', offset, offset + 4)
    if (tag === 'fmt ') { if (fmt !== -1 || length < 16) return bytes; fmt = offset + 8 }
    if (tag === 'data') { if (data !== -1) return bytes; data = offset + 8; size = length }
    offset = end
  }
  if (fmt < 0 || data < 0 || !size) return bytes
  const format = bytes.readUInt16LE(fmt), channels = bytes.readUInt16LE(fmt + 2), rate = bytes.readUInt32LE(fmt + 4)
  const align = bytes.readUInt16LE(fmt + 12), bits = bytes.readUInt16LE(fmt + 14), width = bits / 8
  if (format !== 1 || ![8, 16, 24, 32].includes(bits) || channels < 1 || channels > 32 || rate < 8000 || rate > 192000 || align !== channels * width || size % align || bytes.readUInt32LE(fmt + 8) !== rate * align) return bytes
  const releaseFrames = Math.ceil(rate * 0.5), frames = size / align
  const threshold = 2 ** (bits - 1) * 0.001 // -60 dBFS; retain every original sample, including quieter ones.
  let quietFrames = 0
  for (let frame = frames - 1; frame >= Math.max(0, frames - releaseFrames); frame--) {
    let quiet = true
    for (let ch = 0; ch < channels; ch++) {
      const offset = data + frame * align + ch * width
      const sample = bits === 8 ? bytes[offset]! - 128 : bytes.readIntLE(offset, width)
      if (Math.abs(sample) > threshold) { quiet = false; break }
    }
    if (!quiet) break
    quietFrames++
  }
  const voicedFrames = frames - quietFrames
  // QQ's bridge rounds source duration. Crossing the half-second boundary keeps
  // that advertised duration at least 250ms beyond the final audible sample.
  const roundedSeconds = Math.ceil(voicedFrames / rate + 0.25)
  const targetFrames = Math.max(voicedFrames + releaseFrames, Math.ceil((roundedSeconds - 0.5) * rate) + 1)
  if (targetFrames <= frames) return bytes
  const extra = (targetFrames - frames) * align, nextSize = size + extra
  const oldEnd = data + size + size % 2
  const total = bytes.length + extra + nextSize % 2 - size % 2
  if (total > maxBytes || total - 8 > 0xffffffff) return bytes
  const result = Buffer.concat([
    bytes.subarray(0, data + size),
    Buffer.alloc(extra, bits === 8 ? 128 : 0),
    Buffer.alloc(nextSize % 2),
    bytes.subarray(oldEnd),
  ])
  result.writeUInt32LE(result.length - 8, 4)
  result.writeUInt32LE(nextSize, data - 4)
  return result
}
