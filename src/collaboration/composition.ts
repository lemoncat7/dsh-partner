import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext, ToolRuntime } from '@deepseek-ai/dsh-tools'
import { optionalBoolean, record, requiredText } from '../core/validation.js'
import type { Companion } from '../domain.js'
import type { CompanionCapability } from '../capabilities.js'
import type { EphemeralExecutionService } from '../execution/service.js'
import type { PartnerStore } from '../store.js'
import type { SkillService } from '../skills/service.js'
import { renderEnabledSkills } from '../skills/service.js'
import type { LoadedSkill } from '../skills/domain.js'
import type { TaskBoardService } from '../tasks/service.js'
import type { PartnerSchedulerService } from '../scheduler/service.js'
import type { PartnerCollaborationService } from './service.js'
import type { CompanionService } from '../companions/service.js'
import type { CompanionManagementService } from '../companions/management.js'
import type { CompanionKnowledgeMounts } from '../companions/knowledge-mounts.js'
import { companionManagementTool, COMPANION_MANAGEMENT_PROMPT } from '../companions/management-tool.js'
import { RequirementService } from '../requirements/service.js'
import { requirementTool } from '../requirements/tool.js'
import { TaskWorkflowError } from '../tasks/workflow-error.js'

type AgentCompositionContext = Context & { tools: ToolRuntime }
const MAX_INLINE_SKILLS = 8
const MAX_INLINE_SKILL_CHARS = 32_000

/** Composes partner-only tools into one agent scope. No global tool is registered. */
export class PartnerAgentComposition {
  constructor(
    private readonly store: PartnerStore,
    private readonly skills: SkillService,
    private readonly tasks: TaskBoardService,
    private readonly collaboration: PartnerCollaborationService,
    private readonly scheduler: PartnerSchedulerService,
    private readonly executor: EphemeralExecutionService,
    private readonly companions: CompanionService,
    private readonly management?: CompanionManagementService,
    private readonly knowledgeMounts?: CompanionKnowledgeMounts,
    private readonly requirements = new RequirementService(store),
  ) {}

