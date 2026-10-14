/** Shared 2D artwork: immediately usable without Three.js or the physics engine. */
export interface BadgeMessage { id: string; count: number; name: string; label: string }

export function drawBadge(canvas: HTMLCanvasElement, back: boolean, message?: BadgeMessage): void {
  const c = canvas.getContext('2d')!
  c.save(); c.scale(canvas.width / 512, canvas.height / 704)
  c.textAlign = 'left'
  c.fillStyle = back ? '#cbd2d5' : '#253235'; c.fillRect(0, 0, 512, 704)
  if (back && message?.count) {
    const ink = '#253235', muted = '#43525a'
    c.textAlign = 'center'; c.fillStyle = muted; c.font = '600 56px sans-serif'; c.fillText('伙伴消息', 256, 104)
    c.fillStyle = '#b8c3c8'; c.beginPath(); c.roundRect(164, 154, 184, 132, 34); c.fill()
    c.fillStyle = ink; c.font = '600 90px sans-serif'; c.fillText(message.count > 99 ? '99+' : String(message.count), 256, 252)
    c.font = '600 76px sans-serif'
    const chars = Array.from(message.name), originalLength = chars.length
    while (chars.length && c.measureText(chars.join('') + (chars.length < originalLength ? '…' : '')).width > 430) chars.pop()
    c.fillText(chars.join('') + (chars.length < originalLength ? '…' : ''), 256, 411)
    c.font = '500 74px sans-serif'; c.fillText(message.label, 256, 514)
    c.fillStyle = muted; c.font = '500 52px sans-serif'; c.fillText('点击查看', 256, 628)
    c.restore(); return
  }
  c.fillStyle = back ? '#536a65' : '#b6cbc2'; c.font = '500 28px sans-serif'; c.fillText('DSH / PARTNER', 49, 90)
  c.beginPath(); c.arc(256, 305, 116, 0, Math.PI * 2); c.fillStyle = back ? '#d5dcda' : '#334749'; c.fill()
  // Original geometric companion emblem, not an external image request.
  c.fillStyle = back ? '#526663' : '#bfd4c9'; c.beginPath(); c.moveTo(179, 338); c.lineTo(183, 229); c.lineTo(225, 264); c.quadraticCurveTo(256, 248, 287, 264); c.lineTo(329, 229); c.lineTo(333, 338); c.quadraticCurveTo(255, 392, 179, 338); c.fill()
  c.fillStyle = back ? '#dce4df' : '#263536'; c.beginPath(); c.ellipse(228, 314, 9, 19, -.15, 0, Math.PI * 2); c.ellipse(284, 314, 9, 19, .15, 0, Math.PI * 2); c.fill()
  c.textAlign = 'center'; c.fillStyle = back ? '#253235' : '#f1f3ec'; c.font = '600 48px sans-serif'; c.fillText(back ? 'TAKE A BREAK' : 'WITH YOU', 256, 515)
  c.fillStyle = back ? '#536663' : '#b6c5c1'; c.font = '24px sans-serif'; c.fillText(back ? 'A little pause. A little play.' : 'Always a little closer.', 256, 559)
  c.fillStyle = back ? '#b3beb8' : '#6d8b80'; c.fillRect(213, 608, 86, 5)
  c.restore()
}
