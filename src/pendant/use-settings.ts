import { useSyncExternalStore } from 'react'
import { DEFAULT_PENDANT_SETTINGS, normalizePendantSettings, PENDANT_SETTINGS_KEY, type PendantSettings } from './settings.js'

let current: PendantSettings | undefined
const listeners = new Set<() => void>()
function load(): PendantSettings {
  try { return normalizePendantSettings(JSON.parse(localStorage.getItem(PENDANT_SETTINGS_KEY) ?? 'null')) }
  catch { return { ...DEFAULT_PENDANT_SETTINGS } }
}
function changed(): void { for (const listener of listeners) listener() }
function storage(event: StorageEvent): void {
  if (event.key !== null && event.key !== PENDANT_SETTINGS_KEY) return
  current = load(); changed()
}
function subscribe(listener: () => void): () => void {
  if (!listeners.size) { current = load(); window.addEventListener('storage', storage) }
  listeners.add(listener)
  return () => { listeners.delete(listener); if (!listeners.size) window.removeEventListener('storage', storage) }
}
export function usePendantSettings(): PendantSettings {
  return useSyncExternalStore(subscribe, () => current ??= load(), () => DEFAULT_PENDANT_SETTINGS)
}
export function savePendantSettings(settings: PendantSettings): void {
  const next = normalizePendantSettings(settings)
  try { localStorage.setItem(PENDANT_SETTINGS_KEY, JSON.stringify(next)) }
  catch { throw new Error('无法保存卡片设置，请检查浏览器存储权限或剩余空间。原设置未更改。') }
  current = next; changed()
}
