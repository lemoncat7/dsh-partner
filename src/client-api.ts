export const PARTNER_API = '/partner-local/v1'

export type Capability = 'knowledge' | 'skills' | 'ssh' | 'git'
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
  id: string; channelId: string; userId: string; companionId: string; sessionId: string; cwd?: string; lastMessageAt: number; archived: boolean
}
export interface HeartbeatStateView {
  companionId: string; lastCheckedAt?: number; lastSentAt?: number; nextCheckAt: number
  sentDay: string; sentCount: number; consecutiveFailures: number; lastError?: string
}
export type MemoryKindView = 'profile' | 'preference' | 'task' | 'event' | 'relationship' | 'emotion'
export interface MemoryView { id: string; kind: MemoryKindView; subject: string; content: string; status: 'active' | 'completed' | 'superseded' | 'expired'; confidence: number; importance: number; updatedAt: number; locked?: boolean }
export interface MemoryRelationView { id: string; sourceMemoryId: string; targetMemoryId: string; kind: 'supports' | 'depends_on' | 'about' | 'conflicts_with' | 'follows'; label: string; confidence: number; updatedAt: number }
export interface MemoryGraphView { memories: MemoryView[]; relations: MemoryRelationView[] }
export interface DailyReflectionView { date: string; summary: string; events: string[]; openTasks: string[]; completedTasks: string[]; learnings: string[]; updatedAt: number; turnCount: number }
export interface PresetView { id: string; name: string; broken?: string }
export interface ModelCatalogView { providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>; defaultSelection: { provider: string; model: string } }
export interface PartnerSnapshot {
  companions: CompanionView[]; channels: ChannelView[]; pairings: PairingView[]; sessions: ChannelSessionView[]; heartbeatStates: HeartbeatStateView[]; presets: PresetView[]
}
export interface LoginView {
  id: string; companionId: string; phase: 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'error'
  qrContent?: string; accountId?: string; baseUrl?: string; error?: string; expiresAt: number
}

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
