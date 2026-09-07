import { useState, type ReactNode } from 'react'
import { IconChevronRightOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { BoardTaskStatusView, BoardTaskView } from '../client-api.js'

/** Bounded progressive disclosure; a single page scroll, no tiny inner scroll box. */
export function TaskBoardStage({ id, label, tasks, focused, filtered, renderTask }: {
  id: BoardTaskStatusView; label: string; tasks: BoardTaskView[]; focused: boolean; filtered: boolean
  renderTask(task: BoardTaskView): ReactNode
}): JSX.Element {
  const [collapsed, setCollapsed] = useState(false)
  const [limit, setLimit] = useState(6)
  const count = Math.max(limit, focused ? 12 : 6)
  const titleId = `dsh-partner-board-${id}`, listId = `${titleId}-list`
  const expanded = !collapsed
  return <section data-status={id} data-empty={tasks.length === 0} aria-labelledby={titleId}>
    <header><button type="button" className="dsh-partner-board-stage-toggle" aria-expanded={expanded} aria-controls={listId} onClick={() => setCollapsed(value => !value)}>
      <IconChevronRightOutline14 size={14} /><strong id={titleId}>{label}</strong><b>{tasks.length}</b>
    </button></header>
    <div id={listId} hidden={!expanded}>
      {tasks.length > 0 ? <>
        <div className="dsh-partner-board-column-list">{tasks.slice(0, count).map(renderTask)}</div>
        {tasks.length > count && <button type="button" className="dsh-partner-board-more" onClick={() => setLimit(count + 12)}>展开更多 · 还有 {tasks.length - count} 项</button>}
      </> : <p className="dsh-partner-board-empty">{filtered ? '没有匹配任务' : '暂无任务'}</p>}
    </div>
  </section>
}
