import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(path, import.meta.url), 'utf8')
const [entry, controller, shared, skills, board, schedules, companionCreate, workspaceStyles, responsiveStyles] = await Promise.all([
  read('../src/client.tsx'),
  read('../src/client-controller.tsx'),
  read('../src/ui/workspace-components.tsx'),
  read('../src/ui/skills-panel.tsx'),
  read('../src/ui/task-board-panel.tsx'),
  read('../src/ui/schedule-panel.tsx'),
  read('../src/ui/companion-create.tsx'),
  read('../src/ui/workspace-ui.css'),
  read('../src/ui/responsive-ui.css'),
])

test('client composition root delegates session orchestration to one controller', () => {
  assert.match(entry, /createPartnerController/)
  assert.doesNotMatch(entry, /function waitForClientSession/)
  assert.doesNotMatch(entry, /ctx\.sessions as unknown as ISessions/)
  assert.match(controller, /function waitForClientSession/)
  assert.match(controller, /async openSession/)
  assert.match(controller, /async renewSession/)
})

test('dropdowns and installed Skill disclosure follow the shared workspace contract', () => {
  assert.match(workspaceStyles, /\.dsh-partner-workspace select:not\(\[multiple\]\)/)
  assert.match(workspaceStyles, /appearance: none/)
  assert.match(workspaceStyles, /background-image: linear-gradient/)
  const market = skills.slice(skills.indexOf('export function SkillsPanel'), skills.indexOf('export function CompanionSkillSettings'))
  assert.match(market, /catalog\.installed\.slice\(0, 4\)/)
  assert.match(market, /visibleInstalled\.map/)
  assert.match(market, /aria-expanded=\{showAllInstalled\}/)
})

test('Skill searches share one accessible command field with result and clear states', () => {
  assert.match(skills, /function SkillSearch/)
  assert.match(skills, /IconSearchOutline16/)
  assert.match(skills, /aria-label="清空搜索"/)
  assert.match(skills, /aria-live="polite"/)
  assert.match(skills, /event\.key === 'Escape'/)
  assert.equal((skills.match(/<SkillSearch /g) ?? []).length, 2)
})

test('new companions start empty and creation is exposed as an explicit capability', () => {
  assert.match(entry, /draft, capabilities: \[\]/)
  assert.match(entry, /id: 'companions', title: '创建伙伴'/)
})

test('global feature pages share one template and one create-dialog contract', () => {
  for (const source of [skills, board, schedules]) {
    assert.match(source, /<WorkspaceHero/)
    assert.match(source, /<WorkspaceDialog/)
    assert.match(source, /<WorkspaceNotice/)
  }
  assert.match(shared, /<dialog[^>]*open/)
  assert.doesNotMatch(shared, /<dialog[^>]*role="dialog"/)
  assert.match(shared, /aria-modal="true"/)
  assert.match(shared, /event\.key === 'Escape'/)
  assert.match(shared, /event\.key !== 'Tab'/)
})

test('creation flows expose bounded pending and inline error states without browser dialogs', () => {
  for (const source of [entry, skills, board, schedules, companionCreate]) assert.doesNotMatch(source, /window\.(alert|confirm|prompt)\(/)
  for (const source of [skills, board, schedules, companionCreate]) {
    assert.match(source, /aria-busy=/)
    assert.match(source, /disabled=\{busy/)
  }
})

test('mobile workspace preserves companion navigation and touch-safe controls', () => {
  assert.match(entry, /function MobileWorkspaceControls/)
  assert.match(entry, /aria-label="切换当前伙伴"/)
  assert.match(entry, /aria-label="新建伙伴"/)
  assert.match(responsiveStyles, /@media \(max-width: 760px\)/)
  assert.match(responsiveStyles, /max-height: 100dvh/)
  assert.match(responsiveStyles, /min-height: 44px/)
  assert.match(responsiveStyles, /font-size: 16px/)
  assert.match(responsiveStyles, /env\(safe-area-inset-bottom\)/)
  assert.match(responsiveStyles, /\.dsh-partner-skill-picker-list \{[^}]*grid-template-columns: 1fr;/)
  assert.match(responsiveStyles, /\.dsh-partner-board-tools \{ grid-template-columns: 1fr; \}/)
  assert.match(responsiveStyles, /\.dsh-partner-schedule-list > article \{[\s\S]*grid-template-columns: minmax\(0, 1fr\) 44px;/)
})
