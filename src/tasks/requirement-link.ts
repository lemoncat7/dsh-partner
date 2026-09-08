import type { BoardTask } from './domain.js'
import { optionalText } from '../core/validation.js'

/** Dependency links describe execution order, not ownership. Never silently guess a requirement. */
export function requireTaskRequirement(value: unknown, dependencyIds: readonly string[], tasks: readonly BoardTask[]): string {
  const id = optionalText(value, 'requirementId', 160)
  if (id) return id
  const dependencies = new Set(dependencyIds)
  const candidates = [...new Set(tasks.filter(t => dependencies.has(t.id)).map(t => t.requirementId).filter(Boolean))]
  throw new Error(`创建任务必须提供 requirementId，未创建任何任务或需求。先查询 partner_requirements list；续做同一目标请复用原需求，必要时 reopen 后追加，只有新的独立目标才 create 需求。dependencyTaskIds 不能替代 requirementId。${candidates.length ? `所选前置任务属于：${candidates.join('、')}；请核对归属，不要直接另建需求。` : ''}`)
}
