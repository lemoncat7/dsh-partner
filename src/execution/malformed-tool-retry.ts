import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type LlmFailure } from '@deepseek-ai/dsh-llm'

/** Only malformed model-authored JSON, before any tool in that response was dispatched. */
export function malformedToolName(failure: LlmFailure): string | undefined {
  if (failure.code !== 'MALFORMED_RESPONSE') return
  const match = /^Tool call "([^"\r\n]+)": [^\r\n]+\n\nReceived arguments:\n([\s\S]*)$/u.exec(failure.message)
  if (!match) return
  try { JSON.parse(match[2]!); return } catch { return match[1] }
}

/** Retry the current native request twice, retaining all earlier tool receipts. */
export function installMalformedToolRetry(ctx: Context, owns: (agent: Agent) => boolean): () => void {
  const attempts = new WeakMap<Agent, { turn: number; step: number; count: number }>()
  return ctx.on('agent/request-error', async ({ agent, turn, step, failure, signal }, next) => {
    const tool = malformedToolName(failure)
    if (!tool || signal.aborted || !owns(agent) || agent.inbox.nextStep.some(message => message.source.kind === 'user')) return next()
    let current = attempts.get(agent)
    if (!current || current.turn !== turn || current.step !== step) {
      current = { turn, step, count: 0 }; attempts.set(agent, current)
    }
    if (current.count >= 2) return next()
    current.count++
    // The request loop rebuilds history on retry. A logged correction reaches
    // that same request without re-enqueueing the user's turn or replaying work.
    agent.session.append('user/message', createUserMessage({
      source: { kind: 'plugin:@lemoncat7/dsh-partner', plugin: '@lemoncat7/dsh-partner', form: 'notice', summary: '工具参数格式校正' },
      content: [{ type: 'text', text: `上次模型响应中 ${tool} 的参数不是有效 JSON，该响应未执行工具。只修正当前回复的工具参数并继续：使用标准 JSON、英文逗号和双引号，不把中文逗号写在字段之间；参数须符合当前工具 schema。此前成功的工具回执仍有效，已创建的后台任务、已执行的命令、已确认的发送都不能重做。本提示是内部格式检查，不是用户新发言，不向用户复述。` }],
    }), { surfaceOp: 'append' })
    return { kind: 'retry' }
  })
}
