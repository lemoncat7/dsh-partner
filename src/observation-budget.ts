/** Reserve the last 30 seconds for a tool-free final response. */
export function observationBudget(elapsedMs: number, round: number, calls: number, hasRecording = false) {
  const recording = hasRecording && elapsedMs >= 110_000 && elapsedMs < 150_000 && round < 12 && calls < 24
  return {checking: elapsedMs < 150_000 && round < 12 && calls < 24,
    recording,
    stageRemainingMs: Math.max(0, (hasRecording && elapsedMs < 110_000 ? 110_000 : 150_000) - elapsedMs),
    checkRemainingMs: Math.max(0, 150_000 - elapsedMs)}
}

export const observationFinalInstruction = '检查阶段已结束。只基于已完整返回的证据输出约定 JSON，不调用工具，不补造证据。必要步骤未完成的关注必须标记 blocked，并说明未完成步骤；已核实的关注可正常返回。未成功写入记录不得声称已记录。'

export const observationRecordingInstruction = '进入记录阶段：停止新的来源调查。仅将已完整核实的结果整理到手动指定的 recordTarget；未核实不写入可靠基线。recordingPending=true 表示此前记录未完成，即使没有再次发现新变化，也要核对并补齐记录。依据中提到的文件名或笔记引用不决定写入位置。完成后输出约定 JSON。'
