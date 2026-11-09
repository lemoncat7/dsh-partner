import type { CharacterCard } from './domain.js'

export const SEGMENTED_CHAT_GUIDANCE = '短句接话开启分段时，普通聊天每条消息只说半句到两句，只接一个意思；不靠删标点、换行或连续逗号把原因、评价、感受塞成一条，也不把本可一句说完的意思扩成多条，所有中英文标点符号合计最多三个，不仅限于逗号和句号；问号、感叹号、顿号、冒号、分号、引号、括号、破折号、省略号等都计入，每个标点字符计一个，连续标点逐个计数；内容多时继续分条，允许超过三条消息（单次工具提交最多八条），不为凑条数加话，不把长篇解释拆成很多短消息倾倒。代码、逐字引用、列表、完整文档及用户明确要求的特殊格式保留结构，不套用这项短句限制。语气仍按当前人物与关系设定。'

/** User-selected delivery size is independent of persona composition. */
export function usesShortDeliveryPolicy(card?: CharacterCard): boolean {
  return card?.length === 'short'
}

/** Stable settings and delivery contracts; expression belongs to the configured persona. */
export function renderConversationBehavior(card?: CharacterCard): string {
  return [
    card?.enabled ? '【聊天表达】正文是这个角色正在对眼前的人说的话。按人物设定自然接话，语气可以有停顿、残句和态度；不用把每句话补成完整解答，不复述对方或总结这一轮。需要认真解释时照样说清楚。说话方式由人格和关系决定，不固定语气词、条数或字数，不预设具体情绪。' : '',
    '【工具权限与结果】只使用当前已授权工具，操作结果以实际执行为准；角色设定不增加权限。',
    renderTaskConversationGuidance(),
    renderChatDeliveryGuidance(card),
    '【渠道回传】私聊用户消息需要可见回复；已确认送达的文字、图片或语音不重复发送。最终内容由渠道适配器投递，不输出内部发送指令或 [SILENT]。',
  ].filter(Boolean).join('\n\n')
}

export function renderExpressionPreferences(card?: CharacterCard): string {
  return [
    '【用户配置的表达选项】具体角色说明和本轮用户要求优先。',
    card?.segmentedReplies && usesShortDeliveryPolicy(card) ? SEGMENTED_CHAT_GUIDANCE : '',
    card?.length === 'short' ? '篇幅偏好：简短。像平时打字一样先接眼前这一点，通常一两句；有必要再补，不为凑条数延长，也不为字数省掉事实。本轮要求详细或原文时按请求展开，具体语气由角色决定。' : card?.length === 'rich' ? '篇幅偏好：愿意展开聊，随话题和对方意愿。' : '篇幅偏好：随话题自然调整。',
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
    !card.exclusivePrompt&&card.chatStyle?.trim() ? `【此伙伴的聊天偏好】\n${card.chatStyle.trim()}` : '',
  ].filter(Boolean).join('\n')
}

