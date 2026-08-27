import type { ToolSchema } from '@deepseek-ai/dsh-llm'

export interface HeartbeatContext {
  tools: ToolSchema[]
}

export function renderHeartbeatContext(context: HeartbeatContext): string {
  return renderTools(context.tools)
}

export function heartbeatPrompt(): string {
  return [
    '执行一次伙伴主动巡察。不要等待固定任务，主动找一件现在值得做的小事，并根据结果判断是否需要通知用户。',
    '把本轮当作一次有边界的小型巡察：先用发现工具广泛寻找候选线索，再从中选择最多三条真正有价值的方向继续检索或核实。方向可以来自关注变化、学习新知和整理现状，不必固定只做一类，也不要为了凑数机械跑满三类。',
    '工具调用应按调查需要连续展开，不限制为一次。通常先发现、再检索、必要时继续读取或交叉核实；总计最多调用六次工具，并在大约两分钟内收束。除非首次发现已经明确没有任何可查线索，否则不得只调用一次工具就结束。',
    '必须实际调用只读发现或检索工具后再作出判断，不允许未经检查直接回复 NO_ACTION。优先从当前挂载知识库开始；知识库没有合适线索时，再使用网页搜索、状态查询或其他只读工具。',
    '巡察只允许发现、读取、核实和分析，不得创建、修改、删除内容，不得执行具有副作用的命令或操作。',
    '只有工具结果中出现可靠、实际有用且值得打扰用户的信息时才主动报告；不得为了活跃而寒暄，不得虚构进展，不得把普通搜索结果包装成重要发现。',
    '如果没有必要通知，只回复：NO_ACTION',
    '如果需要通知，只输出准备发送给用户的简短中文消息，不要解释这是心跳，也不要输出 JSON、决策过程或内部控制字段。',
  ].join('\n')
}

export function heartbeatMessage(raw: string): string | undefined {
  const text = raw.trim()
  return !text || /^NO_ACTION[。.!！]?$/i.test(text) ? undefined : text
}

function renderTools(tools: ToolSchema[]): string {
  if (tools.length === 0) return '本轮没有可用工具。不要声称已经查询、读取或核实外部状态。'
  return [
    '以下是系统按当前伙伴 Agent 作用域解析出的真实可用工具。工具能力已随本轮上下文明确注入；只能使用这里列出的名称，并继续遵守系统中的 native / run_code 调用协议。',
    ...tools.map(tool => `- ${tool.name}：${compact(tool.description, 240) || '无补充说明'}`),
  ].join('\n')
}

function compact(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}
