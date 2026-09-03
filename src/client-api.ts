export const PARTNER_API = '/partner-local/v1'

export type Capability = 'knowledge' | 'skills' | 'ssh' | 'git' | 'companions' | 'schedules' | 'access'
export interface AutomationView {
  memory: { enabled: boolean; retentionDays: number; provider?: string; model?: string; dailyReviewEnabled: boolean; dailyReviewHour: number }
  heartbeat: { enabled: boolean; intervalMinutes: number; quietStartHour: number; quietEndHour: number; dailyLimit: number }
}
export interface CompanionView {
  id: string; name: string; role: string; description: string; instructions: string
  presetId?: string; provider?: string; model?: string; capabilities: Capability[]
  createdAt: number; updatedAt: number
  automation: AutomationView
}
export interface ChannelView {
  id: string; companionId: string; accountId: string; name: string; enabled: boolean
  createdAt: number; updatedAt: number; runtimeStatus: 'stopped' | 'starting' | 'running' | 'error'
  lastError?: string; credentialConfigured: boolean
}
export interface PairingView {
  id: string; channelId: string; userId: string; displayName: string
  status: 'pending' | 'approved' | 'blocked'; createdAt: number; updatedAt: number
}
export interface ChannelSessionView {
  id: string; kind: 'local' | 'channel'; channelId: string; userId: string; companionId: string; sessionId: string; cwd?: string; lastMessageAt: number; archived: boolean
}
export interface HeartbeatStateView {
  companionId: string; lastCheckedAt?: number; lastSentAt?: number; nextCheckAt: number
  sentDay: string; sentCount: number; consecutiveFailures: number; lastError?: string
}
export type MemoryKindView = 'profile' | 'preference' | 'task' | 'event' | 'relationship' | 'emotion'
export interface MemoryEvidenceView { turnId: string; at: number; excerpt: string }
export interface MemoryView { id: string; scopeId: string; kind: MemoryKindView; subject: string; content: string; status: 'active' | 'completed' | 'superseded' | 'expired'; confidence: number; importance: number; updatedAt: number; locked?: boolean; evidence: MemoryEvidenceView[] }
export interface UserProfileSnapshotView { scopeId: string; label: string; version: string; updatedAt?: number; entries: MemoryView[]; evidenceCount: number; lockedCount: number }
export interface MemoryRelationView { id: string; scopeId: string; sourceMemoryId: string; targetMemoryId: string; kind: 'supports' | 'depends_on' | 'about' | 'conflicts_with' | 'follows'; label: string; confidence: number; updatedAt: number }
export interface MemoryGraphView { memories: MemoryView[]; relations: MemoryRelationView[] }
export interface DailyReflectionView { date: string; summary: string; events: string[]; openTasks: string[]; completedTasks: string[]; learnings: string[]; updatedAt: number; turnCount: number }
export interface ConcernView {
  id: string; subject: string; reason: string; origin: 'explicit' | 'implicit'; state: 'active' | 'watching' | 'snoozed' | 'resolved' | 'archived'
  priority: number; confidence: number; score: number; watchKind: 'auto' | 'knowledge' | 'workspace' | 'web'; updatedAt: number; nextCheckAt: number; lastCheckedAt?: number
  resources: Array<{ kind: 'file' | 'knowledge'; locator: string; label: string }>
}
export interface ConcernObservationView {
  id: string; concernId: string; event: string; evidence: string; source: string; interruptScore: number
  decision: 'drop' | 'remember' | 'defer' | 'feed' | 'notify'; notificationRuleEffect: 'auto' | 'notify' | 'suppress'
  notificationRuleReason: string; decisionReason: string; createdAt: number; mentionedAt?: number
}
export interface ConcernActivityView { concerns: ConcernView[]; observations: ConcernObservationView[] }
export interface ConcernSourceView { kind: 'file' | 'knowledge'; label: string; detail: string; token: string }
export interface PresetView { id: string; name: string; broken?: string }
export interface ModelCatalogView { providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>; defaultSelection: { provider: string; model: string } }
export interface PartnerSnapshot {
  companions: CompanionView[]; channels: ChannelView[]; pairings: PairingView[]; sessions: ChannelSessionView[]; heartbeatStates: HeartbeatStateView[]; presets: PresetView[]
}
export interface LoginView {
  id: string; companionId: string; phase: 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'error'
  qrContent?: string; accountId?: string; baseUrl?: string; error?: string; expiresAt: number
}

