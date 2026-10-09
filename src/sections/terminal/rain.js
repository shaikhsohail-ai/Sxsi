/**
 * The `matrix` easter egg: two seconds of glyph rain over the screen, in
 * SXSI blue rather than film green. Self-contained rAF that ends itself and
 * removes its canvas; never called under reduced motion.
 */
import { dpr } from '../../lib/quality.js'

const GLYPHS = '01SXSI<>/\\=+*#ZXVN∆ΛΣΩ'

export function rain(host, duration = 2000) {
  return new Promise((resolve) => {
    const box = { width: host.clientWidth, height: host.clientHeight }
    if (!box.width || !box.height) return resolve()

    const canvas = document.createElement('canvas')
    canvas.className = 's-terminal__rain'
    canvas.setAttribute('aria-hidden', 'true')
    const scale = Math.min(dpr, 1.5)
    canvas.width = Math.round(box.width * scale)
    canvas.height = Math.round(box.height * scale)
    host.append(canvas)

    const ctx = canvas.getContext('2d')
    ctx.setTransform(scale, 0, 0, scale, 0, 0)
    const size = box.width < 520 ? 12 : 14
    const cols = Math.ceil(box.width / size)
    const rows = box.height / size
    // Seed most columns already in the frame so the rain lands at once.
    const drops = Array.from({ length: cols }, () => (Math.random() < 0.6 ? Math.floor(Math.random() * rows * 0.7) : -Math.floor(Math.random() * 8)))
    // Rows advanced per frame (< 1): each column steps one cell at its own pace.
    const speed = Array.from({ length: cols }, () => 0.3 + Math.random() * 0.55)
    const timer = new Float32Array(cols)
    const heads = new Array(cols).fill('')
    ctx.font = `500 ${size}px 'JetBrains Mono Variable', ui-monospace, monospace`
    ctx.textBaseline = 'top'
    ctx.textAlign = 'center'

    const start = performance.now()
    let raf = 0
    const frame = () => {
      const elapsed = performance.now() - start
      // Fade the previous frame → glowing trails
      ctx.fillStyle = 'rgba(2, 5, 11, 0.085)'
      ctx.fillRect(0, 0, box.width, box.height)
      for (let i = 0; i < cols; i++) {
        timer[i] += speed[i]
        if (timer[i] < 1) continue
        timer[i] -= 1
        const x = i * size + size / 2
        const y = drops[i] * size
        // Re-tint the previous head blue (it becomes trail), then draw a new bright head.
        if (heads[i]) {
          ctx.fillStyle = '#02050b'
          ctx.fillRect(x - size / 2, y - size, size, size)
          ctx.fillStyle = '#6fc3ff'
          ctx.fillText(heads[i], x, y - size)
        }
        heads[i] = GLYPHS[(Math.random() * GLYPHS.length) | 0]
        ctx.fillStyle = '#eaf6ff'
        ctx.fillText(heads[i], x, y)
        drops[i] += 1
        if (y > box.height && Math.random() > 0.9) drops[i] = -Math.floor(Math.random() * 6)
      }
      if (elapsed < duration) {
        raf = requestAnimationFrame(frame)
      } else {
        canvas.classList.add('is-out')
        setTimeout(() => {
          canvas.remove()
          resolve()
        }, 450)
      }
    }
    raf = requestAnimationFrame(frame)
    // Safety: never leave the overlay behind if the tab is hidden mid-rain.
    setTimeout(() => {
      if (canvas.isConnected) {
        cancelAnimationFrame(raf)
        canvas.remove()
        resolve()
      }
    }, duration + 1500)
  })
}
