/** Per concern: bounded reasoning rounds, with an independent final response. */
export const OBSERVATION_CHECK_ROUNDS = 12
export const OBSERVATION_MODEL_TIMEOUT_MS = 180_000
export const OBSERVATION_TOOL_TIMEOUT_MS = 60_000
export function observationBudget(round: number) {
  return { checking: round < OBSERVATION_CHECK_ROUNDS }
}

export const observationFinalInstruction = '检查阶段已结束。只基于已完整返回的证据输出约定 JSON，不调用工具，不补造证据。必要步骤未完成的关注必须标记 blocked，并说明未完成步骤；已核实的关注可正常返回。未成功写入记录不得声称已记录。'
