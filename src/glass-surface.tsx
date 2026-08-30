import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from 'react'

type GlassElement = 'header' | 'aside' | 'section' | 'article' | 'div' | 'button'

interface GlassSurfaceProps extends Omit<HTMLAttributes<HTMLElement>, 'children' | 'className'> {
  as: GlassElement
  children: ReactNode
  className: string
  borderRadius: number
  borderWidth?: number
  brightness?: number
  blur?: number
  distortionScale?: number
  interactive?: boolean
  opacity?: number
  saturation?: number
  type?: 'button' | 'submit' | 'reset'
  disabled?: boolean
}

interface GlassStyle extends CSSProperties {
  '--partner-glass-filter-id': string
  '--partner-glass-saturation': number
  '--partner-glare-x': string
  '--partner-glare-y': string
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
  interactive = false,
  opacity = .93,
  saturation = 1.16,
  ...elementProps
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
  const glareFrameRef = useRef(0)
  const glarePointerRef = useRef<{ clientX: number; clientY: number }>()
  const [svgSupported, setSvgSupported] = useState(false)

  useEffect(() => {
    setSvgSupported(supportsSvgBackdropFilter(filterId))
  }, [filterId])

  useEffect(() => {
    if (!svgSupported) return
    const element = containerRef.current
    const image = imageRef.current
    if (element === null || image === null) return
    let frame = 0
    let previousWidth = 0
    let previousHeight = 0
    const update = (): void => {
      frame = 0
      const rect = element.getBoundingClientRect()
      const width = Math.max(1, Math.round(rect.width))
      const height = Math.max(1, Math.round(rect.height))
      if (width === previousWidth && height === previousHeight) return
      previousWidth = width
      previousHeight = height
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
  }, [blueGradientId, blur, borderRadius, borderWidth, brightness, opacity, redGradientId, svgSupported])

  useEffect(() => {
    if (!svgSupported) return
    const channels = [redRef.current, greenRef.current, blueRef.current]
    const offsets = [0, 5, 10]
    channels.forEach((channel, index) => channel?.setAttribute('scale', String(distortionScale + (offsets[index] ?? 0))))
  }, [distortionScale, svgSupported])

  useEffect(() => () => {
    if (glareFrameRef.current !== 0) cancelAnimationFrame(glareFrameRef.current)
  }, [])

  const renderGlare = (): void => {
    glareFrameRef.current = 0
    const element = containerRef.current
    if (element === null) return
    const pointer = glarePointerRef.current
    if (pointer === undefined) {
      element.style.setProperty('--partner-glare-x', '50%')
      element.style.setProperty('--partner-glare-y', '50%')
      return
    }
    const rect = element.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    const x = Math.max(0, Math.min(100, (pointer.clientX - rect.left) / rect.width * 100))
    const y = Math.max(0, Math.min(100, (pointer.clientY - rect.top) / rect.height * 100))
    element.style.setProperty('--partner-glare-x', `${x}%`)
    element.style.setProperty('--partner-glare-y', `${y}%`)
  }
  const scheduleGlare = (): void => {
    if (glareFrameRef.current === 0) glareFrameRef.current = requestAnimationFrame(renderGlare)
  }
  const moveGlare = (clientX: number, clientY: number): void => {
    if (!interactive) return
    glarePointerRef.current = { clientX, clientY }
    scheduleGlare()
  }
  const resetGlare = (): void => {
    if (!interactive) return
    glarePointerRef.current = undefined
    scheduleGlare()
  }

  const style: GlassStyle = {
    '--partner-glass-filter-id': `url(#${filterId})`,
    '--partner-glass-saturation': saturation,
    '--partner-glare-x': '50%',
    '--partner-glare-y': '50%',
  }

  return <Element
    {...elementProps}
    ref={containerRef as never}
    className={`dsh-partner-glass-surface ${svgSupported ? 'is-svg' : 'is-fallback'}${interactive ? ' is-interactive' : ''} ${className}`}
    style={style}
    onPointerMove={interactive ? event => moveGlare(event.clientX, event.clientY) : undefined}
    onPointerLeave={interactive ? resetGlare : undefined}
  >
    {svgSupported && <svg className="dsh-partner-glass-filter" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
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
    </svg>}
    {children}
  </Element>
}
