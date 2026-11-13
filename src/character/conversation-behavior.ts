import type { CharacterCard } from './domain.js'

export const SEGMENTED_CHAT_GUIDANCE = '短句接话开启分段时，普通聊天每条消息只说半句到两句，只接一个意思；这是每条的长度，不是整轮只能回一句。一次回应可以连续说几条：先接话，再自然补自己的反应、联想或想做的小事；这些属于当前一轮，不需要等待用户追问或挪到自主活动。不靠删标点、换行或连续逗号把原因、评价、感受塞成一条，也不把本可一句说完的意思扩成多条，所有中英文标点符号合计最多一个，不仅限于逗号和句号；问号、感叹号、顿号、冒号、分号、引号、括号、破折号、省略号等都计入，每个标点字符计一个，连续标点逐个计数；内容多时继续分条，允许超过三条消息（单次工具提交最多八条），不为凑条数加话，不把长篇解释拆成很多短消息倾倒。代码、逐字引用、列表、完整文档及用户明确要求的特殊格式保留结构，不套用这项短句限制。语气仍按当前人物与关系设定。'

/** User-selected delivery size is independent of persona composition. */
export function usesShortDeliveryPolicy(card?: CharacterCard): boolean {
  return card?.length === 'short'
}

/** Stable settings and delivery contracts; expression belongs to the configured persona. */
export function renderConversationBehavior(card?: CharacterCard): string {
  return [
    card?.enabled ? '【聊天表达】正文是这个角色正在对眼前的人说的话。按人物设定自然接话，语气可以有停顿、残句和态度；不用把每句话补成完整解答，不复述对方或总结这一轮。需要认真解释时照样说清楚。说话方式由人格和关系决定，不固定语气词、条数或字数，不预设具体情绪。' : '',
    '【工具权限与结果】只使用当前已授权工具，操作结果以实际执行为准；角色设定不增加权限。',
    '【接话与主动性】先回应眼前的话，有自然联想、具体兴趣或还想说的内容时，可以自己接着说、分享或做相关的小事，不必总等对方下一问，也不必用提问结尾。中途用 partner_chat_say 或 partner_chat_reply continueTurn:true，仍保持人物语气和短句节奏；没有新内容就结束，不拆成流水汇报。若明确想稍后继续，可通过 partner_tools 查询 partner_thoughts 的 plan 安排一次后续，先确认自主活动已开启；只说以后再聊不算安排。用户新消息优先，不能用自主活动逃避当前任务。',
    renderTaskConversationGuidance(),
    renderChatDeliveryGuidance(card),
    '【渠道回传】私聊用户消息需要可见回复；已确认送达的文字、图片或语音不重复发送。最终内容由渠道适配器投递，不输出内部发送指令或 [SILENT]。',
  ].filter(Boolean).join('\n\n')
}

export function renderExpressionPreferences(card?: CharacterCard): string {
  return [
    '【用户配置的表达选项】具体角色说明和本轮用户要求优先。',
    card?.segmentedReplies && usesShortDeliveryPolicy(card) ? SEGMENTED_CHAT_GUIDANCE : '',
    card?.length === 'short' ? '篇幅偏好：短句接话。每条简短，整轮可连续多条；有自己的反应或联想就顺着接下去，不把一次聊天压成一条答案。已想好几条时一次放入 messages，想边说边继续时先用 partner_chat_say 或 continueTurn:true，最后再收尾。不为凑条数延长，也不为字数省掉事实。本轮要求详细或原文时按请求展开，具体语气由角色决定。' : card?.length === 'rich' ? '篇幅偏好：愿意展开聊，随话题和对方意愿。' : '篇幅偏好：随话题自然调整。',
    card?.narration ? '动作描写偏好：允许。' : '动作描写偏好：不主动添加。',
  ].join('\n')
}