  async compose(ctx: AgentCompositionContext, companion: Companion): Promise<() => void> {
    const skillsEnabled = companion.capabilities.includes('skills')
    const enabledSkills = skillsEnabled ? this.skills.bindings(companion.id) : []
    const inlineSkills = await loadInlineSkills(this.skills, enabledSkills)
    const injectedSkillIds = new Set(inlineSkills.map(skill => skill.id))
    const disposers: Array<() => void> = []
    const register = (tool: ToolDefinition, capability: CompanionCapability): void => {
      disposers.push(ctx.tools.register({ ...tool, execute: async (args, execution) => {
        // Old schemas must not authorize calls after a saved revocation.
        if (!this.store.hasCapability(companion.id, capability)) throw new Error(`伙伴的 ${capability} 能力已撤回，当前调用未执行`)
        return tool.execute(args, execution)
      } }))
    }
    try {
      if (skillsEnabled) register(skillTool(companion, this.skills, this.executor), 'skills')
      if (companion.capabilities.includes('companions')) register(companionTool(this.companions), 'companions')
      if (companion.capabilities.includes('access')) register(accessGrantTool(companion, this.collaboration), 'access')
      if (companion.capabilities.includes('administration')) {
        if (!this.management || !this.knowledgeMounts) throw new Error('伙伴管理服务尚未就绪')
        register(companionManagementTool(companion.id, this.management, this.knowledgeMounts), 'administration')
      }
      disposers.push(ctx.tools.register(taskTool(companion, this.tasks, this.collaboration)))
      disposers.push(ctx.tools.register(requirementTool(companion.id, this.requirements, this.tasks)))
      disposers.push(ctx.tools.register(collaborationTool(companion, this.store, this.collaboration)))
      if (companion.capabilities.includes('schedules')) register(scheduleTool(companion, this.scheduler), 'schedules')
      const directory = this.collaboration.directoryFor(companion.id)
      disposers.push(ctx.systemPrompt.section({
        name: 'partner-collaboration', order: -7,
        text: [
        renderEnabledSkills(companion, enabledSkills, injectedSkillIds),
        companion.capabilities.includes('companions') ? '你拥有“创建伙伴”能力。只有用户明确要求创建新伙伴，或用户的当前需求明确要求建立一个长期独立身份时，才可调用 partner_companions；创建时必须填写清晰的身份、职责与行为准则。新伙伴不会自动获得任何能力、记忆、心跳或协作权限。若你另获伙伴管理能力，可在创建后按用户明确要求配置身份与能力；否则由用户在管理台单独授权。' : '',
        companion.capabilities.includes('administration') ? COMPANION_MANAGEMENT_PROMPT : '',
        companion.capabilities.includes('access') ? '你拥有“伙伴授权”能力。只有用户明确要求时，才可配置某个伙伴访问另一个伙伴的单向关系；如果用户要求你创建伙伴并同时说明它应访问谁，创建成功后应继续完成授权，不必等待用户再次提醒。不得推断、扩大或双向化用户没有要求的权限。' : '',
        companion.capabilities.includes('schedules') ? '你拥有“定时任务”能力。只有用户明确要求未来某个时间或按周期执行时，才创建 partner_schedule；普通待办、当前轮次工作和一次性立即执行不能擅自改成定时任务。' : '',
        '你可以使用伙伴看板维护工作。只有下面明确列出的授权伙伴可被你查看公开能力、分配或委派；用户本人在管理台直接指派伙伴不受此伙伴间授权限制。用户以“@伙伴名”要求协作时，先在授权目录解析稳定 id，再创建或选定看板任务并真实委派，不得只口头声称对方会处理。',
        '收到需求时主动应用用途匹配的已启用 Skill，不必等待用户再次点名触发。未启用的 Skill 不作为指令注入，也不自动开启。',
        '看板工具语义：partner_task_board create 指定 assignee 后默认 autoRun=true，任务持久化后进入执行队列；dependencyTaskIds 全部验收为 done 后才启动。autoRun=false 只保存规划、不执行。为已有任务提交执行使用 partner_collaborate delegate。工具返回 submitted/queued 仅表示已提交/排队，不表示完成。',
        '看板状态协议：执行结果进入 review，由验收者 accept 或 reject；任务终态内部通知创建者，后续任务自动接续。执行、重试、待验收和返工不逐项通知渠道。仅当需求只剩已完成/受阻任务且没有排队执行时统一汇报成果和阻塞，不以归档为前提；只要还有收集箱、待开始、执行中或待验收就不发阶段通知。确认完整范围且全部任务完成后汇总归档。需求变更用 partner_requirements update，具体任务变更用 partner_task_board update；打回必须填写明确缺项和修正要求，并针对实际读取的 expectedRevision 决策。',
        directory.length > 0 ? `已授权伙伴：${directory.map(item => `@${item.name}（id: ${item.id}；${item.role}；职责：${item.description || '见角色'}；能力：${item.capabilities.join('、') || '未声明'}；Skill：${item.enabledSkills.map(skill => skill.name).join('、') || '无'}；${item.availability}）`).join('；')}` : '当前没有授权你访问的其他伙伴；你仍可读写共享看板和维护自己的任务。',
        `你自己的伙伴 id：${companion.id}。`,
        '伙伴间只共享公开身份、公开能力、任务信封与结果摘要，不共享私有会话、凭据、长期记忆或渠道内容。',
        ].filter(Boolean).join('\n\n'),
      }))
      if (inlineSkills.length > 0) disposers.push(ctx.systemPrompt.section({
        name: 'partner-inline-skills', order: -6,
        text: [
          '以下是已启用且经校验的可信 inline Skill 指令。每次接到需求先对照其用途；明确点名或用途匹配时必须主动应用，不需要用户再说触发词，也无需重复调用 partner_skill load。采用时用一句话说明所用 Skill 与对应产出，后续落实为真实工具操作；不匹配时不要强行套用。伙伴 Skill 与原生 skill 工具是不同目录，禁止用原生 skill(name=...) 加载这里的技能；需要读取时使用 partner_skill load。',
          ...inlineSkills.map(skill => `<partner-inline-skill id="${skill.id}" name="${skill.displayName}">\n${skill.body}\n</partner-inline-skill>`),
        ].join('\n\n'),
      }))
    } catch (error) {
      disposeAll(disposers)
      throw error
    }
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      disposeAll(disposers)
    }
  }
}

