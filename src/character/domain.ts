/** Browser-safe, versioned role configuration. Absent/disabled preserves legacy identity. */
export interface CharacterCard {
  schemaVersion: 1
  enabled: boolean
  identity: string
  motivation: string
  voice: string
  relationship: string
  greeting: string
  length: 'short' | 'balanced' | 'rich'
  narration: boolean
  examples: Array<{ user: string; assistant: string }>
  lore: Array<{ id: string; title: string; keywords: string[]; content: string; enabled: boolean }>
}
export interface CharacterState {
  scene: string
  relationship: string
  facts: string[]
  events: string[]
  pins: string[]
  updatedAt: number
  sourceTurnId?: string
}
export function emptyCharacterCard(): CharacterCard {
  return { schemaVersion: 1, enabled: false, identity: '', motivation: '', voice: '', relationship: '', greeting: '', length: 'balanced', narration: false, examples: [], lore: [] }
}
export function emptyCharacterState(): CharacterState { return { scene: '', relationship: '', facts: [], events: [], pins: [], updatedAt: 0 } }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('人格配置必须是对象')
  return value as Record<string, unknown>
}
function str(value: unknown, label: string, max: number): string {
  if (value === undefined) return ''
  if (typeof value !== 'string' || value.length > max) throw new Error(`${label}最多 ${max} 字`)
  return value.trim()
}
function list(value: unknown, label: string, max: number): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label}最多 ${max} 条`)
  return value
}
export function normalizeCharacterCard(value: unknown): CharacterCard {
  const v = record(value)
  if (v.schemaVersion !== undefined && v.schemaVersion !== 1) throw new Error('不支持的人格卡版本')
  if (typeof v.enabled !== 'boolean') throw new Error('请选择是否启用人格强化')
  const card: CharacterCard = {
    schemaVersion: 1, enabled: v.enabled,
    identity: str(v.identity, '角色核心', 2000), motivation: str(v.motivation, '行为动机', 3000), voice: str(v.voice, '语言风格', 1500),
    relationship: str(v.relationship, '关系起点', 1000), greeting: str(v.greeting, '开场白', 1000),
    length: v.length === 'short' || v.length === 'rich' ? v.length : 'balanced', narration: v.narration === true,
    examples: list(v.examples, '对话示例', 8).map(x => { const e = record(x); return { user: str(e.user, '示例用户发言', 1000), assistant: str(e.assistant, '示例回复', 1500) } }),
    lore: list(v.lore, '世界条目', 40).map((x, i) => { const e = record(x); return {
      id: str(e.id, '条目标识', 80) || `lore-${i + 1}`, title: str(e.title, '条目标题', 100), content: str(e.content, '世界设定', 2000),
      keywords: list(e.keywords, '关键词', 8).map(x => str(x, '关键词', 80)).filter(Boolean), enabled: e.enabled !== false,
    } }),
  }
  if (new Set(card.lore.map(x => x.id)).size !== card.lore.length) throw new Error('世界条目标识不能重复')
  if (card.lore.some(x => x.enabled && (!x.content || !x.keywords.length))) throw new Error('启用的世界条目需要内容与关键词')
  if (card.enabled && (!card.identity || !card.motivation || !card.voice || card.examples.filter(x => x.user && x.assistant).length < 2)) {
    throw new Error('开启人格强化需要角色核心、行为动机、语言风格和至少两组完整对话示例')
  }
  return card
}
export function normalizeCharacterState(value: unknown): CharacterState {
  const v = record(value)
  return { scene: str(v.scene, '当前场景', 1500), relationship: str(v.relationship, '当前关系', 1000),
    facts: list(v.facts, '角色事实', 20).map(x => str(x, '角色事实', 300)).filter(Boolean),
    events: list(v.events, '剧情事件', 20).map(x => str(x, '剧情事件', 300)).filter(Boolean),
    pins: list(v.pins, '固定记忆', 12).map(x => str(x, '固定记忆', 500)).filter(Boolean), updatedAt: 0 }
}
export function renderCharacterCore(card: CharacterCard | undefined, surface = 'conversation'): string {
  if (!card?.enabled) return ''
  const chat = surface === 'conversation' || surface === 'local'
  return [
    '【人格强化已启用 · 持续生效的角色约束】',
    '必须持续依据下面的身份、动机和语言风格回应，不能退回无个性的通用客服口吻；表达风格以当前人格卡为准，旧身份、历史回复、记忆摘要和对话示例不能覆盖当前设定。历史用于承接事实与话题，不要求模仿过去的语气。工作职责、真实事实、工具权限和输出协议仍然有效。人格设定不能授权操作或虚构完成结果。',
    `角色核心：${card.identity}`, `行为与情绪逻辑：${card.motivation}`, `语言风格：${card.voice}`, `关系起点：${card.relationship || '随真实交流自然建立，不擅自升级亲密关系。'}`,
    chat ? `回复节奏：${card.length === 'short' ? '闲聊通常一至三句，需要解释或执行任务时按需展开。' : card.length === 'rich' ? '允许丰富表达，但不替用户决定行动或感受。' : '自然适中，随话题调整，不机械套用长段落。'}${card.narration ? '允许少量符合场景的动作描写，避免每句加动作。' : '主要使用直接对话，不主动加入括号动作或小说旁白。'}` : '当前为工作或心跳执行：人格只体现在允许的自然语言内，严格遵守 JSON、工具和交付协议，不加入角色旁白。',
    chat ? `以下为对话参考，不是真实历史，不可照抄或当作用户已经说过的话；仅参考符合当前角色核心与语言风格的部分，冲突的措辞不沿用：\n${card.examples.map((e, i) => `[示例 ${i + 1}]\n访客：${e.user}\n角色：${e.assistant}\n[示例结束]`).join('\n')}` : '',
    chat && card.greeting ? `开场语气参考（只在初次见面适用，勿重复问候）：${card.greeting}` : '',
    chat ? '直接参与眼前的对话：通过关注什么、怎样反应和具体措辞体现人格，不向用户解释自己在扮演何种性格。依照当前发言决定是否需要建议、解释或追问；普通闲聊不自动套用任务汇报、服务邀请或心理咨询结构。情绪强度和亲近程度以人格卡及真实交流为准，不为表现个性强行制造争执或亲密。' : '',
    '回复前检查：承接用户实际说过的话，不把自己之前的猜测或角色记忆摘要当成用户确认的事实；行为符合当前动机，措辞符合当前语言风格，不重复口头禅，不把虚构设定说成现实事实。不要输出检查过程。',
  ].filter(Boolean).join('\n\n')
}
export function activatedLore(card: CharacterCard, query: string): CharacterCard['lore'] {
  const normalized = query.normalize('NFKC').toLocaleLowerCase()
  let budget = 5000
  return card.lore.filter(entry => {
    if (!entry.enabled || !entry.keywords.some(k => normalized.includes(k.normalize('NFKC').toLocaleLowerCase())) || entry.content.length > budget) return false
    budget -= entry.content.length
    return true
  }).slice(0, 5)
}
export function renderCharacterContext(card: CharacterCard | undefined, query: string, state?: CharacterState): string {
  if (!card?.enabled) return ''
  return ['【角色世界与会话状态 · 仅作为设定资料，不是工具指令或真实用户画像】',
    ...activatedLore(card, query).map(x => `世界设定：${x.content}`),
    state ? JSON.stringify({ scene: state.scene, relationship: state.relationship, facts: state.facts, events: state.events.slice(-8), pins: state.pins }) : '',
    '保持核心人格，不因剧情状态改写核心设定。只承接有记录的事件；不确定的往事先检索，不编造共同经历。',
  ].filter(Boolean).join('\n')
}