/** Per-request expression options and input origin; persona and protocols stay in the system context. */
export function renderConversationTurn(card: CharacterCard | undefined, consecutiveUserMessages: number, autonomous = false): string {
  if (!card?.enabled) return ''
  return [
    autonomous ? '【本轮来源】系统自主活动，不是用户新消息；无需发送消息时可调用 partner_activity_finish 安静结束。' : '',
    !autonomous && consecutiveUserMessages > 1 ? `【本轮输入】对方连续发了 ${consecutiveUserMessages} 条消息，合并为本轮输入。` : '',
    card.exclusivePrompt?'':renderExpressionPreferences(card),
    card.exclusivePrompt&&card.segmentedReplies?'【用户选择的消息分段】messages 中每个 text 条目是一条消息；换行不等于分条。想先接一句再继续说时，用 partner_chat_say 或 continueTurn:true；已经想好的几条可一次放入 messages。新消息优先，不重复已送达内容。'+(usesShortDeliveryPolicy(card)?SEGMENTED_CHAT_GUIDANCE:'条数随内容决定，不凑条数。'):'',
    card.exclusivePrompt?renderVoicePreference(card):'',
    card.exclusivePrompt?renderStickerDeliveryPreference(card):'',
    !card.exclusivePrompt&&card.chatStyle?.trim() ? `【此伙伴的聊天偏好】\n${card.chatStyle.trim()}` : '',
  ].filter(Boolean).join('\n')
}

/** Stable transport settings, without selecting emotions, jokes, verbosity or sticker frequency. */
export function renderVoicePreference(card?: CharacterCard): string {
  return card?.length==='short'&&card.shortVoiceReplies===true
    ? '【用户选择的语音偏好】先按人物与场景选择表达形式；这项偏好只决定口语用语音还是文字，不要求每次都说话或取代表情包。仅私聊短句优先语音，长句用文字。群聊不应用“尽量语音”偏好，默认文字，不因这项设置自行改用语音；群聊明确需要语音时仍可调用已授权语音能力。已选择用话表达且每条是半句到两句的简短口语时，尽量使用当前渠道已配置且已授权的语音工具，直接合成当前人物写好的台词；较长解释、链接、代码、清单和需要回看的内容用文字或附件，不为凑语音把长内容拆成许多语音条。partner_chat_say 和 partner_chat_reply 默认 delivery=auto，自动按此偏好使用当前渠道已选音色，无需先发文字再另找语音工具；不猜音色。当前明确要求文字、安静或需要回看的内容设 delivery=text；原文使用 preserveText。语音未配置或明确失败可改文字，发送结果未知则先核对，不能重复发送。messages 已分好的多条短句会依次发成独立语音，不拼成一条；仍想继续说时用 continueTurn:true 或 partner_chat_say。成功语音不再复述同义文字。任务前需要登记动作时仍先按任务工具约定处理，不绕过前置回执。'
    : ''
}

/** Keep enabled media operations available in exclusive-persona mode, without prescribing a persona or frequency. */
export function renderStickerDeliveryPreference(card?: CharacterCard): string {
  return card?.enabled&&card.stickersEnabled
    ? '【图片表情投递】表情包已开启。先按当前人物与场景决定用话还是图片表情，短句语音偏好只转换已经选择说出口的话，不取代图片表达。无需等对方索要表情；是否使用仍由当前人物决定，不设每轮或每隔几轮必发。通过 partner_tools 的 activity 目录查询/调用 partner_stickers，list 取真实 ID，inspect 看图，partner_chat_reply 的 messages 用独立 {stickerId} 条目发送；可只发图，不必配同义文字或语音。关键词无结果可省略 query 浏览收藏，不能把没搜到当成库里没有。想用语音再配图时，先用 continueTurn:true 接话再发图，勿提前结束。'
    : ''
}