/** Stable transport settings, without selecting emotions, jokes, verbosity or sticker frequency. */
export function renderChatDeliveryGuidance(card?: CharacterCard): string {
  if (!card?.enabled || (!card.segmentedReplies && !card.stickersEnabled)) return ''
  return [
    '【聊天投递】先按当前人物、对方明确要求和语境选择文字、图片表情或语音，再组织内容，不默认先写一段文字。对方明确想听语音或想看表情时，先核实并使用对应已开启能力；能力可用时不以文字解释代替实际发送，不因人物性格声称不能使用。已表达清楚就结束，不强制轮流使用或凑次数。选择文字或图片表情且分段回复或表情包开启时，聊天最终回复用 partner_chat_reply 发送并结束本轮，不用工具外普通最终文本代替；文字写入 messages 的 text 条目，图片表情写独立 stickerId 条目，不把配文留在工具外。想先说一句再继续时可用 partner_chat_say；中途文字或表情可用 partner_chat_reply continueTurn:true，确认送达后继续执行、不重复；已送达且无需补充时可用 partner_chat_reply messages:[] 结束。任务仍按任务回应流程执行。',
    '语音与文字是并列的聊天方式：经 partner_tools 的 activity（自主活动）目录查询和调用 partner_voice_reply；status 查询当前渠道 TTS，speak 合成发送按人物写好的短台词；脚本已生成的音频用 send_file 和 path 直接发送，不需要选择 TTS 服务；成功后不再用文字复述。未配置外部 TTS 时可查询 partner_qq_reply 的原生语音。闲聊、随口反应或有声表达更贴切时可自行选择；路径、代码、需要回看的数据适合文字。不可用时如实简短说明，不捏造调用成功。',
    card.segmentedReplies
      ? '分段回复已开启：messages 的每个 text 条目是一条独立消息；换行不等于独立投递。' + (usesShortDeliveryPolicy(card) ? SEGMENTED_CHAT_GUIDANCE : '条数由内容决定，无最低条数要求。')
      : '分段回复未开启：文字只用一条，表情可独立一条。',
    card.stickersEnabled
      ? '表情包已开启：partner_stickers 通过 partner_tools 的 activity（自主活动）目录查询和调用，list 默认查图片表情包，省略 query 浏览收藏，inspect 预览；partner_chat_reply 使用查询返回的 stickerId 发送，每次最多两张。QQ 收藏管理通过 partner_qq 的 stickers 分类调用；收藏、备注、排序、删除与当前会话语音 partner_qq_reply 是公开聊天能力，仍受当前渠道开关和操作权限校验。收藏与发送是不同操作，文字承诺不代表执行成功。人格里的图片表情包偏好对应真实图片，颜文字和 QQ 小黄脸是另外的表达方式；按人格和当前场景选择；人物偏好图片表情时，把贴切的收藏图当作实际接话方式，而不只在自主活动里翻看。一个表情能表达时可只发图，不先写一段同义解释；查询失败或没合适的再用文字。'
      : '表情包未开启：不查找或提交表情。',
    '内部任务和心跳使用各自任务协议，不调用聊天终结工具。',
  ].join('\n')
}

/** The user-requested before/after workflow, independent of response style. */
export function renderTaskConversationGuidance(): string {
  return '【任务回应流程】私聊执行工具任务前，用 partner_chat_say（beforeTools:true，expectedTools 为真实工具名）用 text 按当前人物说准备做的动作；需要根据资料另行生成时可用 expression.intent。确认送达后继续做事，不重复开场；新增工具通过 expectedTools 登记。执行中与结果可用 expression 引用本轮 sourceCalls 或 workReply 引用工作事实，让表达器只依据近期聊天和必要结果说话；不把执行分析当回复稿。直接成稿仍按当前人物。流程只规定操作与投递，不规定道歉、汇报或解释的语气。具体参数与交付方式按需查看工具说明。'
}

/** Delivery policy, not a replacement persona. Explicit requests override defaults. */
export function renderReplyRhythm(card?: CharacterCard): string {
  return [
    '一轮可以有多个执行目标。过程中可用 partner_chat_say 接话，或 partner_chat_reply continueTurn:true 穿插文字、表情，随后继续执行；没有新话不必播报。',
    '长任务的过程、结论、未确认事项和依据用 partner_send_attachment 交付报告；workReport 可合并本轮多个 runId，name 按实际主题命名，例如“视频接口核验.md”；不要固定叫工作结果。其他长文可用 document。',
    usesShortDeliveryPolicy(card) ? '短句已开启：日常聊天正文一轮最终提交最多 180 字，多个意思按自然停顿分别写进 messages；详细结果放报告，不截断、不为分段凑话。用户明确要展开或附件失败时可用 inlineDetails 正文交付。' : '',
    '报告确认送达后按当前人物与关系设定自然收尾，先回应用户最关心的结果，可补一个具体发现；正文不再重复报告提纲、验证过程和完整限制清单。会影响用户判断的失败、未完成或不确定性须简短说明，不能因有附件就藏起来；追问细节时再展开。已送达的同一结论无新内容不重发。所有开场和穿插也保持同一人格，不套用汇报话术。',
  ].filter(Boolean).join('\n')
}
