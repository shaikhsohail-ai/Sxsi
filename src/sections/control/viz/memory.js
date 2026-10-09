/**
 * SYS-02 · MEMORY — orbital rings that capture and hold drifting nodes.
 *
 * Nodes drift in from deep space. When one crosses a ring it may be captured:
 * it eases onto the orbit and is held there, linked to its neighbours. Each
 * ring has a capacity; when it's full the oldest memory is released and
 * drifts away. Rings are tilted ellipses with a dim far side for depth.
 * The pointer is a gentle gravity well.
 */
import { seededRandom, pad } from '../../../lib/dom.js'
import { byTier } from '../../../lib/quality.js'
import { glowSprite, drawGlow, label, easeOut, sat, TAU } from './core.js'

const RX = [0.2, 0.355, 0.53, 0.74] // ring semi-major axes (× unit)
const FLAT = 0.4 // ry / rx
const OMEGA = [0.62, 0.4, 0.27, 0.19] // rad/s, inner rings faster
const CAP = [3, 5, 7, 9]
const CAPTURE_TIME = 0.75

export function createMemory({ pal, seed = 2 }) {
  const rand = seededRandom(seed * 31337)
  const maxDrift = byTier({ high: 10, medium: 8, low: 6 })
  const glowIon = glowSprite(pal.ion)
  const glowAtmo = glowSprite(pal.atmo)

  const tilt = -0.2
  const cosT = Math.cos(tilt)
  const sinT = Math.sin(tilt)
  let cx = 0
  let cy = 0
  let unit = 100
  let w = 0
  let h = 0
  let hudLine = 0 // bottom of the tile HUD: drifters fade out above it

  const held = [] // { ring, th, born, cap, fx, fy, x, y, front }
  const drift = [] // { x, y, vx, vy, q: [] }
  const loose = [] // released memories: { x, y, vx, vy, life }
  const flashes = [] // { x, y, t0 }
  let spawnClock = 0
  let time = 0
  let lastCapture = -9
  let seeded = false

  const api = { status: 'Holding', tone: '', resize, step, draw, trigger, settle, readout }
  return api

  /* ---- Geometry ------------------------------------------------------------------ */
  function resize(s) {
    w = s.w
    h = s.h
    hudLine = s.band.top
    if (w / h > 1.3) {
      cx = w * 0.64
      cy = h * 0.5
      unit = Math.min(h * 1.02, w * 0.62)
    } else {
      cx = w * 0.56
      cy = s.band.mid + 6
      unit = Math.min(w * 1.04, s.band.h * 1.9)
    }
    if (!seeded) {
      seeded = true
      // Start with a few memories already in orbit.
      for (let i = 0; i < 9; i++) capture(i % 4, rand() * TAU, true)
    }
  }

  function ringPoint(i, th) {
    const rx = unit * RX[i]
    const ry = rx * FLAT
    const lx = Math.cos(th) * rx
    const ly = Math.sin(th) * ry
    return [cx + lx * cosT - ly * sinT, cy + lx * sinT + ly * cosT]
  }

  /** Normalised elliptical radius of (x, y) relative to ring i (1 = on the ring). */
  function ringQ(i, x, y) {
    const dx = x - cx
    const dy = y - cy
    const lx = dx * cosT + dy * sinT
    const ly = -dx * sinT + dy * cosT
    const rx = unit * RX[i]
    return Math.hypot(lx / rx, ly / (rx * FLAT))
  }

  function ringAngle(i, x, y) {
    const dx = x - cx
    const dy = y - cy
    const lx = dx * cosT + dy * sinT
    const ly = -dx * sinT + dy * cosT
    const rx = unit * RX[i]
    return Math.atan2(ly / (rx * FLAT), lx / rx)
  }

  /* ---- Simulation ---------------------------------------------------------------------- */
  function spawn(aimed = false) {
    if (drift.length >= maxDrift + (aimed ? 6 : 0)) return
    // Enter from the left/top/bottom edges, heading roughly at the core.
    const side = aimed ? 0 : rand()
    let x
    let y
    if (side < 0.5) {
      x = -10
      y = h * (0.1 + rand() * 0.8)
    } else if (side < 0.75) {
      x = w * (0.15 + rand() * 0.8)
      y = -10
    } else {
      x = w * (0.15 + rand() * 0.8)
      y = h + 10
    }
    const ang = Math.atan2(cy - y, cx - x) + (rand() - 0.5) * (aimed ? 0.35 : 0.9)
    const speed = (aimed ? 70 : 34) + rand() * 26
    drift.push({ x, y, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed, q: RX.map(() => NaN) })
  }

  function capture(ring, th, instant = false, fx = 0, fy = 0) {
    const onRing = held.filter((m) => m.ring === ring)
    if (onRing.length >= CAP[ring]) {
      // Release the oldest memory on this ring.
      const old = onRing.reduce((a, b) => (a.born < b.born ? a : b))
      held.splice(held.indexOf(old), 1)
      const [ox, oy] = ringPoint(old.ring, old.th)
      const dx = ox - cx
      const dy = oy - cy
      const d = Math.hypot(dx, dy) || 1
      loose.push({ x: ox, y: oy, vx: (dx / d) * 30 - (dy / d) * 20, vy: (dy / d) * 30 + (dx / d) * 20, life: 1 })
    }
    held.push({ ring, th, born: time, cap: instant ? 1 : 0, fx, fy, x: 0, y: 0, front: true })
  }

  function step(dt, s) {
    time += dt
    const e = s.energy

    spawnClock -= dt * (1 + e * 1.6)
    if (spawnClock <= 0) {
      spawn()
      spawnClock = 1.1 + rand() * 1.2
    }

    // Drifters: mild pull toward the core, stronger toward the pointer.
    for (let k = drift.length - 1; k >= 0; k--) {
      const d = drift[k]
      let ax = cx - d.x
      let ay = cy - d.y
      const dist = Math.hypot(ax, ay) || 1
      ax = (ax / dist) * 7
      ay = (ay / dist) * 7
      if (s.pointer) {
        const px = s.mx - d.x
        const py = s.my - d.y
        const pd = Math.hypot(px, py) || 1
        if (pd < 170) {
          const f = 70 * (1 - pd / 170)
          ax += (px / pd) * f
          ay += (py / pd) * f
        }
      }
      d.vx += ax * dt
      d.vy += ay * dt
      d.x += d.vx * dt
      d.y += d.vy * dt

      let caught = false
      for (let i = 0; i < RX.length && !caught; i++) {
        const q = ringQ(i, d.x, d.y)
        const prev = d.q[i]
        d.q[i] = q
        if (Number.isNaN(prev) || (prev - 1) * (q - 1) > 0) continue
        // Crossed ring i — inner rings are stickier.
        if (rand() < 0.62 - i * 0.07) {
          capture(i, ringAngle(i, d.x, d.y), false, d.x, d.y)
          flashes.push({ x: d.x, y: d.y, t0: time })
          lastCapture = time
          caught = true
        }
      }
      if (caught || d.x < -40 || d.x > w + 40 || d.y < -40 || d.y > h + 40) drift.splice(k, 1)
    }

    for (const m of held) {
      m.th += OMEGA[m.ring] * dt * (1 + e * 0.5)
      if (m.cap < 1) m.cap = Math.min(1, m.cap + dt / CAPTURE_TIME)
    }

    for (let k = loose.length - 1; k >= 0; k--) {
      const l = loose[k]
      l.x += l.vx * dt
      l.y += l.vy * dt
      l.life -= dt / 2.2
      if (l.life <= 0) loose.splice(k, 1)
    }
    for (let k = flashes.length - 1; k >= 0; k--) if (time - flashes[k].t0 > 1) flashes.splice(k, 1)

    api.status = time - lastCapture < 1.1 ? 'Capture' : 'Holding'
  }

  function trigger() {
    for (let i = 0; i < 6; i++) spawn(true)
  }

  function settle(s) {
    for (let i = 0; i < 360; i++) step(1 / 30, s)
    flashes.length = 0
    api.status = 'Holding'
  }

  function readout() {
    return `Held ${pad(held.length)} · Drift ${pad(drift.length)}`
  }

  /* ---- Drawing -------------------------------------------------------------------------------- */
  function draw(ctx, s) {
    const boot = s.boot
    if (boot <= 0) return
    const e = s.energy
    const grow = easeOut(boot * 1.4)

    // Positions
    for (const m of held) {
      const [ox, oy] = ringPoint(m.ring, m.th)
      if (m.cap < 1) {
        const k = easeOut(m.cap)
        m.x = m.fx + (ox - m.fx) * k
        m.y = m.fy + (oy - m.fy) * k
      } else {
        m.x = ox
        m.y = oy
      }
      m.front = Math.sin(m.th) > 0
    }

    // Far halves of the rings
    drawRings(ctx, grow, e, false)

    // Associations between nearby memories
    ctx.strokeStyle = pal.atmo.rgb
    ctx.lineWidth = 1
    const maxD = unit * 0.3
    for (let i = 0; i < held.length; i++) {
      const a = held[i]
      for (let j = i + 1; j < held.length; j++) {
        const b = held[j]
        if (Math.abs(a.ring - b.ring) !== 1) continue
        const d = Math.hypot(a.x - b.x, a.y - b.y)
        if (d > maxD) continue
        ctx.globalAlpha = boot * (1 - d / maxD) * (0.22 + e * 0.15) * Math.min(a.cap, b.cap)
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
      }
    }

    drawTrails(ctx, grow, e)
    for (const m of held) if (!m.front) drawMemory(ctx, m, boot * 0.5, e)

    // Core
    drawGlow(ctx, glowAtmo, cx, cy, unit * 0.2, boot * (0.55 + e * 0.25))
    drawGlow(ctx, glowIon, cx, cy, unit * 0.06, boot * 0.9)
    ctx.globalAlpha = boot
    ctx.fillStyle = pal.text.rgb
    ctx.beginPath()
    ctx.arc(cx, cy, 2.4, 0, TAU)
    ctx.fill()

    drawRings(ctx, grow, e, true)
    for (const m of held) if (m.front) drawMemory(ctx, m, boot, e)

    // Drifters with short tails (faded out where they'd cross the HUD text)
    ctx.lineWidth = 1
    for (const d of drift) {
      const sp = Math.hypot(d.vx, d.vy) || 1
      const tail = 26
      const vis = sat((d.y - hudLine + 10) / 36)
      if (vis <= 0.01) continue
      const grad = ctx.createLinearGradient(d.x, d.y, d.x - (d.vx / sp) * tail, d.y - (d.vy / sp) * tail)
      grad.addColorStop(0, pal.ion.a(0.7))
      grad.addColorStop(1, pal.ion.a(0))
      ctx.globalAlpha = boot * vis
      ctx.strokeStyle = grad
      ctx.beginPath()
      ctx.moveTo(d.x, d.y)
      ctx.lineTo(d.x - (d.vx / sp) * tail, d.y - (d.vy / sp) * tail)
      ctx.stroke()
      ctx.fillStyle = pal.text.rgb
      ctx.fillRect(d.x - 1, d.y - 1, 2, 2)
    }

    // Released memories drifting off
    ctx.fillStyle = pal.atmo.rgb
    for (const l of loose) {
      ctx.globalAlpha = boot * l.life * 0.6
      ctx.fillRect(l.x - 1, l.y - 1, 2, 2)
    }

    // Capture flashes
    ctx.strokeStyle = pal.ion.rgb
    for (const f of flashes) {
      const k = (time - f.t0) / 1
      ctx.globalAlpha = boot * (1 - k) * 0.7
      ctx.beginPath()
      ctx.arc(f.x, f.y, 3 + easeOut(k) * 16, 0, TAU)
      ctx.stroke()
    }
  }

  function drawRings(ctx, grow, e, front) {
    ctx.lineWidth = 1
    for (let i = 0; i < RX.length; i++) {
      const rx = unit * RX[i] * (0.86 + 0.14 * grow)
      const ry = rx * FLAT
      ctx.strokeStyle = pal.atmo.rgb
      ctx.globalAlpha = grow * (front ? 0.42 + e * 0.25 : 0.14 + e * 0.08)
      ctx.beginPath()
      // Canvas ellipse angles run clockwise; the near half is sin(θ) > 0.
      if (front) ctx.ellipse(cx, cy, rx, ry, tilt, 0, Math.PI)
      else ctx.ellipse(cx, cy, rx, ry, tilt, Math.PI, Math.PI * 2)
      ctx.stroke()
      if (front) {
        const [lx, ly] = ringPoint(i, 0)
        label(ctx, `L${i + 1}`, lx + 8, ly + 1, { alpha: grow * 0.5, size: 8 })
      }
    }
  }

  /** Comet trails: each held memory leaves a fading arc along its orbit. */
  function drawTrails(ctx, grow, e) {
    const SEG = 0.16
    ctx.lineWidth = 1.4
    ctx.lineCap = 'round'
    ctx.strokeStyle = pal.ion.rgb
    for (const front of [false, true]) {
      for (let k = 0; k < 3; k++) {
        ctx.globalAlpha = grow * grow * (0.14 + k * 0.2 + e * 0.1) * (front ? 1 : 0.45)
        ctx.beginPath()
        for (const m of held) {
          if (m.front !== front || m.cap < 1) continue
          const rx = unit * RX[m.ring]
          const a1 = m.th - (2 - k) * SEG
          const a0 = a1 - SEG
          const [x0, y0] = ringPoint(m.ring, a0)
          ctx.moveTo(x0, y0)
          ctx.ellipse(cx, cy, rx, rx * FLAT, tilt, a0, a1)
        }
        ctx.stroke()
      }
    }
    ctx.lineCap = 'butt'
  }

  function drawMemory(ctx, m, alpha, e) {
    const young = Math.max(0, 1 - (time - m.born) / 1.4)
    const r = 1.6 + young * 1.4
    drawGlow(ctx, glowIon, m.x, m.y, 9 + young * 10 + e * 3, alpha * (0.45 + young * 0.4))
    ctx.globalAlpha = alpha
    ctx.fillStyle = pal.text.rgb
    ctx.beginPath()
    ctx.arc(m.x, m.y, r, 0, TAU)
    ctx.fill()
  }
}
