import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext, ToolRuntime } from '@deepseek-ai/dsh-tools'
import { record, requiredText } from '../core/validation.js'
import type { Companion } from '../domain.js'
import type { EphemeralExecutionService } from '../execution/service.js'
import type { PartnerStore } from '../store.js'
import type { SkillService } from '../skills/service.js'
import { renderEnabledSkills } from '../skills/service.js'
import type { TaskBoardService } from '../tasks/service.js'
import type { PartnerSchedulerService } from '../scheduler/service.js'
import type { PartnerCollaborationService } from './service.js'

type AgentCompositionContext = Context & { tools: ToolRuntime }

/** Composes partner-only tools into one agent scope. No global tool is registered. */
export class PartnerAgentComposition {
  constructor(
    private readonly store: PartnerStore,
    private readonly skills: SkillService,
    private readonly tasks: TaskBoardService,
    private readonly collaboration: PartnerCollaborationService,
    private readonly scheduler: PartnerSchedulerService,
    private readonly executor: EphemeralExecutionService,
  ) {}

  compose(ctx: AgentCompositionContext, companion: Companion): void {
    const enabledSkills = this.skills.bindings(companion.id)
    if (companion.capabilities.includes('skills')) ctx.tools.register(skillTool(companion, this.skills, this.executor))
    ctx.tools.register(taskTool(companion, this.tasks, this.collaboration))
    ctx.tools.register(collaborationTool(companion, this.store, this.collaboration))
    ctx.tools.register(scheduleTool(companion, this.scheduler))
    const directory = this.collaboration.directoryFor(companion.id)
    ctx.systemPrompt.section({
      name: 'partner-collaboration', order: -7,
      text: [
        renderEnabledSkills(companion, enabledSkills),
        '你可以使用伙伴看板维护工作。只有下面明确列出的授权伙伴可被你查看公开能力、分配或委派；用户本人在管理台直接指派伙伴不受此伙伴间授权限制。用户以“@伙伴名”要求协作时，先在授权目录解析稳定 id，再创建或选定看板任务并真实委派，不得只口头声称对方会处理。',
        '是否拆成看板任务由工作形态决定：只有工作跨多步、需要并行、需要等待外部条件、存在明确前置依赖、需要其他伙伴专长，或必须跨会话持续跟踪时才建任务。一次回答内可直接完成的简单事项不要制造看板负担。拆解后每个子任务必须有可验收产出；存在先后关系时写入 dependencyTaskIds，前置任务完成前不得启动后续任务。执行者提交结果后进入 review；指定验收伙伴时由其给出核验意见，最终通过或打回后再推进后续任务。完成全部拆解与委派后，立即向用户返回任务、负责人、依赖和验收安排的看板摘要；不要轮询状态或等待被委派任务执行结束，终态进度会反向通知你。',
        directory.length > 0 ? `已授权伙伴：${directory.map(item => `@${item.name}（${item.role}；能力：${item.capabilities.join('、') || '未声明'}；Skill：${item.enabledSkills.map(skill => skill.name).join('、') || '无'}；${item.availability}）`).join('；')}` : '当前没有授权你访问的其他伙伴；你仍可读写共享看板和维护自己的任务。',
        '伙伴间只共享公开身份、公开能力、任务信封与结果摘要，不共享私有会话、凭据、长期记忆或渠道内容。',
      ].filter(Boolean).join('\n\n'),
    })
  }
}

function skillTool(companion: Companion, skills: SkillService, executor: EphemeralExecutionService): ToolDefinition {
  return textTool({
    name: 'partner_skill',
    description: 'List, load, or execute Skills enabled for this companion. Use load only for trusted inline Skills; execute fork Skills in a temporary session. A Skill never grants tools outside current DSH permissions.',
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
    description: 'Read and maintain the shared partner task board. Use it for multi-step, dependent, delegated, or cross-session work; do not create tasks for trivial one-turn answers. Dependencies block execution until done, and completed work must pass review.',
    parameters: actionParameters(['list', 'create', 'update', 'comment', 'accept', 'reject'], {
      taskId: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' },
      status: { type: 'string', enum: ['backlog', 'ready', 'doing', 'review', 'done', 'blocked'] },
      priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
      assignee: { type: 'string', description: 'Companion id or @name.' }, reviewer: { type: 'string', description: 'Optional reviewer companion id or @name.' },
      dependencyTaskIds: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'Tasks that must be done before this task can start.' },
      expectedRevision: { type: 'integer' }, message: { type: 'string' },
    }),
    async execute(raw, exec) {
      const input = record(raw, 'arguments')
      const action = requiredText(input.action, 'action', 20)
      if (action === 'list') return JSON.stringify(tasks.snapshot())
      if (action === 'create') {
        const assignee = typeof input.assignee === 'string' && input.assignee.trim() ? resolveAssignee(input.assignee) : undefined
        const reviewer = typeof input.reviewer === 'string' && input.reviewer.trim() ? resolveAssignee(input.reviewer) : undefined
        return JSON.stringify(await tasks.create({
          ...input,
          creatorSessionId: requireAgent(exec).session.id,
          ...(assignee ? { assigneeCompanionId: assignee } : {}),
          ...(reviewer ? { reviewerCompanionId: reviewer } : {}),
        }, { kind: 'companion', companionId: companion.id }))
      }
      const taskId = requiredText(input.taskId, 'taskId', 160)
      if (action === 'comment') { await tasks.comment(taskId, requiredText(input.message, 'message', 2000), { kind: 'companion', companionId: companion.id }); return JSON.stringify({ ok: true }) }
      if (action === 'accept' || action === 'reject') {
        const task = tasks.require(taskId)
        if (task.assigneeCompanionId === companion.id) throw new Error('任务负责人不能验收自己的执行结果')
        if (task.reviewerCompanionId && task.reviewerCompanionId !== companion.id) throw new Error('当前伙伴不是这个任务指定的验收伙伴')
        return JSON.stringify(action === 'accept'
          ? await tasks.accept(taskId, { kind: 'companion', companionId: companion.id })
          : await tasks.reject(taskId, requiredText(input.message, 'message', 1200), { kind: 'companion', companionId: companion.id }))
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
    description: 'Inspect the safe companion directory or asynchronously delegate an existing board task to @another companion. Delegate returns as soon as assignment is queued; progress and results flow through the board and notify the creator companion. It never exposes private transcripts or credentials.',
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
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
  }
}

function actionParameters(actions: string[], properties: Record<string, unknown>) {
  return {
    type: 'object' as const, additionalProperties: false,
    properties: { action: { type: 'string', enum: actions }, ...properties }, required: ['action'],
  }
}

function requireAgent(exec: ToolRunContext) {
  if (!exec.agent) throw new Error('Partner tool requires an active companion agent')
  return exec.agent
}
