import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model'
import type { Companion } from '../domain.js'

export function renderPartnerPersona(companion: Companion, surface: 'conversation' | 'heartbeat' | 'ephemeral' = 'conversation'): string {
  const capabilities = companion.capabilities.length > 0 ? companion.capabilities.join('、') : '由当前 Agent Preset 提供的基础能力'
  return [
    `你当前以长期工作伙伴「${companion.name}」的身份工作。`,
    `角色：${companion.role}`,
    companion.description ? `定位：${companion.description}` : '',
    companion.instructions ? `长期行为准则：\n${companion.instructions}` : '',
    `用户为此伙伴启用的能力范围：${capabilities}。能力标识不等于授权；只能调用当前会话实际提供且已经通过权限校验的工具。`,
    surface === 'heartbeat'
      ? '这是一轮独立的伙伴心跳，不是用户聊天的延续。只根据本轮真实可读信息行动，最终结果由渠道适配器决定是否发送。'
      : surface === 'ephemeral'
        ? '这是一个有明确边界的临时工作会话。只处理本轮任务，使用真实工具结果，完成后给出可审计的结果摘要；不得读取或推断其他伙伴的私有会话、凭据与长期记忆。'
        : '这个会话由 DSH 网页与微信私聊渠道共同使用。保持同一上下文，不要假定每条消息都来自微信；渠道回传由适配器负责。回答兼顾网页与移动端阅读，执行外部操作前继续遵守工具自身的授权与审批边界。',
  ].filter(Boolean).join('\n\n')
}

export function renderToolProtocol(): string {
  return [
    'DSH 工具调用协议（必须遵守）：工具 SDK 中出现某项能力，不代表它可以作为顶层函数直接调用。',
    '先以当前请求真正暴露的顶层工具清单为准。若顶层只提供 `run_code`，则它是唯一允许直接调用的工具；`web_search`、知识库、SSH 等 SDK 能力必须放进 `run_code` 程序，通过生成的 `tools` SDK 按准确签名调用，例如 `await tools.web_search(...)`。绝不要直接发起名为 `web_search` 的顶层工具调用。',
    '`run_code` 的程序只返回完成当前任务所需的精简结果。需要顺序依赖时逐个 `await`，互不依赖的只读调用才可并行。',
    '若工具结果提示 “only `run_code` is callable directly”，立即在同一轮改用 `run_code` 重试。只有规范重试也失败时，才说明真正的失败原因。',
    '若当前请求原生暴露了目标工具，则可以直接调用；不要臆造未出现在顶层清单或生成 SDK 中的工具。',
    '需要交付图片或文档时，最终回复必须用 Markdown 链接明确引用伙伴工作目录中的真实文件。',
  ].join('\n')
}

export function assistantTextAfter(agent: Agent, fromSeq: number): string {
  const messages: string[] = []
  for (const event of agent.session.events) {
    if (event.seq < fromSeq || event.type !== 'assistant/message' || event.data.interrupted) continue
    const text = event.data.message.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map(block => block.text.trim()).filter(Boolean).join('\n')
    if (text) messages.push(text)
  }
  return messages.join('\n\n').trim()
}

export function resolvePartnerAgentOptions(defaultModel: AgentDefaultModelConfig, companion: Companion) {
  return {
    ...defaultModel.currentSelection(),
    ...(companion.provider ? { provider: companion.provider } : {}),
    ...(companion.model ? { model: companion.model } : {}),
  }
}
