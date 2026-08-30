import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const clientSource = await readFile(new URL('../src/client.tsx', import.meta.url), 'utf8')
const glassSource = await readFile(new URL('../src/glass-surface.tsx', import.meta.url), 'utf8')

test('memory workspace keeps dynamic glass off data-heavy surfaces', () => {
  const memoryPanel = clientSource.slice(clientSource.indexOf('function MemoryPanel('), clientSource.indexOf('function ConcernBoard('))
  const concernBoard = clientSource.slice(clientSource.indexOf('function ConcernBoard('), clientSource.indexOf('function activeMention('))
  const memoryLibrary = clientSource.slice(clientSource.indexOf('function MemoryLibrary('), clientSource.indexOf('function ProfileLibrary('))
  const graphMemory = clientSource.slice(clientSource.indexOf('function GraphMemory('), clientSource.indexOf('function relationLabel('))

  assert.doesNotMatch(memoryPanel, /<GlassSurface/)
  assert.doesNotMatch(concernBoard, /<GlassSurface/)
  assert.doesNotMatch(memoryLibrary, /<GlassSurface/)
  assert.doesNotMatch(graphMemory, /<GlassSurface/)
})

test('memory graph is fetched only by the graph view', () => {
  const memoryPanel = clientSource.slice(clientSource.indexOf('function MemoryPanel('), clientSource.indexOf('function ConcernBoard('))
  const memoryLibrary = clientSource.slice(clientSource.indexOf('function MemoryLibrary('), clientSource.indexOf('function ProfileLibrary('))

  assert.doesNotMatch(memoryPanel, /memory\/graph/)
  assert.match(memoryLibrary, /if \(mode !== 'graph' \|\| graph !== undefined\) return/)
  assert.match(memoryLibrary, /memory\/graph/)
  assert.match(memoryLibrary, /AbortController/)
})

test('glass distortion work runs only when SVG backdrop filters are supported', () => {
  assert.match(glassSource, /useEffect\(\(\) => \{\n    if \(!svgSupported\) return\n    const element = containerRef\.current/)
  assert.match(glassSource, /\{svgSupported && <svg className="dsh-partner-glass-filter"/)
})

test('interactive glare batches layout reads into animation frames', () => {
  const renderGlare = glassSource.slice(glassSource.indexOf('const renderGlare'), glassSource.indexOf('const scheduleGlare'))
  const moveGlare = glassSource.slice(glassSource.indexOf('const moveGlare'), glassSource.indexOf('const resetGlare'))

  assert.match(renderGlare, /getBoundingClientRect/)
  assert.doesNotMatch(moveGlare, /getBoundingClientRect/)
  assert.match(moveGlare, /glarePointerRef\.current = \{ clientX, clientY \}/)
})
