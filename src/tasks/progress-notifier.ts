import type { BoardTask } from './domain.js'

/** Channel results and internal follow-ups have independent failure boundaries. */
export function createTaskProgressNotifier(
  deliver: (task: BoardTask) => Promise<void>,
  followup: (task: BoardTask, previousStatus: BoardTask['status']) => Promise<void>,
  warn: (message: string) => void,
): (task: BoardTask, previousStatus: BoardTask['status']) => Promise<void> {
  return async (task, previousStatus) => {
    // The result is already persisted. Do not delay it behind agent creation,
    // model work, or a knowledge extraction triggered by an internal follow-up.
    try { await deliver(task) }
    catch (error) { warn(`dsh-partner task result delivery failed: ${error instanceof Error ? error.message : String(error)}`) }
    try { await followup(task, previousStatus) }
    catch (error) { warn(`dsh-partner task progress notification failed: ${error instanceof Error ? error.message : String(error)}`) }
  }
}
