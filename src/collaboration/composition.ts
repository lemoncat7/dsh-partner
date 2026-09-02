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
    ctx.tools.register(skillTool(companion, this.skills, this.executor))
    ctx.tools.register(taskTool(companion, this.tasks, this.collaboration))
    ctx.tools.register(collaborationTool(companion, this.store, this.collaboration))
    ctx.tools.register(scheduleTool(companion, this.scheduler))
    const directory = this.collaboration.directory().filter(item => item.id !== companion.id)
    ctx.systemPrompt.section({
      name: 'partner-collaboration', order: -7,
      text: [
        renderEnabledSkills(companion, enabledSkills),
        '你可以使用伙伴看板记录工作，并通过 partner_collaborate 将明确任务交给其他伙伴。用户以“@伙伴名”表达指派时，先在伙伴目录解析稳定 id，再创建或选定看板任务并委派；不得只口头声称对方会处理。',
        directory.length > 0 ? `可协作伙伴：${directory.map(item => `@${item.name}（${item.role}，${item.availability}）`).join('；')}` : '当前没有其他可协作伙伴。',
        '伙伴间只共享任务信封、公开能力与结果摘要，不共享私有会话、凭据或长期记忆。',
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
  return textTool({
    name: 'partner_task_board',
    description: 'Read and maintain the shared partner task board. Create concrete work, move status with expectedRevision, assign a companion, or append an auditable comment.',
    parameters: actionParameters(['list', 'create', 'update', 'comment'], {
      taskId: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' },
      status: { type: 'string', enum: ['backlog', 'ready', 'doing', 'review', 'done', 'blocked'] },
      priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
      assignee: { type: 'string', description: 'Companion id or @name.' }, expectedRevision: { type: 'integer' }, message: { type: 'string' },
    }),
    async execute(raw) {
      const input = record(raw, 'arguments')
      const action = requiredText(input.action, 'action', 20)
      if (action === 'list') return JSON.stringify(tasks.snapshot())
      if (action === 'create') {
        const assignee = typeof input.assignee === 'string' && input.assignee.trim() ? collaboration.resolveCompanion(input.assignee).id : undefined
        return JSON.stringify(await tasks.create({ ...input, ...(assignee ? { assigneeCompanionId: assignee } : {}) }, { kind: 'companion', companionId: companion.id }))
      }
      const taskId = requiredText(input.taskId, 'taskId', 160)
      if (action === 'comment') { await tasks.comment(taskId, requiredText(input.message, 'message', 2000), { kind: 'companion', companionId: companion.id }); return JSON.stringify({ ok: true }) }
      if (action === 'update') {
        const assignee = typeof input.assignee === 'string' ? collaboration.resolveCompanion(input.assignee).id : undefined
        return JSON.stringify(await tasks.update(taskId, { ...input, ...('assignee' in input ? { assigneeCompanionId: assignee ?? '' } : {}) }, { kind: 'companion', companionId: companion.id }))
      }
      throw new Error('Task board action is invalid')
    },
  })
}

function collaborationTool(companion: Companion, store: PartnerStore, collaboration: PartnerCollaborationService): ToolDefinition {
  return textTool({
    name: 'partner_collaborate',
    description: 'Inspect the safe companion directory or delegate an existing board task to @another companion. Delegation creates a real temporary execution and returns its result; it never exposes private transcripts or credentials.',
    parameters: actionParameters(['directory', 'delegate', 'status'], {
      taskId: { type: 'string' }, companion: { type: 'string', description: 'Target companion id or @name.' }, request: { type: 'string' }, delegationId: { type: 'string' },
    }),
    timeoutMs: 15 * 60_000,
    async execute(raw, exec) {
      const input = record(raw, 'arguments')
      const action = requiredText(input.action, 'action', 20)
      if (action === 'directory') return JSON.stringify(collaboration.directory())
      if (action === 'status') {
        const id = requiredText(input.delegationId, 'delegationId', 160)
        const value = store.snapshot().delegations.find(item => item.id === id)
        if (!value) throw new Error('Delegation does not exist')
        return JSON.stringify(value)
      }
      if (action !== 'delegate') throw new Error('Collaboration action is invalid')
      const result = await collaboration.delegate({
        taskId: requiredText(input.taskId, 'taskId', 160), fromCompanionId: companion.id,
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
