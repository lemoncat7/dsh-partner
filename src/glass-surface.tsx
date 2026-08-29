import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'

type GlassElement = 'header' | 'aside' | 'section'

interface GlassSurfaceProps {
  as: GlassElement
  children: ReactNode
  className: string
  borderRadius: number
  borderWidth?: number
  brightness?: number
  blur?: number
  distortionScale?: number
  opacity?: number
  saturation?: number
}

interface GlassStyle extends CSSProperties {
  '--partner-glass-filter-id': string
  '--partner-glass-saturation': number
}

function supportsSvgBackdropFilter(filterId: string): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false
  if (window.matchMedia('(prefers-reduced-transparency: reduce)').matches) return false
  const userAgent = navigator.userAgent
  if (/Firefox/i.test(userAgent) || (/Safari/i.test(userAgent) && !/(Chrome|Chromium|CriOS)/i.test(userAgent))) return false
  const probe = document.createElement('div')
  probe.style.backdropFilter = `url(#${filterId})`
  return probe.style.backdropFilter !== ''
}

function displacementMap(
  width: number,
  height: number,
  radius: number,
  borderWidth: number,
  brightness: number,
  opacity: number,
  blur: number,
  redGradientId: string,
  blueGradientId: string,
): string {
  const edge = Math.max(1, Math.min(width, height) * borderWidth * .5)
  const innerWidth = Math.max(1, width - edge * 2)
  const innerHeight = Math.max(1, height - edge * 2)
  const svg = `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="${redGradientId}" x1="100%" y1="0%" x2="0%" y2="0%"><stop offset="0%" stop-color="#0000"/><stop offset="100%" stop-color="red"/></linearGradient>
      <linearGradient id="${blueGradientId}" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#0000"/><stop offset="100%" stop-color="blue"/></linearGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="black"/>
    <rect width="${width}" height="${height}" rx="${radius}" fill="url(#${redGradientId})"/>
    <rect width="${width}" height="${height}" rx="${radius}" fill="url(#${blueGradientId})" style="mix-blend-mode:difference"/>
    <rect x="${edge}" y="${edge}" width="${innerWidth}" height="${innerHeight}" rx="${radius}" fill="hsl(0 0% ${brightness}% / ${opacity})" style="filter:blur(${blur}px)"/>
  </svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

export function GlassSurface({
  as: Element,
  children,
  className,
  borderRadius,
  borderWidth = .07,
  brightness = 50,
  blur = 11,
  distortionScale = -26,
  opacity = .93,
  saturation = 1.16,
}: GlassSurfaceProps): JSX.Element {
  const uniqueId = useId().replace(/:/g, '-')
  const filterId = `partner-glass-filter-${uniqueId}`
  const redGradientId = `partner-glass-red-${uniqueId}`
  const blueGradientId = `partner-glass-blue-${uniqueId}`
  const containerRef = useRef<HTMLElement>(null)
  const imageRef = useRef<SVGFEImageElement>(null)
  const redRef = useRef<SVGFEDisplacementMapElement>(null)
  const greenRef = useRef<SVGFEDisplacementMapElement>(null)
  const blueRef = useRef<SVGFEDisplacementMapElement>(null)
  const [svgSupported, setSvgSupported] = useState(false)

  useEffect(() => {
    setSvgSupported(supportsSvgBackdropFilter(filterId))
  }, [filterId])

  useEffect(() => {
    const element = containerRef.current
    const image = imageRef.current
    if (element === null || image === null) return
    let frame = 0
    const update = (): void => {
      frame = 0
      const rect = element.getBoundingClientRect()
      const width = Math.max(1, Math.round(rect.width))
      const height = Math.max(1, Math.round(rect.height))
      image.setAttribute('href', displacementMap(
        width,
        height,
        Math.min(borderRadius, Math.min(width, height) / 2),
        borderWidth,
        brightness,
        opacity,
        blur,
        redGradientId,
        blueGradientId,
      ))
    }
    const schedule = (): void => {
      if (frame === 0) frame = requestAnimationFrame(update)
    }
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule)
    observer?.observe(element)
    schedule()
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame)
      observer?.disconnect()
    }
  }, [blueGradientId, blur, borderRadius, borderWidth, brightness, opacity, redGradientId])

  useEffect(() => {
    const channels = [redRef.current, greenRef.current, blueRef.current]
    const offsets = [0, 5, 10]
    channels.forEach((channel, index) => channel?.setAttribute('scale', String(distortionScale + (offsets[index] ?? 0))))
  }, [distortionScale])

  const style: GlassStyle = {
    '--partner-glass-filter-id': `url(#${filterId})`,
    '--partner-glass-saturation': saturation,
  }

  return <Element
    ref={containerRef as never}
    className={`dsh-partner-glass-surface ${svgSupported ? 'is-svg' : 'is-fallback'} ${className}`}
    style={style}
  >
    <svg className="dsh-partner-glass-filter" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
      <defs>
        <filter id={filterId} colorInterpolationFilters="sRGB" x="0%" y="0%" width="100%" height="100%">
          <feImage ref={imageRef} x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="map" />
          <feDisplacementMap ref={redRef} in="SourceGraphic" in2="map" result="displaced-red" />
          <feColorMatrix in="displaced-red" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="red" />
          <feDisplacementMap ref={greenRef} in="SourceGraphic" in2="map" result="displaced-green" />
          <feColorMatrix in="displaced-green" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="green" />
          <feDisplacementMap ref={blueRef} in="SourceGraphic" in2="map" result="displaced-blue" />
          <feColorMatrix in="displaced-blue" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="blue" />
          <feBlend in="red" in2="green" mode="screen" result="red-green" />
          <feBlend in="red-green" in2="blue" mode="screen" result="output" />
          <feGaussianBlur in="output" stdDeviation=".45" />
        </filter>
      </defs>
    </svg>
    {children}
  </Element>
}
