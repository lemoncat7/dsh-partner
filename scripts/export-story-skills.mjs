import { mkdir, writeFile } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { STORY_BUILTINS } from '../lib/skills/story-builtins.js'
import { loadBuiltinResources } from '../lib/skills/builtin-resources.js'
if (!process.argv[2]) throw new Error('Provide an output directory')
const root = resolve(process.argv[2])
for (const [id, builtin] of STORY_BUILTINS) {
  const dir = join(root, id)
  await mkdir(dir, {recursive: true})
  // Portable export uses standard skill fields; DSH-specific inline metadata
  // remains in the built-in catalog, not in this cross-host archive.
  const portable = builtin.document.replace(/^(display-name|version|context):.*\n/gm, '')
  await writeFile(join(dir, 'SKILL.md'), portable)
  for (const {path, bytes} of await loadBuiltinResources(id)) {
    const target = join(dir, path)
    await mkdir(dirname(target), {recursive: true})
    await writeFile(target, bytes)
  }
  console.log(dir)
}
