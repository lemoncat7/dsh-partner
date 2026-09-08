import { MAX_CARD_IMAGE_LENGTH, type CardImageFit } from './settings.js'

export const CARD_IMAGE_BACKGROUND = '#253235'

/** Keep aspect ratio in both modes; only cover may extend beyond the face. */
export function cardImageRect(width: number, height: number, targetWidth: number, targetHeight: number, fit: CardImageFit) {
  if (![width, height, targetWidth, targetHeight].every(value => Number.isFinite(value) && value > 0)) throw new Error('图片尺寸无效。')
  const scale = (fit === 'cover' ? Math.max : Math.min)(targetWidth / width, targetHeight / height)
  return { x: (targetWidth - width * scale) / 2, y: (targetHeight - height * scale) / 2, width: width * scale, height: height * scale }
}

export function drawCardImage(canvas: HTMLCanvasElement, image: HTMLImageElement, fit: CardImageFit): void {
  const context = canvas.getContext('2d')
  if (!context) throw new Error('当前浏览器无法处理图片。')
  const rect = cardImageRect(image.naturalWidth, image.naturalHeight, canvas.width, canvas.height, fit)
  context.fillStyle = CARD_IMAGE_BACKGROUND
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, rect.x, rect.y, rect.width, rect.height)
}

export function loadCardImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => { image.onload = image.onerror = null; resolve(image) }
    image.onerror = () => { image.onload = image.onerror = null; reject(new Error('图片无法解码，请重新选择 PNG、JPEG 或 WebP 图片。')) }
    image.src = source
  })
}

/** Persist a bounded source with its aspect ratio intact, so fitting remains
 * reversible. No remote URLs, SVG execution, server upload or full-size GPU textures.
 */
export async function prepareCardImage(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请选择 PNG、JPEG 或 WebP 图片。')
  if (file.size > 5 * 1024 * 1024) throw new Error('图片不能超过 5 MB。')
  const url = URL.createObjectURL(file)
  try {
    const image = await loadCardImage(url)
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 25_000_000) throw new Error('图片分辨率过大，请缩小至 2500 万像素以内。')
    const scale = Math.min(1, 1024 / Math.max(image.naturalWidth, image.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('当前浏览器无法处理图片。')
    context.fillStyle = CARD_IMAGE_BACKGROUND; context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const result = canvas.toDataURL('image/jpeg', .9)
    if (result.length > MAX_CARD_IMAGE_LENGTH) throw new Error('图片压缩后仍然过大，请换一张图片。')
    return result
  } finally { URL.revokeObjectURL(url) }
}
