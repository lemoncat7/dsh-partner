import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** Native append-only surface replacement. The immutable transcript and system head survive. */
export async function renewContext(agent: Agent, day: string, checkpoint: string,
  ready: () => Promise<boolean>, flush: (session: Session) => Promise<unknown>, learning = true): Promise<number> {
  return agent.runMaintenance(async signal => {
    const session = agent.session
    const seq = session.seq
    const messages = session.deriveMessages()
    const marker = `上下文焕新 ${day}`
    if (messages.some(m => m.role === 'user' && m.source.kind === 'plugin:@lemoncat7/dsh-partner' && m.source.form === 'notice' && m.source.summary === marker)) {
      await flush(session)
      return 0
    }
    if (messages[0]?.role !== 'system' || session.surface.nodes.length < 2) return 0
    if (!await ready()) return 0
    signal.throwIfAborted()
    if (session.seq !== seq) throw new Error('准备焕新时上下文发生变化，保留原上下文并稍后重试')
    // Keep node zero even if later system updates are present. Never shadow the protected head.
    const nodes = [...session.surface.nodes].slice(1)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: learning ? `每日终审已完成。当前工作上下文已焕新，历史原文和长期记忆仍可检索。这是系统交接资料，不是用户新请求。遇到过去的细节调用 partner_memory_recall，找不到就说明不确定。\n${checkpoint}` : '当前未启用学习，已按每日计划清空工作上下文以限制占用。原聊天记录仍保留供用户查看，但本次未提炼长期记忆。不要假装记得先前细节；不确定时说明并向用户核实。这不是用户新请求。' }],
      source: { kind: 'plugin:@lemoncat7/dsh-partner', plugin: '@lemoncat7/dsh-partner', form: 'notice', summary: marker },
    }), { surfaceOp: { op: 'replace', startSeq: nodes[0]!, endSeq: nodes.at(-1)! }, sourceEventSeqs: nodes })
    await flush(session)
    return nodes.length
  })
}
