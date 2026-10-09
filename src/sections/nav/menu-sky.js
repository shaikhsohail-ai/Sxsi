/**
 * Menu backdrop — a "system map": seven tilted orbits, one per destination,
 * each with a satellite moving at its Keplerian rate (ω ∝ r^−1.5), over a
 * slowly drifting starfield. Hovering / focusing a menu item lights its orbit.
 *
 * Canvas 2D (no extra WebGL context). Renders only while the menu is open:
 * the overlay is display:none when closed, so createRenderLoop's
 * IntersectionObserver keeps the loop asleep.
 */
import { createRenderLoop } from '../../lib/visibility.js'
import { byTier, dpr as maxDpr } from '../../lib/quality.js'
import { seededRandom } from '../../lib/dom.js'

const ORBITS = 7
const TAU = Math.PI * 2
const ATMO = [111, 195, 255]
const ION = [199, 236, 255]

const rgba = ([r, g, b], a) => `rgba(${r},${g},${b},${a})`

export function createMenuSky(canvas, { root, labels = [], still = false } = {}) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  const rand = seededRandom(0x5a51)
  const stars = Array.from({ length: byTier({ high: 260, medium: 180, low: 110 }) }, () => ({
    x: rand(),
    y: rand(),
    r: Math.pow(rand(), 3) * 1.3 + 0.35,
    a: 0.18 + rand() * 0.6,
    tw: rand() * TAU,
    ts: 0.4 + rand() * 1.6,
  }))
  const phase = Array.from({ length: ORBITS }, () => rand() * TAU)
  const glow = new Float32Array(ORBITS) // smoothed highlight per orbit
  const ratio = Math.min(maxDpr, 2)

  let width = 0
  let height = 0
  let layout = null
  let target = -1
  let time = 0

  function resize() {
    width = canvas.clientWidth || window.innerWidth
    height = canvas.clientHeight || window.innerHeight
    canvas.width = Math.round(width * ratio)
    canvas.height = Math.round(height * ratio)
    const mobile = width <= 900 // matches the CSS thumb-reach layout
    // Desktop: the system sits right of the list. Mobile: in the sky above the
    // list, right of the position readout.
    const cx = mobile ? width * 0.62 : width * 0.765
    const cy = mobile ? height * 0.3 : height * 0.5
    const outer = mobile ? Math.min(width * 0.6, height * 0.36) : Math.min(width * 0.27, height * 0.5)
    const inner = outer * 0.2
    layout = {
      cx,
      cy,
      tilt: -0.24,
      squash: mobile ? 0.42 : 0.36,
      radii: Array.from({ length: ORBITS }, (_, i) => inner + ((outer - inner) * i) / (ORBITS - 1)),
      fade: mobile ? 0.8 : 1,
      planet: mobile ? 0.36 : 0.26, // planet radius relative to the first orbit
      mobile,
    }
  }

  /** Point on orbit i at angle θ (tilted ellipse). Returns [x, y, depth]. */
  function point(i, theta) {
    const { cx, cy, tilt, squash, radii } = layout
    const rx = radii[i]
    const ry = rx * squash
    const ex = Math.cos(theta) * rx
    const ey = Math.sin(theta) * ry
    const c = Math.cos(tilt)
    const s = Math.sin(tilt)
    return [cx + ex * c - ey * s, cy + ex * s + ey * c, Math.sin(theta)]
  }

  function draw(dt) {
    if (!layout) resize()
    const { cx, cy, tilt, squash, radii, fade, mobile, planet } = layout
    const k = 1 - Math.exp(-dt * 7)
    for (let i = 0; i < ORBITS; i++) glow[i] += ((i === target ? 1 : 0) - glow[i]) * k

    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.clearRect(0, 0, width, height)

    // ---- Deep-space glow behind the system ------------------------------
    const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, radii[ORBITS - 1] * 1.05)
    halo.addColorStop(0, `rgba(31,107,255,${0.1 * fade})`)
    halo.addColorStop(0.5, `rgba(31,107,255,${0.035 * fade})`)
    halo.addColorStop(1, 'rgba(31,107,255,0)')
    ctx.fillStyle = halo
    ctx.fillRect(0, 0, width, height)

    // ---- Stars (drift left, twinkle) -------------------------------------
    for (const star of stars) {
      const x = (((star.x - time * 0.0016 * star.r) % 1) + 1) % 1
      const a = star.a * (0.72 + 0.28 * Math.sin(time * star.ts + star.tw))
      ctx.fillStyle = `rgba(244,246,251,${a * 0.85})`
      ctx.fillRect(x * width, star.y * height, star.r, star.r)
    }

    // ---- Range furniture: crosshair + degree ring ------------------------
    const outer = radii[ORBITS - 1]
    ctx.lineWidth = 1
    ctx.strokeStyle = `rgba(244,246,251,${0.07 * fade})`
    ctx.beginPath()
    ctx.moveTo(cx - outer * 1.12, cy)
    ctx.lineTo(cx + outer * 1.12, cy)
    ctx.moveTo(cx, cy - outer * squash * 1.9)
    ctx.lineTo(cx, cy + outer * squash * 1.9)
    ctx.stroke()

    ctx.strokeStyle = `rgba(244,246,251,${0.16 * fade})`
    ctx.beginPath()
    const ringR = outer * 1.08
    for (let d = 0; d < 360; d += 5) {
      const a = (d / 360) * TAU
      const len = d % 30 === 0 ? 9 : 4
      const ca = Math.cos(a)
      const sa = Math.sin(a)
      ctx.moveTo(cx + ca * ringR, cy + sa * ringR * squash)
      ctx.lineTo(cx + ca * (ringR + len), cy + sa * (ringR + len) * squash)
    }
    ctx.stroke()

    // ---- Orbits ----------------------------------------------------------
    for (let i = 0; i < ORBITS; i++) {
      const g = glow[i]
      const rx = radii[i]
      ctx.beginPath()
      ctx.ellipse(cx, cy, rx, rx * squash, tilt, 0, TAU)
      if (g > 0.01) {
        // soft bloom under the lit orbit
        ctx.strokeStyle = rgba(ATMO, 0.12 * g)
        ctx.lineWidth = 5
        ctx.stroke()
      }
      ctx.strokeStyle = g > 0.01 ? rgba(ATMO, (0.14 + 0.6 * g) * fade) : `rgba(244,246,251,${(i % 2 ? 0.08 : 0.12) * fade})`
      ctx.lineWidth = 1
      ctx.setLineDash(i % 2 ? [2, 5] : [])
      ctx.stroke()
      ctx.setLineDash([])
    }

    // ---- Planet: a night-side sphere with a thin sunlit crescent -----------
    const pr = Math.max(6, radii[0] * planet)
    const lx = cx + pr * 0.55 // light comes from the upper right
    const ly = cy - pr * 0.55
    const air = ctx.createRadialGradient(cx, cy, pr, cx, cy, pr * 2.2)
    air.addColorStop(0, rgba(ATMO, 0.22 * fade))
    air.addColorStop(1, rgba(ATMO, 0))
    ctx.fillStyle = air
    ctx.beginPath()
    ctx.arc(cx, cy, pr * 2.2, 0, TAU)
    ctx.fill()
    const body = ctx.createRadialGradient(lx, ly, 0, lx, ly, pr * 1.7)
    body.addColorStop(0, `rgba(120,170,230,${0.75 * fade})`)
    body.addColorStop(0.35, `rgba(31,70,140,${0.5 * fade})`)
    body.addColorStop(1, '#02040a')
    ctx.fillStyle = body
    ctx.beginPath()
    ctx.arc(cx, cy, pr, 0, TAU)
    ctx.fill()
    ctx.strokeStyle = rgba(ION, 0.9 * fade)
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(cx, cy, pr + 0.5, -Math.PI * 0.95, Math.PI * 0.2)
    ctx.stroke()

    // ---- Satellites + trails + labels -----------------------------------
    ctx.font = '500 10px "JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace'
    ctx.textBaseline = 'middle'
    for (let i = 0; i < ORBITS; i++) {
      const g = glow[i]
      const omega = 0.32 * Math.pow(radii[i] / radii[0], -1.5)
      const theta = phase[i] + time * omega
      // trail: short fading arc behind the satellite
      const steps = 14
      const span = 0.55
      let prev = point(i, theta - span)
      for (let s = 1; s <= steps; s++) {
        const p = point(i, theta - span + (span * s) / steps)
        const a = (s / steps) ** 2 * (0.35 + 0.6 * g) * fade
        ctx.strokeStyle = g > 0.05 ? rgba(ATMO, a) : `rgba(244,246,251,${a * 0.8})`
        ctx.lineWidth = 1.2 + g
        ctx.beginPath()
        ctx.moveTo(prev[0], prev[1])
        ctx.lineTo(p[0], p[1])
        ctx.stroke()
        prev = p
      }
      const [x, y, depth] = point(i, theta)
      const lit = 0.55 + 0.45 * Math.max(0, depth) // brighter on the near side
      const r = 1.6 + g * 1.6
      if (g > 0.02) {
        ctx.fillStyle = rgba(ATMO, 0.22 * g)
        ctx.beginPath()
        ctx.arc(x, y, r * 4.5, 0, TAU)
        ctx.fill()
      }
      ctx.fillStyle = g > 0.05 ? rgba(ION, lit) : `rgba(244,246,251,${lit * fade})`
      ctx.beginPath()
      ctx.arc(x, y, r, 0, TAU)
      ctx.fill()

      // Mobile: only the lit orbit (current position) gets a label.
      if (!mobile || g > 0.05) {
        const label = String(i + 1).padStart(2, '0') + (g > 0.5 && labels[i] ? ` · ${labels[i]}` : '')
        const text = label.toUpperCase()
        const tw = ctx.measureText(text).width
        // Flip to the satellite's left rather than run off the edge.
        const tx = x + 9 + tw > width - 12 ? x - 9 - tw : x + 9
        ctx.fillStyle = g > 0.05 ? rgba(ATMO, 0.45 + 0.5 * g) : `rgba(244,246,251,${0.32 * lit})`
        ctx.fillText(text, tx, y - 9)
      }
    }
  }

  let lastStill = 0
  const frame = (t, dt) => {
    if (!still) time += dt
    draw(dt)
  }

  const loop = still ? null : createRenderLoop(root || canvas, frame, { rootMargin: '0px' })
  const onResize = () => {
    resize()
    if (still) draw(1)
  }
  window.addEventListener('resize', onResize)

  return {
    /** Light orbit `index` (−1 for none). */
    highlight(index) {
      target = index
      // Reduced motion: no loop — snap and redraw once.
      if (still) {
        glow.fill(0)
        if (index >= 0) glow[index] = 1
        cancelAnimationFrame(lastStill)
        lastStill = requestAnimationFrame(() => draw(1))
      }
    },
    /** Call when the overlay becomes visible (sizes may have changed). */
    refresh() {
      resize()
      if (still) draw(1)
    },
    destroy() {
      loop?.destroy()
      window.removeEventListener('resize', onResize)
    },
  }
}
