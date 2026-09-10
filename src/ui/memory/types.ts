import type {MemoryView, DailyReflectionView, UserProfileSnapshotView} from '../../client-api.js'
export interface MemoryCollection {memories: MemoryView[]; reflections: DailyReflectionView[]; profiles: UserProfileSnapshotView[]}
export interface SceneView {id: string; title: string; summary: string; memoryIds: string[]; updatedAt: number}
export interface ExperienceView {id: string; title: string; steps: string[]; evidence: Array<{turnId: string; quote: string}>; version: string; status: 'draft' | 'approved' | 'rejected'; updatedAt: number}
export interface MemoryLayers {scenes: SceneView[]; experiences: ExperienceView[]; jobCount?: number; retryCount?: number; jobs: Array<{id: string; status: string; attempts: number; nextAt: number; at?: number; error?: string}>}
export interface HistoryTurn {id: string; at: number; user: string; assistant: string}
export type MemoryMode = 'profile' | 'memory' | 'reflection' | 'history' | 'scenes' | 'experiences' | 'graph'
export const MEMORY_STATUS: Record<MemoryView['status'], string> = {active: '有效', completed: '已完成', superseded: '已替代', expired: '已过期'}
