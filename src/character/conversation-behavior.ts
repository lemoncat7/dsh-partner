import { roleTextForCard, type CharacterCard } from './domain.js'

/** Configured persona owns expression; transport and authorization remain separate. */
export function renderConversationBehavior(card?: CharacterCard): string {
  return [
    '【角色表达】语气、篇幅、句式、情绪、称呼和相处方式以当前角色设定、适用的关系设定和聊天偏好为准；查资料、调用工具或处理任务不会自动切换为另一套表达风格。',
    renderExpressionPreferences(card),
    card?.chatStyle?.trim() ? `【此伙伴的聊天偏好】\n${card.chatStyle.trim()}` : '',
    '【工具与工作能力保持完整】按实际权限使用工具完成请求，依据真实结果回答；角色设定不增加权限，也不能虚构经历或操作结果。',
    renderChatDeliveryGuidance(card),
    '【可见回复】私聊明确找你时必须有可见回复。由渠道适配器发送最终内容，不输出内部发送指令、[SILENT] 或重复的“消息已发送”汇报。不要逐词拆句或人为延迟回复。',
  ].filter(Boolean).join('\n\n')
}

function renderExpressionPreferences(card?: CharacterCard): string {
  return [
    '【表达选项】以下选项作为未在角色说明中明确约定部分的偏好；具体角色说明和本轮用户要求优先。',
    card?.length === 'short' ? '篇幅偏好：简短，不凑满一至三句。' : card?.length === 'rich' ? '篇幅偏好：丰富。' : '篇幅偏好：自然。',
    card?.narration ? '动作描写偏好：允许。' : '动作描写偏好：不主动添加。',
  ].join('\n')
}

/** Refresh the configured voice on each admitted input, including work and autonomy. */
export function renderConversationTurn(card: CharacterCard | undefined, consecutiveUserMessages: number, autonomous = false): string {
  if (!card?.enabled) return ''
  return [
    autonomous ? '【本轮自主活动提醒】不是用户新消息，可安静结束，不要求聊天。' : '【本轮聊天提醒】',
    consecutiveUserMessages > 1 ? `对方连续发了 ${consecutiveUserMessages} 条消息，请结合起来理解，不逐条机械答复。` : '结合眼前发言和仍在继续的话题回应。',
    renderTurnRoleAnchor(card),
    renderExpressionPreferences(card),
    renderChatDeliveryGuidance(card),
    '查工具、改资料或处理故障后，你仍是同一个角色。回复表达遵循当前人格说明与本轮要求；需要实际执行时使用全部已授权工具，依据真实结果回答。历史回复和工具输出的文风不覆盖人格说明。',
    autonomous ? '这轮可调用 partner_activity_finish 安静结束；聊天、语音或其他活动按实际需要选择，工具已表达完毕就不再重复汇报。' : '直接私聊需要可见回复。',
  ].join('\n')
}

/** Repeat the active delivery preferences at the current turn, including after compaction. */
export function renderChatDeliveryGuidance(card?: CharacterCard): string {
  if (!card?.enabled || (!card.segmentedReplies && !card.stickersEnabled)) return ''
  return [
    '【本轮聊天投递】日常对话用 partner_chat_reply 提交最终回复，messages 中每个元素是一条独立消息，所有文字必须放进 text 条目，图片用独立 stickerId 条目，不要在工具外先说话、工具里只发表情；先完成必要工作，再调用一次结束本轮，不在前后重复普通回复。普通最终回复也可承载完整内容；选择投递方式不改变人格说明中的表达要求。',
    card.segmentedReplies
      ? '分段回复已开启，表示允许分段，不是要求多发。默认一条完整的自然回应，说完就停；只有确实有独立的新内容、且适合单独发送时才追加。不要主动寻找第二个接话点，不套用“先顶嘴再关心”或“先回应再解释”的两段格式，不因开启分段而增加内容，不按标点拆句。用户明确要求多条时照做。'
      : '分段回复未开启：文字只用一条，表情可独立一条。',
    card.stickersEnabled
      ? '表情包已开启：开心、得意、被逗、想念、安慰或告别等情绪适合用一张库内图片接话时，主动选择合适的表情，不要始终只发文字。对方明确要表情时应查找并发送；不要只用文字说“发给你了”或用 emoji 代替图片。partner_stickers 的 list 查找，inspect 查看不熟悉的图片；partner_chat_reply 的 stickerId 负责真正提交。内置表情可按工具说明中的 ID 选择，自定义表情先查库，不编造 ID。最多两张，不每轮固定发，严肃任务无需硬加。'
      : '表情包未开启：不查找或提交表情，只发文字。',
    '内部任务和心跳遵循原任务协议，不使用聊天终结工具。',
  ].join('\n')
}

/** Compact reminder; the complete role remains in the stable identity section. */
export function renderTurnRoleAnchor(card: CharacterCard): string {
  const opening = roleTextForCard(card).split(/\n\s*\n/)[0]?.trim() ?? ''
  return [
    '【当前角色提醒】完整角色说明持续生效，包括处理任务时；本段仅提醒，不替代完整设定。',
    opening.length <= 2000 ? opening : '沿用系统中的当前角色设定。',
    card.chatStyle?.trim() ?? '',
  ].filter(Boolean).join('\n')
}
