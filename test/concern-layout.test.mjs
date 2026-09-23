import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'

const source = path => readFile(new URL(`../src/${path}`, import.meta.url), 'utf8')

test('resolved concern actions occupy one grid cell and reflow together on mobile', async () => {
  const board = await source('ui/memory/concern-board.tsx')
  const css = await source('client.css')
  assert.match(board, /className="dsh-partner-concern-resolved-actions" role="group"[^]*?重新留意<\/button><ConcernDeleteButton[^]*?<\/div><\/article>/)
  assert.match(css, /\.dsh-partner-concern-resolved-actions \{ display: flex; flex-wrap: wrap;/)
  assert.match(css, /\.dsh-partner-concern-resolved-actions \{ grid-column: 2; \}/)
  assert.match(board, /<strong title=\{item.subject\}>/)
})

test('stopped concern cleanup keeps historical access without an empty archive entry', async () => {
  const ui = await source('ui/memory/concern-deletion.tsx')
  assert.doesNotMatch(ui, /已归档关注/)
  assert.match(ui, /<strong>已停止关注<\/strong>/)
  assert.match(ui, /offset===0 && resource.data.items.length===0/)
  assert.match(ui, /concerns\/archived\?offset=/)
  assert.match(ui, /setOffset\(offset-50\)/)
})