function accessGrantTool(companion: Companion, collaboration: PartnerCollaborationService): ToolDefinition {
  return textTool({
    name: 'partner_access_grants',
    description: 'List or administer directed access relationships between companions. A grant means the grantee may access the target companion public identity, capabilities, task envelopes, and result summaries. Change relationships only on an explicit user request; never infer extra or reciprocal grants.',
    parameters: actionParameters(['list', 'grant', 'revoke'], {
      grantee: { type: 'string', description: 'Companion id or @name that should gain or lose access. Required for grant and revoke.' },
      target: { type: 'string', description: 'Companion id or @name the grantee should be allowed or forbidden to access. Required for grant and revoke.' },
    }),
    presentCall: args => ({ card: 'generic', title: `伙伴授权 · ${typeof (args as { action?: unknown }).action === 'string' ? (args as { action: string }).action : '操作'}` }),
    async execute(raw) {
      const input = record(raw, 'arguments')
      const action = requiredText(input.action, 'action', 20)
      if (action === 'list') {
        const directory = collaboration.directory()
        const byId = new Map(directory.map(item => [item.id, item]))
        return JSON.stringify({
          companions: directory.map(item => ({ id: item.id, name: item.name, role: item.role })),
          grants: collaboration.accessGrants().map(grant => ({
            granteeId: grant.fromCompanionId, grantee: byId.get(grant.fromCompanionId)?.name ?? grant.fromCompanionId,
            targetId: grant.toCompanionId, target: byId.get(grant.toCompanionId)?.name ?? grant.toCompanionId,
          })),
        })
      }
      const grantee = collaboration.resolveCompanion(requiredText(input.grantee, 'grantee', 160))
      const target = collaboration.resolveCompanion(requiredText(input.target, 'target', 160))
      if (grantee.id === target.id) throw new Error('伙伴不能获得访问自己的授权')
      const targets = new Set(collaboration.accessTargetIds(grantee.id))
      if (action === 'grant') targets.add(target.id)
      else if (action === 'revoke') targets.delete(target.id)
      else throw new Error('Partner access action is invalid')
      await collaboration.updateAccessTargets(grantee.id, [...targets])
      return JSON.stringify({ managedBy: companion.name, granteeId: grantee.id, grantee: grantee.name, targetId: target.id, target: target.name, authorized: action === 'grant' })
    },
  })
}

function disposeAll(disposers: Array<() => void>): void {
  for (let index = disposers.length - 1; index >= 0; index -= 1) disposers[index]?.()
}

async function loadInlineSkills(service: SkillService, enabled: ReturnType<SkillService['bindings']>): Promise<LoadedSkill[]> {
  const loaded: LoadedSkill[] = []
  let characters = 0
  for (const metadata of enabled) {
    if (!metadata.trusted || metadata.executionContext !== 'inline' || loaded.length >= MAX_INLINE_SKILLS) continue
    const skill = await service.load(metadata.id).catch(() => undefined)
    if (!skill || characters + skill.body.length > MAX_INLINE_SKILL_CHARS) continue
    loaded.push(skill)
    characters += skill.body.length
  }
  return loaded
}

