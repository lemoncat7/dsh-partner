import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d-compat'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { createLanyardPhysics, LANYARD_STEP } from './physics.js'
import { createLanyardStrap } from './strap.js'
import { createBadgeSheen } from './sheen.js'
import { createNoticeMotion } from './notice-motion.js'
import type { PendantSettings } from './settings.js'
import { loadCardImage } from './card-image.js'
import { createPendantFrameLoop } from './frame-loop.js'
import { createBadgeFaceMaterial, BADGE_LIGHTING } from './surface.js'
import { measureFixedLayerOrigin } from './coordinates.js'

export interface BadgeMessage { id: string; count: number; name: string; label: string }
export interface LanyardHandle { setMessage(message?: BadgeMessage): void; setAppearance(settings: PendantSettings): void; relayout(): void; destroy(): void }
export interface LanyardOptions { signal: AbortSignal; onTap(): void; onFailure(): void }
let physicsReady: Promise<void> | undefined

/** React Bits-inspired Three + Rapier lanyard, with elastic/spherical joints.
 * Separate ESM asset: the main client never imports the renderer/physics bundle.
 * Only the moving card's HTML hit target receives input; the canvas is click-through.
 */
export async function createLanyard(canvas: HTMLCanvasElement, hit: HTMLButtonElement, options: LanyardOptions): Promise<LanyardHandle> {
  physicsReady ??= RAPIER.init().catch(error => { physicsReady = undefined; throw error })
  await physicsReady
  options.signal.throwIfAborted()
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' })
  renderer.setClearColor(0x000000, 0)
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = .95
  const scene = new THREE.Scene()
  // Local, orthographic card view: position/depth never magnifies the badge.
  // Move its small canvas in CSS; never allocate a viewport-sized GPU target.
  const cardViewSize = 2.8
  const camera = new THREE.OrthographicCamera(-cardViewSize / 2, cardViewSize / 2, cardViewSize / 2, -cardViewSize / 2, .1, 50)
  camera.position.set(0, 0, 10)
  const pmrem = new THREE.PMREMGenerator(renderer)
  const room = new RoomEnvironment()
  const environment = pmrem.fromScene(room)
  room.dispose(); pmrem.dispose()
  scene.environment = environment.texture
  scene.add(new THREE.AmbientLight(0xffffff, BADGE_LIGHTING.ambient))
  const light = new THREE.DirectionalLight(0xffffff, BADGE_LIGHTING.key)
  light.position.set(-3, 4, 5); scene.add(light)

  const disposables: Array<{ dispose(): void }> = [environment]
  const keep = <T extends { dispose(): void }>(value: T): T => { disposables.push(value); return value }
  const card = new THREE.Group()
  const shape = roundedRectangle(1.42, 1.96, .14)
  const edge = keep(new THREE.ExtrudeGeometry(shape, { depth: .04, bevelEnabled: true, bevelSegments: 2, steps: 1, bevelSize: .025, bevelThickness: .018, curveSegments: 6 }))
  const edgeMaterial = keep(new THREE.MeshStandardMaterial({ color: 0x667578, metalness: .75, roughness: .28 }))
  card.add(new THREE.Mesh(edge, edgeMaterial))
  const face = keep(new THREE.ShapeGeometry(shape))
  // ShapeGeometry UVs are world coordinates; map the card face to [0,1].
  const positions = face.getAttribute('position'), uv = face.getAttribute('uv')
  for (let i = 0; i < positions.count; i++) uv.setXY(i, positions.getX(i) / 1.42 + .5, positions.getY(i) / 1.96 + .5)
  const frontTexture = keep(badgeTexture(false)), backTexture = keep(badgeTexture(true))
  const front = new THREE.Mesh(face, keep(createBadgeFaceMaterial(frontTexture)))
  front.position.z = .063; card.add(front)
  const back = new THREE.Mesh(face, keep(createBadgeFaceMaterial(backTexture)))
  back.rotation.y = Math.PI; back.position.z = -.025; card.add(back)
  const sheen = keep(createBadgeSheen(card, face))
  const metal = keep(new THREE.MeshStandardMaterial({ color: 0xc3ced0, metalness: .95, roughness: .24 }))
  const ring = new THREE.Mesh(keep(new THREE.TorusGeometry(.115, .035, 6, 16)), metal)
  ring.position.set(0, 1.04, .035); card.add(ring)
  const clip = new THREE.Mesh(keep(new THREE.BoxGeometry(.24, .16, .09)), metal)
  clip.position.set(0, .94, .03); card.add(clip)
  scene.add(card)

  const { world, beads, badge, bodies } = createLanyardPhysics()
  const noticeMotion = createNoticeMotion(badge)
  const strap = createLanyardStrap(canvas), euler = new THREE.Euler()
  const movingBodies = [badge, ...beads]
  let quietTime = 0, accumulator = 0, disposed = false, scale = 58, canvasSize = 0, messageKey = ''
  let unread = 0, messageIdentity = ''
  let artSource: string | undefined, artRevision = 0
  let home = canvas.parentElement!.getBoundingClientRect()
  let layerOrigin = { left: 0, top: 0 }
  let gesture: { id: number; x: number; y: number; lastX: number; lastY: number; lastAt: number; moved: boolean; offset: THREE.Vector3; rotation: THREE.Quaternion; target: THREE.Vector3; velocity: THREE.Vector3; spin: THREE.Vector3 } | undefined
  const reduced = matchMedia('(prefers-reduced-motion: reduce)')
  const toWorld = (x: number, y: number): THREE.Vector3 => {
    // Cached layout + linear mapping avoids a layout read / matrix inversion
    // on every pointer event, including high-rate mouse and pen input.
    return new THREE.Vector3((x - home.left - home.width / 2) / scale, 1.6 - (y - home.top - home.height / 2) / scale, 0)
  }
  const paint = (): void => {
    const position = badge.translation()
    card.quaternion.copy(badge.rotation())
    canvas.dataset.facing = String(1 - 2 * (card.quaternion.x ** 2 + card.quaternion.y ** 2))
    const x = home.width / 2 + position.x * scale, y = home.height / 2 + (1.6 - position.y) * scale
    canvas.style.transform = `translate3d(${home.left + x - canvasSize / 2 - layerOrigin.left}px, ${home.top + y - canvasSize / 2 - layerOrigin.top}px, 0)`
    // Canvas and SVG are fixed siblings with left/top = 0, hence share this
    // containing-block origin. Hit target and hook stay in root-local pixels.
    strap.paint(bodies.map(body => body.translation()), home.left + home.width / 2 - layerOrigin.left, home.top + home.height / 2 + 1.6 * scale - layerOrigin.top, scale)
    renderer.render(scene, camera)
    euler.setFromQuaternion(card.quaternion)
    hit.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%) rotate(${-euler.z}rad)`
  }
  const loop = createPendantFrameLoop((now, dt) => {
    if (disposed || document.hidden) return false
    accumulator += dt
    if (reduced.matches) { noticeMotion.cancel(); sheen.clear() }
    while (accumulator >= LANYARD_STEP) {
      if (noticeMotion.step(LANYARD_STEP, !!gesture)) sheen.start(now)
      world.step(); accumulator -= LANYARD_STEP
    }
    canvas.dataset.noticeMotion = noticeMotion.phase
    const shining = sheen.update(now, reduced.matches)
    canvas.dataset.shining = String(shining)
    paint()
    const calm = movingBodies.every(body => {
      const v = body.linvel(), a = body.angvel()
      // A stretched kinematic endpoint leaves tiny constraint-solver jitter.
      // Ignore it only while held; free recoil keeps the original thresholds.
      return Math.hypot(v.x, v.y, v.z) < (gesture?.moved ? .06 : .015) && Math.hypot(a.x, a.y, a.z) < .025
    })
    // A held card may sleep once the rope settles. Pointer movement/release
    // wakes it again; spring positions and stored stretch remain untouched.
    quietTime = calm ? quietTime + dt : 0
    const moving = quietTime < .8 && movingBodies.some(body => !body.isSleeping())
    const active = moving || shining || (!gesture && noticeMotion.phase !== 'idle')
    canvas.dataset.sleeping = String(!active)
    if (!active) { accumulator = 0; movingBodies.forEach(body => body.sleep()) }
    return active
  })
  const wake = (): void => {
    if (disposed || document.hidden) return
    quietTime = 0
    loop.wake()
  }
  const end = (event?: PointerEvent): void => {
    if (!gesture || (event && event.pointerId !== gesture.id)) return
    const current = gesture; gesture = undefined
    if (hit.hasPointerCapture(current.id)) hit.releasePointerCapture(current.id)
    badge.setBodyType(RAPIER.RigidBodyType.Dynamic, true)
    if (current.moved) {
      // Throw velocity is time-based, not pixels per pointer event. A held
      // stretch still recoils through the springs, without a made-up impulse.
      const recent = event?.type === 'pointerup' && performance.now() - current.lastAt < 100
      badge.setLinvel(recent ? current.velocity : { x: 0, y: 0, z: 0 }, true)
      badge.setAngvel(recent ? current.spin : { x: 0, y: 0, z: 0 }, true)
      for (const body of beads) body.wakeUp()
    }
    wake()
    if (!current.moved && event?.type === 'pointerup') options.onTap()
  }
  const down = (event: PointerEvent): void => {
    if (!event.isPrimary || event.button !== 0 || gesture) return
    noticeMotion.cancel(); sheen.clear()
    event.preventDefault()
    // Programmatic focus during pointerdown was triggering the host theme's
    // keyboard focus rectangle. Keyboard navigation still receives its outline.
    if (document.activeElement === hit) hit.blur()
    gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, lastAt: performance.now(), moved: false, offset: toWorld(event.clientX, event.clientY).sub(new THREE.Vector3().copy(badge.translation())), rotation: new THREE.Quaternion().copy(badge.rotation()), target: new THREE.Vector3().copy(badge.translation()), velocity: new THREE.Vector3(), spin: new THREE.Vector3() }
    hit.setPointerCapture(event.pointerId)
    wake()
  }
  const move = (event: PointerEvent): void => {
    if (!gesture || gesture.id !== event.pointerId) return
    if (!gesture.moved && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 6) return
    if (!gesture.moved) { gesture.moved = true; badge.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true) }
    const target = toWorld(event.clientX, event.clientY).sub(gesture.offset)
    // Free translation plus a virtual grip twist: lateral dragging turns the
    // badge over; its spherical attachment does not force a front-facing pose.
    target.z = 0
    badge.setNextKinematicTranslation(target)
    badge.setNextKinematicRotation(new THREE.Quaternion().setFromEuler(new THREE.Euler(
      (event.clientY - gesture.y) * .003, (event.clientX - gesture.x) * .016, 0, 'YXZ',
    )).multiply(gesture.rotation))
    const now = performance.now(), dt = Math.max((now - gesture.lastAt) / 1000, 1 / 240)
    gesture.velocity.copy(target).sub(gesture.target).divideScalar(dt).clampLength(0, 35)
    gesture.spin.set((event.clientY - gesture.lastY) * .003 / dt, (event.clientX - gesture.lastX) * .016 / dt, 0).clampLength(0, 18)
    gesture.target.copy(target); gesture.lastX = event.clientX; gesture.lastY = event.clientY; gesture.lastAt = now
    for (const body of beads) body.wakeUp()
    wake()
  }
  const click = (event: MouseEvent): void => { if (event.detail === 0) options.onTap() }
  const layout = (): void => {
    home = canvas.parentElement!.getBoundingClientRect()
    if (home.width <= 0 || home.height <= 0) return
    layerOrigin = measureFixedLayerOrigin(canvas)
    // Preserve the old resting size, without the old perspective projection.
    scale = home.height / (20 * Math.tan(Math.PI / 12))
    const nextSize = Math.ceil(scale * cardViewSize)
    if (nextSize !== canvasSize) {
      canvasSize = nextSize; renderer.setSize(canvasSize, canvasSize, false)
      canvas.style.width = `${canvasSize}px`; canvas.style.height = `${canvasSize}px`
    }
    hit.style.width = `${Math.max(44, scale * 1.45)}px`; hit.style.height = `${Math.max(44, scale * 1.99)}px`
    strap.resize(scale)
  }
  const resize = (): void => { layout(); wake() }
  const hide = (): void => { end(); if (document.hidden) { noticeMotion.cancel(); sheen.clear(); loop.stop(); accumulator = 0 } else resize() }
  const blur = (): void => end()
  const lost = (event: Event): void => { event.preventDefault(); options.onFailure() }
  const observer = new ResizeObserver(resize); observer.observe(canvas.parentElement!)
  reduced.addEventListener('change', wake)
  hit.addEventListener('pointerdown', down); hit.addEventListener('pointermove', move)
  hit.addEventListener('pointerup', end); hit.addEventListener('pointercancel', end); hit.addEventListener('lostpointercapture', end); hit.addEventListener('click', click)
  window.addEventListener('blur', blur); window.addEventListener('resize', resize); document.addEventListener('visibilitychange', hide); canvas.addEventListener('webglcontextlost', lost)
  canvas.dataset.ready = 'true'; resize()
  return {
    setAppearance(settings) {
      if (disposed) return
      loop.setFps(settings.fps); canvas.dataset.fps = String(settings.fps)
      strap.setAppearance(settings)
      if (settings.image === artSource) return
      artSource = settings.image
      const revision = ++artRevision, target = frontTexture.image as HTMLCanvasElement
      const restore = (): void => { drawBadge(target, false); frontTexture.needsUpdate = true; canvas.dataset.art = 'default'; wake() }
      if (!settings.image) { restore(); return }
      void loadCardImage(settings.image).then(image => {
        if (disposed || revision !== artRevision) return
        target.getContext('2d')!.drawImage(image, 0, 0, target.width, target.height)
        frontTexture.needsUpdate = true; canvas.dataset.art = 'custom'; wake()
      }).catch(() => { if (!disposed && revision === artRevision) restore() })
    },
    setMessage(message) {
      if (disposed) return
      const key = JSON.stringify(message ?? null)
      if (key === messageKey) return
      messageKey = key
      const identity = message?.id ?? ''
      if (message?.count && (message.count > unread || (message.count >= unread && identity !== messageIdentity)) && !document.hidden && !reduced.matches) {
        sheen.clear(); noticeMotion.request()
      }
      if (!message?.count) { noticeMotion.cancel(); sheen.clear() }
      unread = message?.count ?? 0; messageIdentity = identity
      drawBadge(backTexture.image as HTMLCanvasElement, true, message)
      backTexture.needsUpdate = true
      canvas.dataset.unread = String(message?.count ?? 0)
      wake()
    },
    relayout() { if (!disposed) resize() },
    destroy() {
      if (disposed) return
      end(); disposed = true; loop.stop(); observer.disconnect()
      reduced.removeEventListener('change', wake)
      hit.removeEventListener('pointerdown', down); hit.removeEventListener('pointermove', move); hit.removeEventListener('pointerup', end); hit.removeEventListener('pointercancel', end); hit.removeEventListener('lostpointercapture', end); hit.removeEventListener('click', click)
      window.removeEventListener('blur', blur); window.removeEventListener('resize', resize); document.removeEventListener('visibilitychange', hide); canvas.removeEventListener('webglcontextlost', lost)
      strap.destroy()
      for (const disposable of disposables) disposable.dispose()
      renderer.dispose(); renderer.forceContextLoss(); world.free()
    },
  }
}

function roundedRectangle(width: number, height: number, radius: number): THREE.Shape {
  const x = -width / 2, y = -height / 2, s = new THREE.Shape()
  s.moveTo(x + radius, y); s.lineTo(x + width - radius, y); s.quadraticCurveTo(x + width, y, x + width, y + radius)
  s.lineTo(x + width, y + height - radius); s.quadraticCurveTo(x + width, y + height, x + width - radius, y + height)
  s.lineTo(x + radius, y + height); s.quadraticCurveTo(x, y + height, x, y + height - radius)
  s.lineTo(x, y + radius); s.quadraticCurveTo(x, y, x + radius, y)
  return s
}

function badgeTexture(back: boolean): THREE.CanvasTexture {
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 704
  drawBadge(canvas, back)
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; return texture
}
function drawBadge(canvas: HTMLCanvasElement, back: boolean, message?: BadgeMessage): void {
  const c = canvas.getContext('2d')!
  c.textAlign = 'left'
  c.fillStyle = back ? '#e7e9e6' : '#253235'; c.fillRect(0, 0, 512, 704)
  if (back && message?.count) {
    const ink = back ? '#253235' : '#f1f3ec', muted = back ? '#405953' : '#b6cbc2'
    c.textAlign = 'center'; c.fillStyle = muted; c.font = '600 56px sans-serif'; c.fillText('伙伴消息', 256, 104)
    c.fillStyle = back ? '#d0dcd5' : '#405c51'; c.beginPath(); c.roundRect(164, 154, 184, 132, 34); c.fill()
    c.fillStyle = ink; c.font = '600 90px sans-serif'; c.fillText(message.count > 99 ? '99+' : String(message.count), 256, 252)
    c.font = '600 76px sans-serif'
    const chars = Array.from(message.name), originalLength = chars.length
    while (chars.length && c.measureText(chars.join('') + (chars.length < originalLength ? '…' : '')).width > 430) chars.pop()
    c.fillText(chars.join('') + (chars.length < originalLength ? '…' : ''), 256, 411)
    c.font = '500 74px sans-serif'; c.fillText(message.label, 256, 514)
    c.fillStyle = muted; c.font = '500 52px sans-serif'; c.fillText('点击查看', 256, 628)
    return
  }
  c.fillStyle = back ? '#536a65' : '#b6cbc2'; c.font = '500 28px sans-serif'; c.fillText('DSH / PARTNER', 49, 90)
  c.beginPath(); c.arc(256, 305, 116, 0, Math.PI * 2); c.fillStyle = back ? '#d5dcda' : '#334749'; c.fill()
  // Original geometric companion emblem, not an external image request.
  c.fillStyle = back ? '#526663' : '#bfd4c9'; c.beginPath(); c.moveTo(179, 338); c.lineTo(183, 229); c.lineTo(225, 264); c.quadraticCurveTo(256, 248, 287, 264); c.lineTo(329, 229); c.lineTo(333, 338); c.quadraticCurveTo(255, 392, 179, 338); c.fill()
  c.fillStyle = back ? '#dce4df' : '#263536'; c.beginPath(); c.ellipse(228, 314, 9, 19, -.15, 0, Math.PI * 2); c.ellipse(284, 314, 9, 19, .15, 0, Math.PI * 2); c.fill()
  c.textAlign = 'center'; c.fillStyle = back ? '#253235' : '#f1f3ec'; c.font = '600 48px sans-serif'; c.fillText(back ? 'TAKE A BREAK' : 'WITH YOU', 256, 515)
  c.fillStyle = back ? '#536663' : '#b6c5c1'; c.font = '24px sans-serif'; c.fillText(back ? 'A little pause. A little play.' : 'Always a little closer.', 256, 559)
  c.fillStyle = back ? '#b3beb8' : '#6d8b80'; c.fillRect(213, 608, 86, 5)
}
