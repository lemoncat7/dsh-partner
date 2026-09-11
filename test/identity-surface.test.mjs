import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('identity owns its card and controls without changing host form styles', async () => {
  const css = await readFile(new URL('../src/ui/identity-editor.css', import.meta.url), 'utf8')
  const source = await readFile(new URL('../src/ui/identity-editor.tsx', import.meta.url), 'utf8')
  const client = await readFile(new URL('../src/client.tsx', import.meta.url), 'utf8')
  assert.match(source, /id="dsh-partner-identity-editor"/)
  assert.match(source, /className="dsh-partner-identity-card"/)
  assert.match(css, /background: var\(--partner-card-surface\)/)
  assert.match(css, /#dsh-partner-identity-editor .*:focus/)
  assert.match(client, /\$\{identityCssText\}/)
  assert.doesNotMatch(css, /backdrop-filter|!important/)
})