function companionTool(companions: CompanionService): ToolDefinition {
  return textTool({
    name: 'partner_companions',
    description: 'Create a new long-lived companion identity only when the user explicitly requests one. The new companion starts with no capabilities, memory, heartbeat, channel, or collaboration grants.',
    parameters: actionParameters(['create'], {
      name: { type: 'string', description: 'Companion display name.' },
      role: { type: 'string', description: 'The companion\'s durable role.' },
      description: { type: 'string', description: 'A concise identity and responsibility summary.' },
      instructions: { type: 'string', description: 'Durable behavior, boundaries, work style, and delivery expectations.' },
    }, ['name', 'role', 'description', 'instructions']),
    presentCall: () => ({ card: 'generic', title: '创建伙伴' }),
    async execute(raw) {
      const input = record(raw, 'arguments')
      if (requiredText(input.action, 'action', 20) !== 'create') throw new Error('Companion action is invalid')
      const companion = await companions.create({
        name: requiredText(input.name, 'name', 60),
        role: requiredText(input.role, 'role', 120),
        description: requiredText(input.description, 'description', 500),
        instructions: requiredText(input.instructions, 'instructions', 12_000),
      })
      return JSON.stringify({
        id: companion.id,
        name: companion.name,
        role: companion.role,
        description: companion.description,
        instructions: companion.instructions,
        capabilities: companion.capabilities,
        memoryEnabled: companion.automation.memory.enabled,
        heartbeatEnabled: companion.automation.heartbeat.enabled,
      })
    },
  })
}

function skillTool(companion: Companion, skills: SkillService, executor: EphemeralExecutionService): ToolDefinition {
  return textTool({
    name: 'partner_skill',
    description: 'List, load, or execute Skills enabled for this companion. For an actual work request that may match an authorized companion specialty, proactively apply the enabled task-planning Skill to decide assignment and decomposition, then use partner_task_board and partner_collaborate for real delegation; do not wait for the user to name the Skill or @ a companion. Follow already-injected inline instructions directly; use load only when trusted inline instructions are not yet available, and execute fork Skills in a temporary session. Partner Skills belong to partner_skill, not the native skill tool: never call skill(name="task-planning") for this catalog. A Skill never grants tools outside current DSH permissions.',
    parameters: actionParameters(['list', 'load', 'run'], {
      skillId: { type: 'string', description: 'Installed Skill id.' },
      input: { type: 'string', description: 'Concrete task or arguments for the Skill.' },
    }),
    timeoutMs: 15 * 60_000,
    presentCall: args => ({ card: 'generic', title: `伙伴 Skill · ${typeof (args as { action?: unknown }).action === 'string' ? (args as { action: string }).action : '操作'}` }),
    async execute(raw, exec) {
      const input = record(raw, 'arguments')
      const action = requiredText(input.action, 'action', 20)
      const enabled = skills.bindings(companion.id)
      if (action === 'list') return JSON.stringify(enabled.map(skill => ({ id: skill.id, name: skill.displayName, description: skill.description, version: skill.version, context: skill.executionContext })))
      const skillId = requiredText(input.skillId, 'skillId', 120)
      if (!enabled.some(item => item.id === skillId)) throw new Error('Skill is not enabled for this companion')
      const skill = await skills.load(skillId)
      if (action === 'load') {
        if (skill.executionContext !== 'inline' || !skill.trusted) throw new Error('This Skill must run in an isolated temporary session')
        return JSON.stringify({ id: skill.id, instructions: skill.body, allowedTools: skill.allowedTools })
      }
      if (action !== 'run') throw new Error('Skill action is invalid')
      const result = await executor.execute({
        kind: 'skill', sourceId: skill.id, companion, parentSessionId: requireAgent(exec).session.id,
        prompt: requiredText(input.input, 'input', 12_000), allowedTools: skill.allowedTools, destroyAfterRun: true,
        systemInstruction: `严格按照以下 Skill 执行。Skill 的 allowed-tools 只能收缩权限；工具不可用时明确说明，不得模拟结果。\n\n${skill.body}`,
      })
      return JSON.stringify({ runId: result.run.id, result: result.output })
    },
  })
}

