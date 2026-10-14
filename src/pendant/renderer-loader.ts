import type { createLanyard } from './renderer.js'

declare const require: { async(path: string): Promise<unknown> }
type RendererModule = { createLanyard: typeof createLanyard }

/** Cache concurrent starts; failed downloads may be retried after re-enabling. */
export function createRendererLoader(importChunk: () => Promise<unknown>) {
  let pending: Promise<RendererModule> | undefined
  return () => pending ??= Promise.resolve().then(importChunk).then(value => {
    const module = value as RendererModule
    if (typeof module?.createLanyard !== 'function') throw new Error('Invalid pendant renderer')
    return module
  }).catch(error => { pending = undefined; throw error })
}

export const loadPendantRenderer = createRendererLoader(() => require.async('./client.pendant.js'))
