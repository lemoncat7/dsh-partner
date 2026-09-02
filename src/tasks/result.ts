import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BoardTask } from './domain.js'

const INLINE_RESULT_LIMIT = 1_800
const SUMMARY_LIMIT = 480
const SUMMARY_TAG = /<partner-summary>\s*([\s\S]*?)\s*<\/partner-summary>/iu
const DELIVERABLE_TAG = /<partner-deliverable>\s*([\s\S]*?)\s*<\/partner-deliverable>/iu
const REVIEW_TAG = /<partner-review-handoff>\s*([\s\S]*?)\s*<\/partner-review-handoff>/iu
const LEGACY_REVIEW_SECTION = /(?:^|\n)#{1,6}\s*(?:需要验收的内容|验收交接|验收说明)\s*\n/iu

export interface TaskExecutionOutput {
  summary?: string
  deliverable: string
  reviewHandoff?: string
}

export interface TaskResultDelivery {
  text: string
  documentPath?: string
}

export function parseTaskExecutionOutput(value: string): TaskExecutionOutput {
  const raw = value.trim()
  const taggedDeliverable = raw.match(DELIVERABLE_TAG)?.[1]?.trim()
  if (taggedDeliverable) {
    const summary = raw.match(SUMMARY_TAG)?.[1]?.trim()
    const reviewHandoff = raw.match(REVIEW_TAG)?.[1]?.trim()
    return {
      ...(summary ? { summary: boundedSummary(summary) } : {}),
      deliverable: taggedDeliverable,
      ...(reviewHandoff ? { reviewHandoff } : {}),
    }
  }
  const legacyReview = LEGACY_REVIEW_SECTION.exec(raw)
  if (!legacyReview || legacyReview.index <= 0) return { deliverable: raw }
  const deliverable = raw.slice(0, legacyReview.index).trim()
  const reviewHandoff = raw.slice(legacyReview.index + legacyReview[0].length).trim()
  return { deliverable: deliverable || raw, ...(reviewHandoff ? { reviewHandoff } : {}) }
}

export function publicTaskDeliverable(value: string): string {
  return parseTaskExecutionOutput(value).deliverable
}

export async function prepareTaskResultDelivery(task: BoardTask, cwd: string): Promise<TaskResultDelivery> {
  const deliverable = task.resultSummary ? publicTaskDeliverable(task.resultSummary) : ''
  const review = task.reviewSummary?.trim() || (task.status === 'done' ? '已通过' : '')
  const direct = renderDirectResult(task, deliverable, review)
  if (direct.length <= INLINE_RESULT_LIMIT) return { text: direct }
  const document = renderResultDocument(task, deliverable, review)
  const documentPath = await writeResultDocument(cwd, task, document)
  const summary = task.resultAbstract?.trim() || summarizeDeliverable(deliverable)
  const reviewSummary = review ? boundedSummary(review) : ''
  return {
    text: [
      task.status === 'done' ? `看板任务已完成：${task.title}` : `看板任务受阻：${task.title}`,
      summary ? `结论：${summary}` : '',
      reviewSummary ? `验收结论：${reviewSummary}` : '',
      `完整交付文档：\`${documentPath}\``,
    ].filter(Boolean).join('\n\n'),
    documentPath,
  }
}

function renderDirectResult(task: BoardTask, deliverable: string, review: string): string {
  if (task.status === 'done') return [
    `看板任务已完成：${task.title}`,
    deliverable ? `执行结果：\n${deliverable}` : '执行结果：未留下结果摘要',
    `验收结论：${review}`,
  ].join('\n\n')
  return [
    `看板任务受阻：${task.title}`,
    deliverable ? `阻塞说明：\n${deliverable}` : '阻塞说明：未留下详细原因',
    '需要你介入后，伙伴才会继续推进。',
  ].join('\n\n')
}

function renderResultDocument(task: BoardTask, deliverable: string, review: string): string {
  const metadata = [
    `- 状态：${task.status === 'done' ? '已完成' : '受阻'}`,
    `- 更新时间：${new Date(task.updatedAt).toISOString()}`,
  ].filter(Boolean).join('\n')
  return [
    `# ${task.title}`,
    '',
    metadata,
    '',
    task.status === 'done' ? '## 执行结果' : '## 阻塞说明',
    '',
    deliverable || '未留下结果摘要。',
    ...(review ? ['', '## 验收结论', '', review] : []),
    '',
  ].join('\n')
}

async function writeResultDocument(cwd: string, task: BoardTask, document: string): Promise<string> {
  const directory = join(cwd, 'task-results')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const filename = `${safeFilePart(task.title)}-${task.id.slice(-8)}.md`
  const target = join(directory, filename)
  const temporary = join(directory, `.${filename}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, `${document.trim()}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
  return target
}

function summarizeDeliverable(value: string): string {
  const first = value.split(/\n\s*\n/u).map(item => item.replace(/^#{1,6}\s*/u, '').replace(/\s+/gu, ' ').trim()).find(Boolean) ?? ''
  return boundedSummary(first)
}

function boundedSummary(value: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  return normalized.length > SUMMARY_LIMIT ? `${normalized.slice(0, SUMMARY_LIMIT - 1)}…` : normalized
}

function safeFilePart(value: string): string {
  const normalized = value.normalize('NFKC').replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '-').replace(/\s+/gu, '-').replace(/-+/gu, '-').replace(/^-|-$/gu, '')
  return normalized.slice(0, 64) || '任务结果'
}