function taskTool(companion: Companion, tasks: TaskBoardService, collaboration: PartnerCollaborationService): ToolDefinition {
  const resolveAssignee = (value: string): string => {
    const target = collaboration.resolveCompanion(value)
    if (target.id !== companion.id && !collaboration.canAccess(companion.id, target.id)) throw new Error(`当前伙伴未获授权访问 @${target.name}`)
    return target.id
  }
  return textTool({
    name: 'partner_task_board',
    description: 'Turn requested deliverables into actual work assigned to self or authorized specialist companions; this board is not merely a log to fill after doing everything yourself. When the request matches an authorized companion specialty, proactively apply the enabled task-planning Skill and connect the requested outcome, suitable assignee and board task before carrying out the work; no explicit @ or board request is needed. The Skill defines decomposition and exceptions. List, create, update, comment on, accept or reject tasks. Creating with assignee submits execution automatically, including dependency waiting; set autoRun=false to save without execution. Submitted/queued is not completion. Every create must include requirementId. Continued work uses the original requirement: list to find it, reopen submitted/archived scope if necessary, then append. Never create another requirement merely because a different specialist takes the next phase. dependencyTaskIds controls ordering, not ownership. Only a separate user goal warrants a new requirement. Child execution and review are internal: stage notification waits until only done/blocked tasks remain, and does not require archiving. For changed task specifications use update, not only comment; for changed whole scope use partner_requirements update. reject must state concrete missing items and corrections; accept/reject must use the revision actually reviewed. Executors receive latest scope, recent comments, rejection reasons and previous deliverables on rework. Remove permanently deletes only on explicit user request, stops execution and pauses dependents. Accepted dependencies unlock queued tasks automatically.',
    parameters: actionParameters(['list', 'create', 'update', 'comment', 'accept', 'reject', 'request_replan', 'remove'], {
      reworkMode: { type: 'string', enum: ['rework', 'replan'], description: 'reject only: rework continues ordinary corrections; replan pauses for owner reassignment/splitting or missing tools. Three consecutive rejections automatically pause.' },
      taskId: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' },
      requirementId: { type: 'string', description: 'REQUIRED for create. Reuse the existing requirement for continued work on the same deliverable, including later specialist phases. dependencyTaskIds does not set ownership. Missing id fails without creating anything. Query partner_requirements list; reopen a submitted/archived requirement before appending; create a requirement only for a genuinely separate user goal.' },
      status: { type: 'string', enum: ['backlog', 'ready', 'doing', 'review', 'done', 'blocked'] },
      priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
      assignee: { type: 'string', description: 'Companion id or @name.' }, reviewer: { type: 'string', description: 'Optional reviewer companion id or @name.' },
      autoRun: { type: 'boolean', description: 'Default true on create with assignee (except explicit backlog). Persist execution intent and start after dependencies are accepted. Set false when user requests planning only; legacy tasks are never auto-started.' },
      dependencyTaskIds: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'Tasks that must be done before this task can start.' },
      expectedRevision: { type: 'integer', description: 'Required for update, accept, reject and request_replan. Use the revision actually reviewed; if stale, reread latest requirements and results.' }, message: { type: 'string', description: 'For request_replan: concrete missing tools, required reassignment/splitting and preserved output. This pauses/cancels the current task; stop this turn afterward. For reject: missing evidence and corrections; use reworkMode=replan for inability to execute.' },
    }),
    async execute(raw, exec) {
      const input = record(raw, 'arguments')
      const action = requiredText(input.action, 'action', 20)
      if (action === 'list') return JSON.stringify(tasks.snapshot())
      if (action === 'create') {
        const assignee = typeof input.assignee === 'string' && input.assignee.trim() ? resolveAssignee(input.assignee) : undefined
        const reviewer = typeof input.reviewer === 'string' && input.reviewer.trim() ? resolveAssignee(input.reviewer) : undefined
        const autoRun = optionalBoolean(input.autoRun, Boolean(assignee) && input.status !== 'backlog')
        const task = await tasks.create({
          ...input,
          autoRun,
          creatorSessionId: requireAgent(exec).session.id,
          ...(assignee ? { assigneeCompanionId: assignee } : {}),
          ...(reviewer ? { reviewerCompanionId: reviewer } : {}),
        }, { kind: 'companion', companionId: companion.id }, true)
        let dispatchWarning: string | undefined
        if (autoRun) {
          try { await collaboration.dispatchReadyTasks() }
          catch { dispatchWarning = '任务已保存，执行提交将在后台重试；不要重复创建任务' }
        }
        const snapshot = tasks.snapshot()
        const requirement = snapshot.requirements?.find(item => item.id === task.requirementId)
        const currentTask = snapshot.tasks.find(item => item.id === task.id)
        if (!currentTask) return JSON.stringify({ taskId: task.id, status: 'removed', message: '任务已删除，不要重复创建' })
        return JSON.stringify({ ...currentTask, execution: autoRun ? 'submitted' : 'planning-only',
          ...(requirement ? { requirement: { id: requirement.id, revision: requirement.revision, controlRevision: requirement.controlRevision, status: requirement.status } } : {}),
          ...(dispatchWarning ? { dispatchWarning } : {}) })
      }
      const taskId = requiredText(input.taskId, 'taskId', 160)
      const existing = tasks.snapshot().tasks.find(task => task.id === taskId)
      if (!existing) return JSON.stringify({ taskId, status: 'removed', message: '任务已删除或不存在，停止处理旧任务，不要重建' })
      if (action === 'request_replan') {
        if (!Number.isInteger(input.expectedRevision)) throw new Error('请先 list 读取任务，并提供 expectedRevision')
        const task = await tasks.requestReplan(taskId, requiredText(input.message, 'message', 1200), { kind: 'companion', companionId: companion.id }, input.expectedRevision as number)
        return JSON.stringify({ ...task, recovery: '已暂停并取消旧执行，等待需求负责人调整；结束本轮，不要继续转派同一任务或反复重试。' })
      }
      if (action === 'remove') {
        if (existing.creatorCompanionId !== companion.id) throw new Error('只能删除自己创建的任务；删除必须有用户明确要求')
        await tasks.remove(taskId); return JSON.stringify({ taskId, removed: true })
      }
      if (action === 'comment') { await tasks.comment(taskId, requiredText(input.message, 'message', 2000), { kind: 'companion', companionId: companion.id }); return JSON.stringify({ ok: true }) }
      if (action === 'accept' || action === 'reject') {
        if (input.reworkMode !== undefined && !['rework', 'replan'].includes(String(input.reworkMode))) throw new Error('reworkMode 无效')
        if (!Number.isInteger(input.expectedRevision)) throw new Error('验收必须提供实际核验的 expectedRevision；请先查询最新任务、补充评论和交付后再决定')
        const task = tasks.require(taskId)
        if (task.reviewerCompanionId && task.reviewerCompanionId !== companion.id) throw new Error('当前伙伴不是这个任务指定的验收伙伴')
        return JSON.stringify(action === 'accept'
          ? await tasks.accept(taskId, { kind: 'companion', companionId: companion.id }, input.expectedRevision as number)
          : await tasks.reject(taskId, requiredText(input.message, 'message', 1200), { kind: 'companion', companionId: companion.id }, input.expectedRevision as number, input.reworkMode as 'rework' | 'replan' | undefined))
      }
      if (action === 'update') {
        const assignee = typeof input.assignee === 'string' && input.assignee.trim() ? resolveAssignee(input.assignee) : undefined
        const reviewer = typeof input.reviewer === 'string' && input.reviewer.trim() ? resolveAssignee(input.reviewer) : undefined
        return JSON.stringify(await tasks.update(taskId, {
          ...input,
          ...('assignee' in input ? { assigneeCompanionId: assignee ?? '' } : {}),
          ...('reviewer' in input ? { reviewerCompanionId: reviewer ?? '' } : {}),
        }, { kind: 'companion', companionId: companion.id }))
      }
      throw new Error('Task board action is invalid')
    },
  })
}