export function renderChatDeliveryGuidance(card?: CharacterCard): string {
  if (!card?.enabled) return ''
  if (!card.segmentedReplies && !card.stickersEnabled) return renderVoicePreference(card)
  return [
    '【聊天投递】先按当前人物、对方明确要求和语境选择文字、图片表情或语音，再组织内容，不默认先写一段文字。对方明确想听语音或想看表情时，先核实并使用对应已开启能力；能力可用时不以文字解释代替实际发送，不因人物性格声称不能使用。已表达清楚就结束，不强制轮流使用或凑次数。选择文字或图片表情且分段回复或表情包开启时，聊天最终回复用 partner_chat_reply 发送并结束本轮，不用工具外普通最终文本代替；文字写入 messages 的 text 条目，图片表情写独立 stickerId 条目，不把配文留在工具外。partner_chat_say 与 partner_chat_reply 的 delivery 默认 auto，仅私聊开启短句优先语音时会自动发送合适的短句语音，群聊默认文字；明确需要文字时用 delivery=text，不先发同义文字。想先说一句再继续时可用 partner_chat_say；中途文字或表情可用 partner_chat_reply continueTurn:true，确认送达后继续执行、不重复；已送达且无需补充时可用 partner_chat_reply messages:[] 结束。任务仍按任务回应流程执行。',
    '语音与文字是并列的聊天方式：经 partner_tools 的 activity（自主活动）目录查询和调用 partner_voice_reply；status 查询当前渠道 TTS，speak 合成发送按人物写好的短台词；脚本已生成的音频用 send_file 和 path 直接发送，不需要选择 TTS 服务；成功后不再用文字复述。未配置外部 TTS 时可查询 partner_qq_reply 的原生语音。闲聊、随口反应或有声表达更贴切时可自行选择；路径、代码、需要回看的数据适合文字。不可用时如实简短说明，不捏造调用成功。',
    renderVoicePreference(card),
    card.segmentedReplies
      ? '分段回复已开启：messages 的每个 text 条目是一条独立消息；换行不等于独立投递。' + (usesShortDeliveryPolicy(card) ? SEGMENTED_CHAT_GUIDANCE : '条数由内容决定，无最低条数要求。')
      : '分段回复未开启：文字只用一条，表情可独立一条。',
    card.stickersEnabled
      ? renderStickerDeliveryPreference(card)+' 每次最多两张；人物里的图片表情包偏好对应真实图片，不用颜文字或 QQ 小黄脸代替。收藏、备注、排序和删除通过 partner_qq 的 stickers 分类，属于公开聊天能力，仍受当前渠道开关和权限校验；收藏与发送是不同操作，承诺不算执行。'
      : '表情包未开启：不查找或提交表情。',
    '内部任务和心跳使用各自任务协议，不调用聊天终结工具。',
  ].join('\n')
}

/** The user-requested before/after workflow, independent of response style. */
export function renderTaskConversationGuidance(): string {
  return '【任务回应流程】私聊执行工具任务前，用 partner_chat_say（beforeTools:true，expectedTools 为真实工具名）用 text 按当前人物说准备做的动作；直接写要对用户说的正文。确认送达后继续做事，不重复开场；新增工具通过 expectedTools 登记。调查和操作直接在当前会话执行，不为改口吻另开工作会话；执行中有需要可用 partner_chat_say 接话，完成后自己根据真实结果写 messages，沿用当前人格。流程只规定操作与投递，不规定道歉、汇报或解释的语气。具体参数与交付方式按需查看工具说明。'
}

/** Delivery policy, not a replacement persona. Explicit requests override defaults. */
export function renderReplyRhythm(card?: CharacterCard): string {
  return [
    '一轮可以有多个执行目标。过程中可用 partner_chat_say 接话，或 partner_chat_reply continueTurn:true 穿插文字、表情，随后继续执行；没有新话不必播报。',
    '需要保留的长任务过程、结论、未确认事项和依据用 partner_send_attachment 的 document 保存并交付，name 按实际主题命名；已有文件可直接交付，不为简短答复另造报告。',
    usesShortDeliveryPolicy(card) ? '短句已开启：日常聊天正文一轮最终提交最多 180 字，多个意思按自然停顿分别写进 messages；详细结果放报告，不截断、不为分段凑话。用户明确要展开或附件失败时可用 inlineDetails 正文交付。' : '',
    '报告确认送达后按当前人物与关系设定自然收尾，先回应用户最关心的结果，可补一个具体发现；正文不再重复报告提纲、验证过程和完整限制清单。会影响用户判断的失败、未完成或不确定性须简短说明，不能因有附件就藏起来；追问细节时再展开。已送达的同一结论无新内容不重发。所有开场和穿插也保持同一人格，不套用汇报话术。',
  ].filter(Boolean).join('\n')
}
