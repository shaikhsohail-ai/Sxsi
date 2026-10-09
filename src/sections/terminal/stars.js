/**
 * Paints a large, seeded starfield tile once and resolves with an object URL
 * for it (used as a repeating background). Big enough that the repeat never
 * shows on one screen; deterministic so every visit sees the same sky.
 * Encoding is async (toBlob), so it never blocks the page's init.
 */
import { seededRandom } from '../../lib/dom.js'
import { dpr } from '../../lib/quality.js'

export function starTile({ width = 1400, height = 1100, count = 120, seed = 7 } = {}) {
  const canvas = document.createElement('canvas')
  const scale = Math.min(dpr, 2)
  canvas.width = Math.round(width * scale)
  canvas.height = Math.round(height * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) return Promise.resolve(null)
  ctx.scale(scale, scale)
  const rand = seededRandom(seed)

  for (let i = 0; i < count; i++) {
    const x = rand() * width
    const y = rand() * height
    // Mostly faint pin-pricks, a few brighter stars, some with an ion tint.
    const bright = rand() ** 4
    const r = 0.45 + bright * 1.1
    const alpha = 0.25 + bright * 0.7
    const tint = rand() < 0.3 ? '199, 236, 255' : '255, 255, 255'
    ctx.fillStyle = `rgba(${tint}, ${alpha.toFixed(3)})`
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
    if (bright > 0.55) {
      const glow = ctx.createRadialGradient(x, y, 0, x, y, r * 5)
      glow.addColorStop(0, `rgba(${tint}, ${(alpha * 0.35).toFixed(3)})`)
      glow.addColorStop(1, `rgba(${tint}, 0)`)
      ctx.fillStyle = glow
      ctx.fillRect(x - r * 5, y - r * 5, r * 10, r * 10)
    }
  }
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob ? { url: URL.createObjectURL(blob), width, height } : null), 'image/png')
  })
}
