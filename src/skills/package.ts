/** Common validation for browser directory uploads and ZIP packages. */
export const SKILL_PACKAGE_LIMIT = 32 * 1024 * 1024
export const SKILL_FILE_LIMIT = 8 * 1024 * 1024
export const SKILL_PACKAGE_FILES = 512
export interface SkillPackageFile { path: string; bytes: Uint8Array }
export interface SkillPackage { document: string; files: SkillPackageFile[] }

export function packagePath(path: string): string {
  const normalized = path.normalize('NFC').replace(/\\/g, '/')
  if (!normalized || normalized.length > 500 || /[\u0000-\u001f\u007f:]/u.test(normalized) || normalized.startsWith('/')) throw new Error('Skill 包含无效或绝对路径')
  const parts = normalized.split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/u.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) throw new Error('Skill 包含不安全的文件路径')
  return normalized
}

export function prepareSkillPackage(input: SkillPackageFile[]): SkillPackage {
  if (!input.length || input.length > SKILL_PACKAGE_FILES) throw new Error(`Skill 包应包含 1–${SKILL_PACKAGE_FILES} 个文件`)
  let total = 0
  const seen = new Set<string>()
  const files = input.map(file => {
    const path = packagePath(file.path), key = path.toLowerCase()
    if (seen.has(key)) throw new Error(`Skill 包含重复文件：${path}`)
    seen.add(key)
    total += file.bytes.byteLength
    if (file.bytes.byteLength > SKILL_FILE_LIMIT || total > SKILL_PACKAGE_LIMIT) throw new Error('Skill 文件超过 8 MiB 或展开后的包超过 32 MiB')
    return { path, bytes: file.bytes }
  }).filter(file => !file.path.split('/').some(part => ['__MACOSX', '.DS_Store', '.git', 'node_modules'].includes(part)))
  const documents = files.filter(file => file.path.split('/').at(-1)?.toLowerCase() === 'skill.md')
  const depth = Math.min(...documents.map(file => file.path.split('/').length))
  const roots = documents.filter(file => file.path.split('/').length === depth)
  if (roots.length !== 1) throw new Error(roots.length ? '包含多个 Skill，请分别选择每个 Skill 目录或压缩包导入' : '没有找到 SKILL.md，请选择包含该文件的 Skill 目录或 ZIP')
  const main = roots[0]!
  if (main.bytes.byteLength > 512 * 1024) throw new Error('SKILL.md 超过 512 KiB')
  const prefix = main.path.slice(0, main.path.length - 'SKILL.md'.length)
  const selected = files.filter(file => file.path.startsWith(prefix)).map(file => ({ ...file, path: file === main ? 'SKILL.md' : file.path.slice(prefix.length) }))
  const paths = new Set(selected.map(file => file.path.toLowerCase()))
  for (const file of selected) {
    const parts = file.path.toLowerCase().split('/')
    for (let length = 1; length < parts.length; length++) if (paths.has(parts.slice(0, length).join('/'))) throw new Error('Skill 文件与目录路径冲突')
  }
  return { document: new TextDecoder('utf-8', { fatal: true }).decode(main.bytes), files: selected.filter(file => file.path !== 'SKILL.md') }
}