function collaborationTool(companion: Companion, store: PartnerStore, collaboration: PartnerCollaborationService): ToolDefinition {
  return textTool({
    name: 'partner_collaborate',
    description: 'Connect a work request with authorized companion specialties and real board delegation, not just a contact lookup. Use directory when specialty or authorization information is missing or stale; proactively match the requested deliverable to the authorized directory instead of defaulting to doing it yourself because execution tools are available. Apply the enabled task-planning Skill for assignment, decomposition and exceptions. Create assigned work through partner_task_board, or use delegate for an existing task; do not duplicate already-assigned work. Dependencies may still be pending: the durable queue starts work after accepted prerequisites. Repeated submission to the same assignee returns its pending job. Returns without waiting for execution; progress notifies the creator. Never exposes private transcripts or credentials.',
    parameters: actionParameters(['directory', 'delegate', 'status'], {
      taskId: { type: 'string' }, companion: { type: 'string', description: 'Target companion id or @name.' }, request: { type: 'string' }, delegationId: { type: 'string' },
    }),
    timeoutMs: 15 * 60_000,
    async execute(raw, exec) {
      const input = record(raw, 'arguments')
      const action = requiredText(input.action, 'action', 20)
      if (action === 'directory') return JSON.stringify(collaboration.directoryFor(companion.id))
      if (action === 'status') {
        const id = requiredText(input.delegationId, 'delegationId', 160)
        const value = store.snapshot().delegations.find(item => item.id === id && (item.fromCompanionId === companion.id || item.toCompanionId === companion.id))
        if (!value) throw new Error('Delegation does not exist')
        return JSON.stringify(value)
      }
      if (action !== 'delegate') throw new Error('Collaboration action is invalid')
      const result = await collaboration.delegate({
        taskId: requiredText(input.taskId, 'taskId', 160), initiatedBy: 'companion', fromCompanionId: companion.id,
        to: requiredText(input.companion, 'companion', 160), request: requiredText(input.request, 'request', 8000),
        parentSessionId: requireAgent(exec).session.id,
      })
      return JSON.stringify(result)
    },
  })
}

