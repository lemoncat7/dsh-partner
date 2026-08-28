import { focusedConcernQuery, type PartnerConcern } from './concern-domain.js'
import { resolve } from 'node:path'

export function concernObservationPrompt(concerns: PartnerConcern[], workspaceRoot?: string): string {
  const observedAt = new Date().toISOString()
  const targets = concerns.map(item => ({
    id: item.id,
    subject: item.subject,
    reason: item.reason,
    origin: item.origin,
    priority: item.priority,
    watchKind: item.watchKind,
    watchQuery: item.watchQuery,
    resources: (item.resources ?? []).map(resource => {
      if (resource.kind === 'file') return workspaceRoot ? { ...resource, path: resolve(workspaceRoot, resource.locator) } : resource
      const slash = resource.locator.indexOf('/')
      return slash < 0
        ? { ...resource, knowledgeBase: resource.locator }
        : { ...resource, knowledgeBase: resource.locator.slice(0, slash), document: resource.locator.slice(slash + 1), searchQuery: focusedConcernQuery(resource.locator.slice(slash + 1)) }
    }),
    lastCheckedAt: item.lastCheckedAt ?? null,
    currentNextCheckAt: new Date(item.nextCheckAt).toISOString(),
  }))
  return [
    '执行一次独立的伙伴变化观察。目标不是找话说，而是判断这些尚未闭环的事情自上次观察后是否出现了真实、相关、可验证的新变化。',
    `本轮挂念：${JSON.stringify(targets)}`,
    '逐项判断，相关项可以合并调查。根据挂念本身选择最有效的信息源，但每个来源内部都必须逐层缩小范围，不能把库名、目录名、对象、动作和理由拼成一条大杂烩 query。明确关联的 @文件或 @知识库文档通常是判断基线，当前目录适合项目状态，知识库适合既有记录，网页适合公开且有时效的变化。',
    '知识库按“确定库 → 库内检索 → 读取准确条目”执行：knowledge_base_search 只用来发现哪个库，不返回文档内容；knowledge_search 必须带一个准确 base，并只使用具体项目名、文档名或对象标识作为精简 query；最后用返回的准确 handle 调 knowledge_read。resources 已给出 knowledgeBase 时，说明第一层已经确定，直接从 knowledge_search 开始；给出 searchQuery 时直接使用它，不要自行拼接库名、动作词“关注/留意”或整句理由。',
    'knowledge_read 读到的明确执行步骤、来源优先级、必须项、禁止项、核验条件和失败处理，是本轮调查的操作约束，不只是背景资料。必须按文档指定链路执行，不得擅自改写成泛搜索。文档指定了原始 URL 时应直接核验该 URL：普通可读正文用 web_fetch；需要 HTML 标记、脚本内嵌 JSON、ID 或时间戳时用 web_source，并可用 find 定位文档要求的标记。',
    '本地目录按“确定范围 → 找到候选文件或命中位置 → 读取准确文件”执行：没有明确文件时先用 glob 确定候选，再用 grep 定位相关内容，最后 read 命中的文件；resources 已给出 @文件时范围已经确定，可以直接 read。不要先读取一批无关文件，也不要把目录名当成内容关键词。',
    '网页按“明确外部对象 → 核验指定原始来源；没有指定来源时才搜索候选 → 核验可靠来源”执行，只在挂念确实依赖公开时效变化时使用。搜索词保留项目名、仓库名、版本或具体事件，去掉“关注、留意、帮我看看”等动作描述。web_search 只能用于发现候选，不能替代知识文档明确指定的原始页面，也不能把搜索摘要冒充原帖、发布说明或一手证据。',
    '若指定原始来源、解析链路或必要证据不可访问、抓取失败、没有命中文档要求的结构，必须严格采用知识文档约定的失败处理；没有特别约定时也应视为“未核到”，令 changed=false。不得换一组宽泛搜索词制造看似相关的结果。',
    '本地文件和知识库中的既有记录是基线，不是“新变化”。网页结果必须与基线比较；无法说明相对基线新增了什么时，changed 必须为 false。不要把本地项目问题、宽泛主题或普通关键词无差别丢给网页搜索。',
    '在缺少可靠的新证据时，选择与挂念直接相关的工具核验；工具可自由组合，已有结果足够时停止，不做无关或重复搜索。不得读取伙伴记忆、会话归档、日记或 concerns 数据库，不得执行命令、发布、提交或操作其他外部系统。',
    '若挂念明确关联了 @文件，且调查发现可靠的新变化，你可以把结论、依据、时间或后续状态整理回该关联文件。resources.path 是该文件可供工具使用的绝对路径。更新前先读取现有内容，优先使用 edit 做最小修改；只能更新 resources 中明确列出的现存文件，不能创建、删除或修改其他文件，也不能改伙伴私有存储。文件更新后，在 event、evidence 和 source 中如实说明更新了什么。',
    '只有相对既有状态真正新增的事实、进展、风险、等待条件变化或可执行机会，changed 才是 true。旧信息、普通关键词命中、无关资料和无法核实的猜测都必须是 false。',
    `本轮观察时间：${observedAt}。你还要为每个挂念独立决定下一次检查间隔 nextCheckInMinutes。根据对象的变化速度、明确等待条件、信息源成本、当前证据与最近是否有变化来安排；即使 changed=false 也必须给出。最少 30 分钟，最多 43200 分钟（30 天）。临近事件或高频变化通常可用 30～180 分钟，普通项目变化可用 360～1440 分钟，低频等待可用 4320～43200 分钟。不要让所有挂念机械地使用相同间隔。`,
    '最后只输出一个 JSON 对象，不要 Markdown、寒暄或通知文案。格式：',
    '{"observations":[{"concernId":"必须来自本轮挂念 id","changed":false,"event":"新变化的简洁结论；无变化时留空","evidence":"支持判断的关键证据；无变化时可简述检查结果","source":"来源名称或位置","relevance":0.0,"confidence":0.0,"actionability":0.0,"nextCheckInMinutes":360}]}',
    '每个挂念恰好返回一项。评分范围 0 到 1；nextCheckInMinutes 使用整数分钟。你只负责语义判断与下次检查节奏，是否提醒由确定性策略另行决定。',
  ].join('\n')
}
