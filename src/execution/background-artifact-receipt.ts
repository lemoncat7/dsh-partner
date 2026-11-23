import type {} from '@deepseek-ai/dsh-session/types'

export interface BackgroundArtifactReceipt {
  taskId: string
  files: Array<{name: string; resource?: string | null; url?: string}>
  text?: string
  anchorSeq?: number
}

export const BACKGROUND_ARTIFACT_RECORD = 'plugin:dsh-partner/background-artifacts'

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap { 'plugin:dsh-partner/background-artifacts': BackgroundArtifactReceipt }
}

export function backgroundArtifactReceipt(event: {type: string; ignorable?: boolean; data: unknown}): BackgroundArtifactReceipt | undefined {
  if (event.type !== BACKGROUND_ARTIFACT_RECORD || event.ignorable !== true) return
  const data = event.data as Partial<BackgroundArtifactReceipt> | null
  if (data && typeof data.taskId === 'string' && (data.text === undefined || typeof data.text === 'string') &&
    (data.anchorSeq === undefined || Number.isSafeInteger(data.anchorSeq) && data.anchorSeq > 0) &&
    Array.isArray(data.files)) return data as BackgroundArtifactReceipt
}
