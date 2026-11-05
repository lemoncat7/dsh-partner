import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import type { ToolRuntime, ToolExecutionInput, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

/** Nested calls retain the original scope, cancellation and approval pipeline. */
export async function dispatchTool(runtime: ToolRuntime, input: ToolExecutionInput): Promise<ToolExecutionResult> {
  if(typeof runtime.executable!=='function')return (runtime.execute as unknown as (input:ToolExecutionInput)=>Promise<ToolExecutionResult>)(input)
  const ctx = input.agent?.ctx ?? (runtime as unknown as {ctx: import('@deepseek-ai/cordis').Context}).ctx
  if (!ctx) throw new Error('工具调用缺少 Agent 执行作用域')
  const pipeline = new ToolExecutionPipeline(ctx)
  const prepared = await pipeline.prepare(input)
  const outcome = prepared.kind === 'dispatch' ? await pipeline.dispatch(prepared.exec) : prepared
  return pipeline.complete(prepared.exec, outcome)
}
