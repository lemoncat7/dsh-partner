export type StrapMaterial = 'woven' | 'braided' | 'leather'
export type PendantFps = 24 | 30 | 60
export interface PendantSettings { enabled: boolean; fps: PendantFps; material: StrapMaterial; color: string; image: string }
export const PENDANT_SETTINGS_KEY = 'dsh-partner:pendant-settings:v1'
export const DEFAULT_PENDANT_SETTINGS: Readonly<PendantSettings> = Object.freeze({ enabled: true, fps: 30, material: 'woven', color: '#617e73', image: '' })
export const MAX_CARD_IMAGE_LENGTH = 700_000

export function samePendantSettings(a: PendantSettings, b: PendantSettings): boolean {
  return a.enabled === b.enabled && a.fps === b.fps && a.material === b.material && a.color === b.color && a.image === b.image
}

export function normalizePendantFps(value: unknown): PendantFps { return value === 24 || value === 60 ? value : 30 }

export function normalizePendantSettings(value: unknown): PendantSettings {
  const input = value && typeof value === 'object' ? value as Partial<PendantSettings> : {}
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : true,
    fps: normalizePendantFps(input.fps),
    material: input.material === 'braided' || input.material === 'leather' ? input.material : 'woven',
    color: typeof input.color === 'string' && /^#[0-9a-f]{6}$/i.test(input.color) ? input.color.toLowerCase() : DEFAULT_PENDANT_SETTINGS.color,
    image: typeof input.image === 'string' && input.image.length <= MAX_CARD_IMAGE_LENGTH && /^data:image\/jpeg;base64,[a-z0-9+/]+={0,2}$/i.test(input.image) ? input.image : '',
  }
}
