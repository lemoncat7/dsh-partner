import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const clientSource = await readFile(new URL('../src/client.tsx', import.meta.url), 'utf8')
const glassSource = await readFile(new URL('../src/glass-surface.tsx', import.meta.url), 'utf8')
const skillSource = await readFile(new URL('../src/ui/skills-panel.tsx', import.meta.url), 'utf8')
const scheduleSource = await readFile(new URL('../src/ui/schedule-panel.tsx', import.meta.url), 'utf8')
const boardSource = await readFile(new URL('../src/ui/task-board-panel.tsx', import.meta.url), 'utf8')

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

test('overview cards avoid dynamic glare and per-card SVG observers', () => {
  const homePanel = clientSource.slice(clientSource.indexOf('function HomePanel('), clientSource.indexOf('function IdentityEditor('))

  assert.doesNotMatch(homePanel, /<GlassSurface/)
  assert.match(homePanel, /<section className=\{`dsh-partner-home-channel/)
  assert.match(homePanel, /<section className="dsh-partner-home-profile">/)
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

test('global workspaces stay in the roster while partner Skill bindings stay in capabilities', () => {
  const partnerTabs = clientSource.slice(clientSource.indexOf('<nav className="dsh-partner-tabs"'), clientSource.indexOf('</nav>', clientSource.indexOf('<nav className="dsh-partner-tabs"')))
  assert.match(clientSource, /className="dsh-partner-workspace-nav"/)
  assert.match(clientSource, />Skill 市场</)
  assert.match(clientSource, />任务看板</)
  assert.match(clientSource, />定时任务</)
  assert.doesNotMatch(partnerTabs, />Skill</)
  assert.doesNotMatch(partnerTabs, />看板</)
  assert.doesNotMatch(partnerTabs, />定时</)
  assert.match(clientSource, /<CompanionSkillSettings companionId=\{companion\.id\}/)
  assert.match(skillSource, /集中安装和维护工作能力/)
  assert.match(scheduleSource, /name="companionId" required/)
})

test('companion capabilities keep a four-card Skill overview and disclose selection near the header', () => {
  const settings = skillSource.slice(skillSource.indexOf('export function CompanionSkillSettings'), skillSource.indexOf('function NewSkillForm'))
  assert.match(settings, /enabledSkills\.slice\(0, 4\)/)
  assert.match(settings, /visibleEnabledSkills\.map/)
  assert.doesNotMatch(settings, /catalog\.installed\.map/)
  assert.match(settings, /aria-expanded=\{selecting\}/)
  assert.match(settings, /visibleAvailableSkills\.map/)
  assert.match(settings, /slice\(0, 80\)/)
  assert.ok(settings.indexOf('{selecting &&') < settings.indexOf('visibleEnabledSkills.map'))
})

test('task board refreshes while visible and keeps card details collapsed by default', () => {
  assert.match(boardSource, /LIVE_REFRESH_MS = 4_000/)
  assert.match(boardSource, /document\.visibilityState === 'visible'/)
  assert.match(boardSource, /aria-expanded=\{expanded\}/)
  assert.match(boardSource, /task\.resultSummary/)
  assert.match(boardSource, /dependencyTaskIds/)
  assert.match(boardSource, />依赖任务 <small>可选<\/small>/)
  assert.match(boardSource, /留空表示该任务不依赖其他任务/)
})
