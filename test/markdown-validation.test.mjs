import test from 'node:test'
import assert from 'node:assert/strict'
import { requiredMarkdown, requiredText } from '../lib/core/validation.js'
import { parseTaskExecutionOutput } from '../lib/tasks/result.js'

test('Markdown validation preserves structure, indentation and hard breaks', () => {
  const text = '    code\n\n## 标题\n\n- 列表  \n  下一行\n'
  assert.equal(requiredMarkdown(text, 'summary', 12000), text)
  assert.equal(requiredMarkdown(text.replaceAll('\n', '\r\n'), 'summary', 12000), text)
  assert.equal(requiredText('单行\n 标题', 'title', 200), '单行 标题')
  for (const value of [undefined, 2, '', ' \n\t']) assert.throws(() => requiredMarkdown(value, 'summary', 12000))
  assert.throws(() => requiredMarkdown('a'.repeat(12001), 'summary', 12000), /too long/)
})

test('tagged summaries are not flattened or truncated', () => {
  const summary = '## 总结\n\n- 第一项\n  - 子项\n\n' + '详细结论。'.repeat(120)
  const parsed = parseTaskExecutionOutput(`<partner-summary>${summary}</partner-summary><partner-deliverable>完整交付</partner-deliverable>`)
  assert.equal(parsed.summary, summary)
})
