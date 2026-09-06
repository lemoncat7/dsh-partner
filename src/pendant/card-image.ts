import { MAX_CARD_IMAGE_LENGTH } from './settings.js'

export function loadCardImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => { image.onload = image.onerror = null; resolve(image) }
    image.onerror = () => { image.onload = image.onerror = null; reject(new Error('图片无法解码，请重新选择 PNG、JPEG 或 WebP 图片。')) }
    image.src = source
  })
}

/** Decode once on explicit upload; flatten and resize before persisting. No
 * remote URLs, SVG execution, server upload or full-size GPU textures.
 */
export async function prepareCardImage(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请选择 PNG、JPEG 或 WebP 图片。')
  if (file.size > 5 * 1024 * 1024) throw new Error('图片不能超过 5 MB。')
  const url = URL.createObjectURL(file)
  try {
    const image = await loadCardImage(url)
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 25_000_000) throw new Error('图片分辨率过大，请缩小至 2500 万像素以内。')
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 704
    const context = canvas.getContext('2d')
    if (!context) throw new Error('当前浏览器无法处理图片。')
    context.fillStyle = '#253235'; context.fillRect(0, 0, 512, 704)
    const scale = Math.max(512 / image.naturalWidth, 704 / image.naturalHeight)
    const width = image.naturalWidth * scale, height = image.naturalHeight * scale
    context.drawImage(image, (512 - width) / 2, (704 - height) / 2, width, height)
    const result = canvas.toDataURL('image/jpeg', .9)
    if (result.length > MAX_CARD_IMAGE_LENGTH) throw new Error('图片压缩后仍然过大，请换一张图片。')
    return result
  } finally { URL.revokeObjectURL(url) }
}