export interface SkillView {
  id: string; name: string; displayName: string; description: string; version: string
  source: 'builtin' | 'market' | 'local'; sourceId?: string; executionContext: 'inline' | 'fork'; trusted: boolean; updatedAt: number
}
export interface SkillBindingView { companionId: string; skillId: string; enabled: boolean }
export interface SkillMarketSourceView { id: string; name: string; kind: 'dsh-index' | 'clawhub' | 'loophub' | 'skillhub'; indexUrl: string; enabled: boolean; trusted: boolean; builtin?: boolean }
export interface MarketSkillView { id: string; name: string; description: string; version: string; tags: string[]; sourceId: string }
export interface SkillCatalogView { installed: SkillView[]; bindings: SkillBindingView[]; sources: SkillMarketSourceView[] }
export interface SkillMarketView { sources: SkillMarketSourceView[]; entries: MarketSkillView[]; errors: Array<{ sourceId: string; error: string }> }
export interface SkillMarketNetworkView { proxyUrl?: string }
export interface SkillMarketNetworkTestView { ok: true; latencyMs: number; sourceCount: number; entryCount: number }

export type BoardTaskStatusView = 'backlog' | 'ready' | 'doing' | 'review' | 'done' | 'blocked'
export interface BoardTaskView {
  id: string; title: string; description: string; status: BoardTaskStatusView; priority: 'low' | 'normal' | 'high' | 'urgent'
  assigneeCompanionId?: string; reviewerCompanionId?: string; createdBy: 'user' | 'companion' | 'schedule'; revision: number; createdAt: number; updatedAt: number; completedAt?: number
  skillIds: string[]; dependencyTaskIds: string[]; resultAbstract?: string; resultSummary?: string; reviewHandoff?: string; reviewSummary?: string; dueAt?: number
}
export interface TaskActivityView { id: string; taskId: string; actor: 'user' | 'companion' | 'schedule' | 'system'; actorCompanionId?: string; kind: string; message: string; at: number }
export interface TaskBoardView { tasks: BoardTaskView[]; activities: TaskActivityView[] }
export interface PartnerDirectoryEntryView { id: string; name: string; role: string; description: string; capabilities: string[]; enabledSkills: Array<{ id: string; name: string }>; availability: 'available' | 'busy' | 'offline' }
export interface PartnerDelegationView {
  id: string; kind?: 'task' | 'review'; taskId: string; toCompanionId: string; status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled'
  attempts?: number; nextAttemptAt?: number; lastAttemptAt?: number; error?: string; createdAt: number
}
export interface CompanionAccessView { targetIds: string[]; companions: PartnerDirectoryEntryView[] }

export interface ScheduledTaskView {
  id: string; companionId: string; title: string; prompt: string
  schedule: { kind: 'interval'; minutes: number } | { kind: 'daily'; hour: number; minute: number }
  enabled: boolean; destroySessionAfterRun: boolean; overlapPolicy: 'skip' | 'queue'; timeoutMinutes: number
  nextRunAt: number; lastRunAt?: number; lastRunStatus?: 'completed' | 'failed' | 'skipped'; createdAt: number; updatedAt: number
}
export interface ExecutionRunView { id: string; kind: 'schedule' | 'delegation' | 'review' | 'skill'; ownerCompanionId: string; sessionId: string; sourceId: string; status: string; destroyAfterRun: boolean; startedAt: number; completedAt?: number; outputSummary?: string; error?: string }

export async function api<T>(path = '', init: RequestInit = {}): Promise<T> {
  const method = init.method ?? 'GET'
  const response = await fetch(`${PARTNER_API}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-DSH-Partner-Request': '1' }),
      ...init.headers,
    },
  })
  if (response.status === 204) return undefined as T
  const body = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${response.status}`)
  return body as T
}

export function loadPartner(): Promise<PartnerSnapshot> { return api() }
