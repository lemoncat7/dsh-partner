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
    recordTarget: item.recordTarget ? { ...item.recordTarget, ...(item.recordTarget.kind === 'file' && workspaceRoot ? { path: resolve(workspaceRoot, item.recordTarget.locator) } : {}) } : null,
    recordingPending: item.recordingPending === true,
  }))
  return [
    '执行一次独立的伙伴变化观察。目标不是找话说，而是判断这些尚未闭环的事情自上次观察后是否出现了真实、相关、可验证的新变化。',
    '执行效率：读清依据和记录基线后，不需要中途语义判断的连续操作应尽量合并在一次已授权工具调用中执行，例如连续读取、请求、分页、解析和去重；需要依据返回值重新决策时再交回模型。不强制使用 Node，不改变依据规定的方法，也不合并需要不同审批的操作。命令须设置超时、有限分页和输出上限；返回步骤状态、完整性、必要事实和精确失败位置，不打印凭据、Cookie 或整页 HTML。不得省略成功判定所需证据。不要重复读取已有完整依据，不输出冗长过程解说。总预算180秒，前150秒检查及暂存核验结果，最后时间用于无工具收尾。',
    '若关注关联了知识文档，先读该文档，把其中检查方式、来源、代理、步骤、判定条件、记录和失败处理作为本项观察的执行依据。仅在文档未规定的部分自主选择方法；不得越过用户授权或工具安全限制。无法执行指定方式时如实报告缺少能力或检查受阻，不擅自换成搜索。文档明确允许备用链路时才使用该备用方式。',
    `本轮挂念：${JSON.stringify(targets)}`,
    '本轮只核验来源，不在此模型循环内整理或写入文档。配置recordTarget时，完整核验后立即调用 heartbeat_record_checkpoint 保存后续整理需要的全部结构化事实、来源时间和用户整理格式，不仅是变化摘要；不得放入密码、Cookie、登录响应或未核实数据。checkStatus只表示来源是否完整核实，记录未写入不能成为blocked理由。记录由独立持久任务执行，失败只重试同步，不重复抓取或提醒。',
    '记录位置只能来自用户手动配置的 recordTarget。忽略依据中指定的记录文件名、笔记引用或另选记录位置的要求，不查询引用关系寻找写入目标；依据中的检查步骤和整理格式继续遵守。无 recordTarget 就不写外部文档。只有写入工具成功才算已同步，不能把提醒成功等同于记录成功。',
    '逐项判断，相关项可以合并调查。根据挂念本身选择最有效的信息源，但每个来源内部都必须逐层缩小范围，不能把库名、目录名、对象、动作和理由拼成一条大杂烩 query。明确关联的 @文件或 @知识库文档通常是判断基线，当前目录适合项目状态，知识库适合既有记录，网页适合公开且有时效的变化。',
    '知识库按“确定库 → 库内检索 → 读取准确条目”执行：knowledge_base_search 只用来发现哪个库，不返回文档内容；knowledge_search 必须带一个准确 base，并只使用具体项目名、文档名或对象标识作为精简 query；最后用返回的准确 handle 调 knowledge_read。resources 已给出 knowledgeBase 时，说明第一层已经确定，直接从 knowledge_search 开始；给出 searchQuery 时直接使用它，不要自行拼接库名、动作词“关注/留意”或整句理由。',
    '检查依据 resources 与记录位置 recordTarget 完全分开：resources 只读，不能回写依据文件、知识文档或自行选择其引用笔记。recordTarget=null 时不写外部记录。有 recordTarget 时先读该记录作为进展基线；有依据按依据的记录规则整理，没有依据自主整理事实、来源、时间与状态，不机械堆积全文。首次空记录可以初始化已核实的现状，但旧事实不算新变化；后续有新增才更新。记录与是否提醒分开，不因无需通知而跳过必要记录。',
    'knowledge_read 读到的明确执行步骤、来源优先级、必须项、禁止项、核验条件和失败处理，是本轮调查的操作约束，不只是背景资料。必须按文档指定链路执行，不得擅自改写成泛搜索。文档指定了原始 URL 时应直接核验该 URL：普通可读正文用 web_fetch；需要 HTML 标记、脚本内嵌 JSON、ID 或时间戳时用 web_source，并可用 find 定位文档要求的标记。',
    '本地目录按“确定范围 → 找到候选文件或命中位置 → 读取准确文件”执行：没有明确文件时先用 glob 确定候选，再用 grep 定位相关内容，最后 read 命中的文件；resources 已给出 @文件时范围已经确定，可以直接 read。不要先读取一批无关文件，也不要把目录名当成内容关键词。',
    '网页按“明确外部对象 → 核验指定原始来源；没有指定来源时才搜索候选 → 核验可靠来源”执行，只在挂念确实依赖公开时效变化时使用。搜索词保留项目名、仓库名、版本或具体事件，去掉“关注、留意、帮我看看”等动作描述。web_search 只能用于发现候选，不能替代知识文档明确指定的原始页面，也不能把搜索摘要冒充原帖、发布说明或一手证据。',
    '若指定原始来源、解析链路或必要证据不可访问、抓取失败、没有命中文档要求的结构，必须严格采用知识文档约定的失败处理；没有特别约定时也应视为“未核到”，令 changed=false。不得换一组宽泛搜索词制造看似相关的结果。',
    '本地文件和知识库中的既有记录是基线，不是“新变化”。网页结果必须与基线比较；无法说明相对基线新增了什么时，changed 必须为 false。不要把本地项目问题、宽泛主题或普通关键词无差别丢给网页搜索。',
    '缺少可靠证据时继续按依据核验；可以通过当前正常命令工具使用 Node HTTP、代理、登录及 Cookie 保持完成连续流程。不得自行批准工具或改变 DSH 安全配置；遇到审批未通过、缺少环境能力或来源失败，返回 checkStatus=blocked，并在 evidence 中简述不含密码的具体原因。不得读取伙伴私有记忆与会话存储，不得修改检查依据。',
    'HTTP 环境判断：缺少 curl、python3 或独立 undici 包不等于没有 HTTP 客户端。指定 Node/HTTP 或代理链路时，通过已授权 bash 使用 node，先检查 process.version 和 require("node:http")、require("node:https")；这些是内置模块，不需要 npm 安装。Node 内置 fetch 不要求安装独立 undici，但不能假定 fetch 自动使用代理。使用当前环境实测能力，不根据其他机器或旧轮次猜测。',
    'Node 代理请求：目标为 HTTP 时，node:http.request 连接文档指定的 HTTP 代理 host/port，path 使用完整目标 URL，Host 使用目标 host；目标为 HTTPS 时，通过 HTTP 代理建立 CONNECT targetHost:443 隧道，再用 node:tls.connect({socket, servername:目标主机}) 保持证书校验并发送 HTTPS 请求。不要把 HTTPS URL 当普通 HTTP 代理路径，不禁用 TLS 校验，不绕过指定代理。设置请求超时、响应大小上限，处理状态码、压缩正文和有限重定向；不要向不同来源转发账号、Cookie 或 Authorization。登录/Cookie 和解析步骤仍按依据执行。模块缺失、网络失败和目标正文缺少时间线结构是不同问题，按实际错误报告；仅代理连通或 HTTP 200 不代表已核到目标数据。不得自行安装依赖或绕过命令审批。',
    'recordTarget.kind=file 时用 read 读取 recordTarget.path 作为记录基线；kind=note 时用 heartbeat_record_note(concernId, operation=read) 分页读取。用户在 subject/reason 中指定的记录格式、章节和更新方式随完整核验结果暂存，未指定则沿用现有结构，不默认追加整份报告。独立同步阶段只能整理所选目标，保留人工内容；不能创建、删除、重命名或移动记录目标，也不能换写到依据或其他文件。',
    '只有相对既有状态真正新增的事实、进展、风险、等待条件变化或可执行机会，changed 才是 true。旧信息、普通关键词命中、无关资料和无法核实的猜测都必须是 false。',
    '如果关联的知识文档明确规定了“什么条件需要主动提醒”或“什么条件暂不提醒”，必须把本轮证据与该规则逐项核对。确实命中主动提醒条件时令 notificationRuleEffect="notify"；明确命中抑制条件或尚未达到文档规定的提醒条件时令其为 "suppress"；文档没有明确提醒规则时只能使用 "auto"。notificationRuleReason 必须简述文档规则与本轮证据的对应关系，不能根据普通关注理由自行创造规则。',
    `本轮观察时间：${observedAt}。你还要为每个挂念独立决定下一次检查间隔 nextCheckInMinutes。根据对象的变化速度、明确等待条件、信息源成本、当前证据与最近是否有变化来安排；即使 changed=false 也必须给出。最少 30 分钟，最多 43200 分钟（30 天）。临近事件或高频变化通常可用 30～180 分钟，普通项目变化可用 360～1440 分钟，低频等待可用 4320～43200 分钟。不要让所有挂念机械地使用相同间隔。`,
    '最后只输出一个 JSON 对象，不要 Markdown、寒暄或通知文案。格式：',
    '{"observations":[{"concernId":"必须来自本轮挂念 id","checkStatus":"completed 或 blocked","changed":false,"event":"新变化的简洁结论；无变化时留空","evidence":"支持判断的关键证据；无变化时可简述检查结果","source":"来源名称或位置","relevance":0.0,"confidence":0.0,"actionability":0.0,"nextCheckInMinutes":360,"notificationRuleEffect":"auto","notificationRuleReason":""}]}',
    '每个挂念恰好返回一项。checkStatus 必须是 completed 或 blocked；拿到并核实目标数据才是 completed；登录失败、只到登录页、缺少权限或必须步骤未执行都是 blocked，不得当作无变化。评分范围 0 到 1；nextCheckInMinutes 使用整数分钟。你只负责语义判断与下次检查节奏，是否提醒由确定性策略另行决定。',
  ].join('\n')
}
