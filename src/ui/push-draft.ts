import type { PushChannelView } from '../notifications/push-domain.js'

export function pushDraft(channel: PushChannelView) {
  return { ...channel, targets: channel.targets.map(target => ({ ...target, key: '' })) }
}

/** Compare editable values only; delivery counters and disclosure state are not edits. */
export function pushDraftSignature(form: ReturnType<typeof pushDraft>): string {
  return JSON.stringify({
    name: form.name, baseUrl: form.baseUrl, enabled: form.enabled,
    notifyProblems: form.notifyProblems, content: form.content,
    group: form.group, sound: form.sound, openUrl: form.openUrl,
    targets: form.targets.map(({ id, name, enabled, key }) => ({ id, name, enabled, key })),
  })
}
