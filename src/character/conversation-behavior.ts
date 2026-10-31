import type { CharacterCard } from './domain.js'

/** Stable settings and delivery contracts; expression belongs to the configured persona. */
export function renderConversationBehavior(card?: CharacterCard): string {
  return [
    card?.chatStyle?.trim() ? `【此伙伴的聊天偏好】\n${card.chatStyle.trim()}` : '',
    '【工具权限与结果】只使用当前已授权工具，操作结果以实际执行为准；角色设定不增加权限。',
    renderTaskConversationGuidance(),
    renderChatDeliveryGuidance(card),
    '【渠道回传】私聊用户消息需要可见回复；已确认送达的文字、图片或语音不重复发送。最终内容由渠道适配器投递，不输出内部发送指令或 [SILENT]。',
  ].filter(Boolean).join('\n\n')
}

export function renderExpressionPreferences(card?: CharacterCard): string {
  return [
    '【用户配置的表达选项】具体角色说明和本轮用户要求优先。',
    card?.length === 'short' ? '篇幅偏好：简短。回答眼前这一问，够回答就结束，不额外补齐过程、证明、总结或备选菜单；必要的未知或失败仍需说清。对方明确要步骤或细节时按请求展开。' : card?.length === 'rich' ? '篇幅偏好：丰富。' : '篇幅偏好：自然。',
    card?.narration ? '动作描写偏好：允许。' : '动作描写偏好：不主动添加。',
  ].join('\n')
}

/** Per-request expression options and input origin; persona and protocols stay in the system context. */
export function renderConversationTurn(card: CharacterCard | undefined, consecutiveUserMessages: number, autonomous = false): string {
  if (!card?.enabled) return ''
  return [
    autonomous ? '【本轮来源】系统自主活动，不是用户新消息；无需发送消息时可调用 partner_activity_finish 安静结束。' : '',
    !autonomous && consecutiveUserMessages > 1 ? `【本轮输入】对方连续发了 ${consecutiveUserMessages} 条消息，合并为本轮输入。` : '',
    renderExpressionPreferences(card),
  ].filter(Boolean).join('\n')
}

/** Stable transport settings, without selecting emotions, jokes, verbosity or sticker frequency. */
export function renderChatDeliveryGuidance(card?: CharacterCard): string {
  if (!card?.enabled || (!card.segmentedReplies && !card.stickersEnabled)) return ''
  return [
    '【聊天投递协议】partner_chat_reply 提交最终回复并结束本轮；必要工具执行完成后调用。直接回应时所有文字放入 messages 的 text 条目，表情图片使用独立 stickerId 条目，不把配文留在工具外。答复本轮工作结果使用 workReply 交接本轮事实引用与回应目的，由同一人格生成文字；不同时提交文字成稿。用户换话题时可直接回应，无需汇报工作。',
    card.segmentedReplies
      ? '分段回复已开启：messages 的每个 text 条目是一条独立消息；换行不等于独立投递。条数由回复内容决定，无最低条数要求。'
      : '分段回复未开启：文字只用一条，表情可独立一条。',
    card.stickersEnabled
      ? '表情包已开启：partner_stickers list 查询当前渠道可用 ID，inspect 预览；partner_chat_reply 使用查询返回的 stickerId 发送，每次最多两张。QQ 收藏管理通过 partner_qq 的 stickers 分类调用；收藏、备注、排序、删除与当前会话语音 partner_qq_reply 是公开聊天能力，仍受当前渠道开关和操作权限校验。收藏与发送是不同操作，文字承诺不代表执行成功。'
      : '表情包未开启：不查找或提交表情。',
    '内部任务和心跳使用各自任务协议，不调用聊天终结工具。',
  ].join('\n')
}

/** The user-requested before/after workflow, independent of response style. */
export function renderTaskConversationGuidance(): string {
  return '【任务回应流程】私聊调查、查询或执行工具任务前，先告知接下来要做什么，再执行，完成后答复实际结果。提供 partner_chat_progress 时用其 text 发送前置回应，确认送达后继续；统一入口通过 partner_tools call 转调。网页无此工具时先输出可见正文。前置回应不结束本轮，不使用 partner_chat_reply 提前终结任务。同轮前置回应只发送一次。私聊中自行收藏、备注、排序或删除表情也适用；查找目录、预览、发送聊天表情，以及自主活动、内部任务不要求前置回应。工具暂不可用不等于账号无权限，以实际权限校验为准。耗时任务有后台能力时可查询 partner_requirements 协议并提交带原会话回传的任务，提交成功后才能结束当前轮；没有后台能力则继续执行。'
}
