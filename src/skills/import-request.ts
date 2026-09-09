import { SKILL_FILE_LIMIT, SKILL_PACKAGE_FILES, SKILL_PACKAGE_LIMIT, type SkillPackageFile } from './package.js'

export function decodeSkillImport(body: Record<string, unknown>): Uint8Array | SkillPackageFile[] {
  const decode = (value: unknown, limit: number): Buffer => {
    if (typeof value !== 'string' || value.length > Math.ceil(limit / 3) * 4 || value.length % 4 || /[^A-Za-z0-9+/=]/u.test(value)) throw new Error('Skill 文件编码无效或大小超限')
    const bytes = Buffer.from(value, 'base64')
    if (bytes.length > limit || bytes.toString('base64') !== value) throw new Error('Skill 文件大小超限或编码无效')
    return bytes
  }
  if (body.kind === 'zip') return decode(body.data, SKILL_PACKAGE_LIMIT)
  if (body.kind !== 'directory' || !Array.isArray(body.files) || body.files.length > SKILL_PACKAGE_FILES) throw new Error('请选择 ZIP 压缩包或 Skill 目录')
  let total = 0
  return body.files.map(file => {
    if (!file || typeof file !== 'object' || typeof file.path !== 'string') throw new Error('Skill 文件路径无效')
    const bytes = decode(file.data, SKILL_FILE_LIMIT)
    total += bytes.length
    if (total > SKILL_PACKAGE_LIMIT) throw new Error('Skill 目录超过 32 MiB')
    return { path: file.path, bytes }
  })
}