function scheduleTool(companion: Companion, scheduler: PartnerSchedulerService): ToolDefinition {
  return textTool({
    name: 'partner_schedule',
    description: 'Create and manage this companion\'s scheduled temporary-session work. Schedules support interval or daily time, skip/queue overlap, and optional session retention.',
    parameters: actionParameters(['list', 'create', 'update', 'delete', 'run'], {
      scheduleId: { type: 'string' }, title: { type: 'string' }, prompt: { type: 'string' },
      schedule: { type: 'object', description: '{kind:"interval",minutes} or {kind:"daily",hour,minute}' },
      enabled: { type: 'boolean' }, destroySessionAfterRun: { type: 'boolean' }, overlapPolicy: { type: 'string', enum: ['skip', 'queue'] }, timeoutMinutes: { type: 'integer' },
    }),
    timeoutMs: 15 * 60_000,
    async execute(raw) {
      const input = record(raw, 'arguments')
      const action = requiredText(input.action, 'action', 20)
      if (action === 'list') return JSON.stringify(scheduler.list().filter(item => item.companionId === companion.id))
      if (action === 'create') return JSON.stringify(await scheduler.create(input, companion.id))
      const id = requiredText(input.scheduleId, 'scheduleId', 160)
      const owned = scheduler.list().find(item => item.id === id && item.companionId === companion.id)
      if (!owned) throw new Error('Schedule does not exist for this companion')
      if (action === 'update') return JSON.stringify(await scheduler.update(id, input))
      if (action === 'delete') { await scheduler.remove(id); return JSON.stringify({ ok: true }) }
      if (action === 'run') { await scheduler.trigger(id); return JSON.stringify({ ok: true }) }
      throw new Error('Schedule action is invalid')
    },
  })
}

function textTool(definition: Omit<ToolDefinition, 'output'>): ToolDefinition {
  return {
    ...definition,
    async execute(raw, exec) {
      try { return await definition.execute(raw, exec) }
      catch (error) {
        if (error instanceof TaskWorkflowError) return JSON.stringify(error.result())
        throw error
      }
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
  }
}

function actionParameters(actions: string[], properties: Record<string, unknown>, required: string[] = []) {
  return {
    type: 'object' as const, additionalProperties: false,
    properties: { action: { type: 'string', enum: actions }, ...properties }, required: ['action', ...required],
  }
}

function requireAgent(exec: ToolRunContext) {
  if (!exec.agent) throw new Error('Partner tool requires an active companion agent')
  return exec.agent
}
