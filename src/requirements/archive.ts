import type { BoardRequirement } from './domain.js'

/** Keep actual archived evidence, without unbounded growth or silent history eviction. */
export function retainRequirementArchive(target: BoardRequirement, archived: BoardRequirement): void {
  if (archived.status !== 'done' || !archived.archivedAt) throw new Error('只能保留已完成归档的需求')
  const history = [...(target.archiveHistory ?? []), ...(target === archived ? [] : archived.archiveHistory ?? [])]
  if (history.length >= 20) throw new Error('需求已有 20 次历史归档，请创建独立后续需求，不自动删除历史成果')
  history.push({ requirementId: archived.id, title: archived.title, description: archived.description, revision: archived.revision,
    archivedAt: archived.archivedAt, ...(archived.summary ? { summary: archived.summary } : {}),
    ...(archived.results ? { results: structuredClone(archived.results) } : {}),
    ...(archived.notifiedAt ? { notifiedAt: archived.notifiedAt } : {}) })
  target.archiveHistory = history
}
