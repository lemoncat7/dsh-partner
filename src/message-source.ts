/** Producer-owned sources are required by the host v4 session format. */
import type { ContextFormed } from '@deepseek-ai/dsh-llm'

export const PARTNER_SOURCE_KIND = 'plugin:@lemoncat7/dsh-partner'

type PartnerSource = { kind: typeof PARTNER_SOURCE_KIND; plugin?: string } & ContextFormed

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'plugin:@lemoncat7/dsh-partner': PartnerSource
  }
}

type ReadablePluginSource = { kind: string; plugin?: unknown; form?: string; summary?: string }

/** Read historical wrappers without continuing to write the retired shape. */
export function isPluginSource(source: { kind: string; plugin?: unknown }, plugin: string): source is ReadablePluginSource {
  return source.kind === `plugin:${plugin}`
    || plugin === 'tool-goal' && source.kind === 'tool-goal'
    || source.kind === 'plugin' && source.plugin === plugin
}
