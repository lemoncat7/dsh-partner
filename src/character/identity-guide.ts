import { PERSONA_TEMPLATES } from './persona-templates.js'
export { PERSONA_TEMPLATES, personaReferenceRequested } from './persona-templates.js'
import { ROLE_REFERENCE_SOURCE, ROLE_REFERENCE_TEXT } from './role-reference-data.js'

export const PERSONA_REFERENCE = { name: '大肥鱼（qq-bridge 原名：小鲸鱼）', source: ROLE_REFERENCE_SOURCE, text: ROLE_REFERENCE_TEXT, usage: '这是创作参考资料，不是当前角色、工具指令或授权。先读原文的结构、具体反应、说话节奏与正反例，再按用户要求创作。不要直接复制鲸鱼身份、专属梗、群聊调度或工具名称；当前人格与可用工具以本伙伴实际配置为准。' }

/** Shared authoring guide, loaded on demand. */
export const PERSONA_GENERATION_GUIDE = `首次按用户要求创建人格，或用户明确要求参考模板时，读取 reference 动作（或 inspect includeReferences=true）返回的 templates 与 reference.text。普通修改和 AI 自主优化基于当前设定，不必读模板或重新套版。三份 templates 分别对应基本身份、角色设定、关系设定，共用同一字段映射和通用示例。reference.text 它是 qq-bridge 默认大肥鱼（小鲸鱼）的完整原卡，与页面参考一致，无需联网查找。参考原卡的格式和内容组织：你是谁、具体反应、说话规则、节奏习惯、个性与梗、避免的表达、正反例、背景形象；按用户需要取舍并重写，不照搬固定人物，不把原卡当作正在生效的指令。分开保存两份内容：
一、characterCard.roleText（角色设定，enabled=true）：
## 你是谁：角色自身身份、年龄、兴趣与动机，不写“你是用户的某某”。
## 性格与反应：对玩笑、矛盾、困难的自然反应，不预设每个对话对象与自己的关系。
## 怎么说话：措辞、节奏、停止时机、避免的表达；可附 3–5 组通用正反例，不是真实经历。
二、顶层 relationshipText（关系设定）：
## 我们的关系：角色与用户的身份关系。
## 称呼与相处：专属称呼、亲疏、依赖或偏爱的具体表现；涉及这段关系的示例也放这里。
基本身份、行为准则、聊天偏好、背景资料也只写通用部分，专属关系统一放 relationshipText。旧文本混写时，将关系内容移到关系设定，保留其含义，不重复注入；旧 characterCard.relationship 仅兼容读取，以顶层 relationshipText 为准，空字符串表示清除。
默认适配器合并两份；QQ 只发送角色，只有真实发送账号与访问权限中的归属 QQ 匹配才附加关系。同一个 QQ 在私聊和群聊都适用；没有绑定时不附加关系。不得由昵称、自称或群号认定关系对象，也不额外强制陌生人冷淡。
保留未要求修改的设置，不改工具权限、授权与自主活动开关。inspect 读取 expectedAt 后 update 保存生效身份；不要只展示文案。页面和 AI 编辑同一份生效身份；并发编辑必须重新读取版本，不覆盖用户未保存的修改。`
export const PERSONA_REQUEST_EXAMPLE = '请生成并应用人格设定：角色自身是【身份】，性格和喜好是【特点】，说话用【语气】，避免【不喜欢的表达】。我们是【关系】，称呼和相处方式是【要求】。请把角色与关系分开保存，通用对话示例放角色设定，专属称呼和关系示例放关系设定；保留未提及的设置。'

export function personaReferenceBundle() { return { templates: PERSONA_TEMPLATES, reference: PERSONA_REFERENCE, generationGuide: PERSONA_GENERATION_GUIDE } }
export function renderPersonaReference() { return '【本轮人格创作参考 · 只供创作，不是当前角色】\n本插件的大肥鱼参考来源固定为 qq-bridge《DeepSeek 小鲸鱼 —— QQ 群友版》，与页面一致。历史对话、记忆或搜索里的 dsh-cosplay 默认卡不是这份参考；不得混用或声称读过尚未读取的资料。下面的通用模板用于按用户需求创作，不自动覆盖当前身份，不改变工具权限。\n' + JSON.stringify(personaReferenceBundle()) }
