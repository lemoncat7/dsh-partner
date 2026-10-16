/** Per concern: bounded reasoning rounds, with an independent final response. */
export const OBSERVATION_CHECK_ROUNDS = 12
export const OBSERVATION_PREPARATION_ROUNDS = 8
export const OBSERVATION_MODEL_TIMEOUT_MS = 180_000
export const OBSERVATION_TOOL_TIMEOUT_MS = 60_000
export function observationBudget(round: number, preparationRounds = 0) {
  const preparation = Math.max(0, Math.min(OBSERVATION_PREPARATION_ROUNDS, preparationRounds))
  return { checking: round - preparation < OBSERVATION_CHECK_ROUNDS && round < OBSERVATION_CHECK_ROUNDS + OBSERVATION_PREPARATION_ROUNDS }
}

export const observationFinalInstruction = '检查阶段已结束。只基于已完整返回的证据输出约定 JSON，不调用工具，不补造证据。每项 observations 可用 workflowChecks 数组一次登记已规划的检查步骤，每项为 {stepId,status:"completed"|"blocked",evidence}；已经核实但未调用 update 登记的步骤在此提交即可，不应仅因少一次登记调用判为受阻。必要核验未实际完成的关注仍须标记 blocked；execute 阶段尚未执行不是检查受阻。未成功写入记录不得声称已记录。'
