export type StrapMaterial = 'woven' | 'braided' | 'leather'
export type PendantFps = 24 | 30 | 60
export type CardImageFit = 'contain' | 'cover'
export interface PendantSettings { enabled: boolean; fps: PendantFps; material: StrapMaterial; color: string; image: string; imageFit: CardImageFit; strapLength: number; strapImage: string; quality: number }
export const PENDANT_SETTINGS_KEY = 'dsh-partner:pendant-settings:v1'
export const DEFAULT_PENDANT_SETTINGS: Readonly<PendantSettings> = Object.freeze({ enabled: true, fps: 30, material: 'woven', color: '#617e73', image: '', imageFit: 'contain', strapLength: 100, strapImage: '', quality: 100 })
export const MAX_CARD_IMAGE_LENGTH = 700_000

export function samePendantSettings(a: PendantSettings, b: PendantSettings): boolean {
  return a.enabled === b.enabled && a.fps === b.fps && a.material === b.material && a.color === b.color && a.image === b.image && a.imageFit === b.imageFit && a.strapLength === b.strapLength && a.strapImage === b.strapImage && a.quality === b.quality
}

export function normalizeStrapLength(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? Math.max(60, Math.min(160, Math.round(value))) : 100 }
export function normalizeCardQuality(value: unknown): number { return value === 'standard' ? 0 : typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 100 }
function safeImage(value: unknown): string { return typeof value === 'string' && value.length <= MAX_CARD_IMAGE_LENGTH && /^data:image\/(jpeg|png|webp);base64,[a-z0-9+/]+={0,2}$/i.test(value) ? value : '' }

export function normalizePendantFps(value: unknown): PendantFps { return value === 24 || value === 60 ? value : 30 }

export function normalizePendantSettings(value: unknown): PendantSettings {
  const input = value && typeof value === 'object' ? value as Partial<PendantSettings> : {}
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : true,
    fps: normalizePendantFps(input.fps),
    strapLength: normalizeStrapLength(input.strapLength),
    strapImage: safeImage(input.strapImage),
    quality: normalizeCardQuality(input.quality),
    imageFit: input.imageFit === 'cover' ? 'cover' : 'contain',
    material: input.material === 'braided' || input.material === 'leather' ? input.material : 'woven',
    color: typeof input.color === 'string' && /^#[0-9a-f]{6}$/i.test(input.color) ? input.color.toLowerCase() : DEFAULT_PENDANT_SETTINGS.color,
    image: safeImage(input.image),
  }
}
