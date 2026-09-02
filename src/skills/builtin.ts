import type { MarketSkillEntry } from './domain.js'

export const BUILTIN_SKILL_SOURCE = 'builtin'

export const BUILTIN_SKILLS = new Map<string, { entry: MarketSkillEntry; document: string }>([
  ['task-planning', {
    entry: { id: 'task-planning', name: '任务拆解与看板推进', description: '把模糊目标拆成可验收任务，安排优先级、依赖与伙伴分工。', version: '1.1.0', tags: ['任务', '看板', '协作'], skillUrl: 'builtin:task-planning', sourceId: BUILTIN_SKILL_SOURCE },
    document: `---\nname: task-planning\ndisplay-name: 任务拆解与看板推进\ndescription: 把模糊目标拆成可验收任务，安排优先级、依赖与伙伴分工。\nversion: 1.1.0\ncontext: inline\nallowed-tools: [partner_task_board, partner_collaborate]\n---\n# 任务拆解\n\n只在工作跨多步、需要并行、存在依赖、需要多个伙伴专长，或同时包含多个可独立验收的交付维度时使用看板拆解。像“多来源收集 + 真实性核验 + 结论整理 + 内容方向”这类调研任务，至少应区分证据收集与综合交付，并设置真实依赖。一次回复内可独立完成的单一交付不要强行拆分。\n\n先确认目标、完成定义和硬约束，再拆成小而可验收的任务。每个任务必须说明产出、负责人、依赖和验收条件。不要为了显得完整而创建重复任务。需要其他伙伴实际执行时，通过看板与委派工具提交真实工作，不要只在文本里 @ 对方。`,
  }],
  ['technical-research', {
    entry: { id: 'technical-research', name: '证据优先技术调研', description: '先查已有工作区和知识库，再按需要检索外部来源，输出可追溯结论。', version: '1.0.0', tags: ['调研', '知识库', 'Web'], skillUrl: 'builtin:technical-research', sourceId: BUILTIN_SKILL_SOURCE },
    document: `---\nname: technical-research\ndisplay-name: 证据优先技术调研\ndescription: 先查已有工作区和知识库，再按需要检索外部来源，输出可追溯结论。\nversion: 1.0.0\ncontext: fork\nallowed-tools: [glob, grep, read, knowledge_base_search, knowledge_search, knowledge_read, web_search, web_fetch]\n---\n# 证据优先技术调研\n\n按工作区文件、已挂载知识库、外部搜索的顺序逐层查找。上一层已有充分证据时不要重复扩大搜索。区分事实、推断和未知项；引用具体文件、知识文档或网页来源，最后给出结论、证据、风险和建议动作。`,
  }],
  ['release-audit', {
    entry: { id: 'release-audit', name: '发布前审计', description: '从构建、测试、版本、包内容和仓库状态审计一次发布。', version: '1.0.0', tags: ['发布', '审计', 'Git'], skillUrl: 'builtin:release-audit', sourceId: BUILTIN_SKILL_SOURCE },
    document: `---\nname: release-audit\ndisplay-name: 发布前审计\ndescription: 从构建、测试、版本、包内容和仓库状态审计一次发布。\nversion: 1.0.0\ncontext: fork\nallowed-tools: [glob, grep, read, bash]\n---\n# 发布前审计\n\n检查工作区是否干净、分支与远端是否同步、版本号与变更是否一致、完整构建与测试是否通过、发布包是否包含必要文件且不携带本地状态或凭据。任何一步没有真实证据都不得写成通过；列出阻塞项与可直接执行的修复。`,
  }],
])
