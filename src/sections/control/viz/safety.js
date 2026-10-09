/**
 * SYS-04 · SAFETY — a "launch abort system" for intelligence: an energy core
 * held inside concentric, counter-rotating shields.
 *
 * The core throws off flares; every one is absorbed by the inner shield
 * (impact ripples along the ring). Each shield carries an alignment notch,
 * and all of them stay locked to the same axis — aligned by design. The
 * pointer is tracked by the outer shield. An abort test surges the core to
 * ignition orange, fires a ring of flares, and the shields contract and hold.
 */
import { seededRandom } from '../../../lib/dom.js'
import { byTier } from '../../../lib/quality.js'
import { glowSprite, drawGlow, label, easeOut, approach, wrapAngle, dotted, TAU } from './core.js'

const SHIELDS = [
  { r: 0.5, n: 14, gap: 0.3, w: 2, omega: 0.16 },
  { r: 0.71, n: 22, gap: 0.26, w: 1.5, omega: -0.1 },
  { r: 0.92, n: 36, gap: 0.42, w: 1.2, omega: 0.055 },
]
const CORE = 0.17
const ABORT = 3.4 // seconds
const SHIELD_LABELS = SHIELDS.map((_, i) => `S${i + 1}`)
const AXIS_DASH = [2, 3]

export function createSafety({ pal, seed = 4 }) {
  const rand = seededRandom(seed * 6151)
  const filaments = byTier({ high: 7, medium: 6, low: 4 })
  const plasmaSteps = byTier({ high: 72, medium: 60, low: 44 })
  const glowIon = glowSprite(pal.ion)
  const glowAtmo = glowSprite(pal.atmo)
  const glowIgnite = glowSprite(pal.ignite)
  const glowSoft = glowSprite(pal.igniteSoft)
  // Plasma loop sample angles: their trig (and harmonics) are the same every frame.
  const plasmaCos = new Float64Array(plasmaSteps + 1)
  const plasmaSin = new Float64Array(plasmaSteps + 1)
  const plasmaTh3 = new Float64Array(plasmaSteps + 1)
  const plasmaTh5 = new Float64Array(plasmaSteps + 1)
  const plasmaTh8 = new Float64Array(plasmaSteps + 1)
  for (let j = 0; j <= plasmaSteps; j++) {
    const th = (j / plasmaSteps) * TAU
    plasmaCos[j] = Math.cos(th)
    plasmaSin[j] = Math.sin(th)
    plasmaTh3[j] = 3 * th
    plasmaTh5[j] = 5 * th
    plasmaTh8[j] = 8 * th
  }

  let cx = 0
  let cy = 0
  let R = 100
  let time = 0
  let flareClock = 1
  let abortT = -99
  let trackA = -Math.PI / 2
  let trackI = 0
  const flares = [] // { ang, t0, dur, wob, hot }
  const impacts = [] // { ring, ang, t0, hot }
  // The containment-field gradient only changes with the layout, or while an abort tints it.
  let fieldGrad = null
  let fieldHot = false
  let scaleTicks = null // Path2D: the full bearing scale (once the boot has drawn it in)
  // Each fully revealed shield's segments, traced unrotated about the origin
  // for its current radius; a frame rotates them into place.
  const shieldPaths = SHIELDS.map(() => ({ r: -1, path: null }))
  let trackDeg = NaN
  let trackText = ''

  const api = { status: 'Contained', tone: '', resize, step, draw, trigger, settle, readout }
  return api

  function resize(s) {
    R = Math.min(s.w * 0.36, s.band.h * 0.395)
    cx = s.w * 0.5
    cy = s.band.mid - R * 0.04
    fieldGrad = null
    scaleTicks = null
  }

  /** Abort envelope: quick surge, hold, long settle. */
  function abortLevel() {
    const k = time - abortT
    if (k < 0 || k > ABORT) return 0
    if (k < 0.25) return easeOut(k / 0.25)
    if (k < 1.1) return 1
    return 1 - easeOut((k - 1.1) / (ABORT - 1.1))
  }

  function emitFlare(ang, hot = false) {
    flares.push({ ang, t0: time, dur: hot ? 0.32 : 0.42 + rand() * 0.2, wob: rand() * 10, hot })
  }

  function step(dt, s) {
    time += dt
    flareClock -= dt * (1 + s.energy * 1.5)
    if (flareClock <= 0) {
      emitFlare(rand() * TAU)
      flareClock = 0.9 + rand() * 1.8
    }
    for (let k = flares.length - 1; k >= 0; k--) {
      const f = flares[k]
      if (!f.hit && time - f.t0 >= f.dur) {
        f.hit = true
        impacts.push({ ring: 0, ang: f.ang, t0: time, hot: f.hot })
        // A hot impact also rings the next shield, a beat later.
        if (f.hot) impacts.push({ ring: 1, ang: f.ang, t0: time + 0.12, hot: true })
      }
      if (time - f.t0 > f.dur + 0.5) flares.splice(k, 1)
    }
    for (let k = impacts.length - 1; k >= 0; k--) if (time - impacts[k].t0 > 1.6) impacts.splice(k, 1)

    // Outer shield tracks the pointer bearing.
    if (s.pointer) {
      const target = Math.atan2(s.my - cy, s.mx - cx)
      trackA += wrapAngle(target - trackA) * approach(8, dt)
    }
    trackI += ((s.pointer ? 1 : 0) - trackI) * approach(5, dt)

    const k = time - abortT
    if (k >= 0 && k < ABORT + 0.4) {
      api.status = k < 1.3 ? 'Abort test' : 'Contained'
      api.tone = k < 1.3 ? 'ignite' : ''
    } else {
      api.status = s.pointer ? 'Tracking' : 'Contained'
      api.tone = ''
    }
  }

  function trigger() {
    abortT = time
    for (let i = 0; i < 12; i++) emitFlare((i / 12) * TAU + rand() * 0.2, true)
  }

  function settle(s) {
    for (let i = 0; i < 120; i++) step(1 / 30, s)
    // A couple of fresh impacts for a still with some life in it.
    impacts.push({ ring: 0, ang: -0.6, t0: time - 0.25 }, { ring: 0, ang: 2.3, t0: time - 0.6 })
    api.status = 'Contained'
    api.tone = ''
  }

  function readout() {
    return 'Containment 100.0%'
  }

  /* ---- Drawing ------------------------------------------------------------------------- */
  function draw(ctx, s) {
    const boot = s.boot
    if (boot <= 0) return
    const e = s.energy
    const ab = abortLevel()
    const grow = easeOut(boot * 1.2)
    const squeeze = 1 - ab * 0.05

    // Containment field
    if (!fieldGrad || ab > 0 || fieldHot) {
      fieldGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * SHIELDS[0].r)
      fieldGrad.addColorStop(0, (ab > 0.01 ? pal.ignite : pal.atmo).a(0.1 + ab * 0.12))
      fieldGrad.addColorStop(1, pal.atmo.a(0))
      fieldHot = ab > 0
    }
    ctx.globalAlpha = grow
    ctx.fillStyle = fieldGrad
    ctx.beginPath()
    ctx.arc(cx, cy, R * SHIELDS[0].r * squeeze, 0, TAU)
    ctx.fill()

    drawScale(ctx, grow)
    drawAxis(ctx, grow)

    // Shields
    for (let i = 0; i < SHIELDS.length; i++) {
      const sh = SHIELDS[i]
      const r = R * sh.r * squeeze * (0.82 + 0.18 * grow)
      const rot = time * sh.omega * (1 + e * 0.6)
      const segA = TAU / sh.n
      const len = segA * (1 - sh.gap)
      const reveal = Math.min(sh.n, Math.ceil(sh.n * Math.min(1, boot * 1.6 - i * 0.2)))
      if (reveal <= 0) continue
      ctx.strokeStyle = pal.atmo.rgb
      ctx.lineWidth = sh.w
      ctx.globalAlpha = grow * (0.48 + e * 0.25 + ab * 0.35)
      if (reveal < sh.n) {
        // Powering on: segments appear one by one.
        ctx.beginPath()
        segments(ctx, cx, cy, r, rot, reveal, segA, len)
        ctx.stroke()
      } else {
        const cache = shieldPaths[i]
        if (cache.r !== r) {
          cache.r = r
          cache.path = new Path2D()
          segments(cache.path, 0, 0, r, 0, sh.n, segA, len)
        }
        ctx.save()
        ctx.translate(cx, cy)
        ctx.rotate(rot)
        ctx.stroke(cache.path)
        ctx.restore()
      }
      // Inner hairline: the shield's second skin
      ctx.lineWidth = 1
      ctx.globalAlpha = grow * 0.12
      ctx.beginPath()
      ctx.arc(cx, cy, r - 5, 0, TAU)
      ctx.stroke()

      // Alignment notch, locked to the vertical axis
      ctx.globalAlpha = grow * 0.95
      ctx.fillStyle = pal.text.rgb
      ctx.beginPath()
      ctx.moveTo(cx, cy - r + 4)
      ctx.lineTo(cx - 3.5, cy - r - 4)
      ctx.lineTo(cx + 3.5, cy - r - 4)
      ctx.closePath()
      ctx.fill()
      label(ctx, SHIELD_LABELS[i], cx + 9, cy - r - 2, { alpha: grow * 0.5, size: 8 })
    }

    // Impacts: a hot flare of light on the shield, rippling outwards along it
    ctx.lineCap = 'round'
    for (let i = 0; i < impacts.length; i++) {
      const im = impacts[i]
      const k = (time - im.t0) / 1.6
      if (k < 0) continue
      const r = R * SHIELDS[im.ring].r * squeeze
      const fade = 1 - easeOut(k)
      const color = im.hot ? pal.igniteSoft : pal.ion
      ctx.strokeStyle = color.rgb
      ctx.globalCompositeOperation = 'lighter'
      ctx.lineWidth = 7
      ctx.globalAlpha = grow * fade * 0.18
      ctx.beginPath()
      ctx.arc(cx, cy, r, im.ang - 0.35, im.ang + 0.35)
      ctx.stroke()
      ctx.globalCompositeOperation = 'source-over'
      ctx.lineWidth = 2.2
      ctx.globalAlpha = grow * fade * 0.95
      ctx.beginPath()
      ctx.arc(cx, cy, r, im.ang - 0.18 * (1 - k), im.ang + 0.18 * (1 - k))
      ctx.stroke()
      // Ripples travelling both ways along the shield
      const spread = easeOut(k) * 0.9
      ctx.lineWidth = 1.5
      ctx.globalAlpha = grow * fade * 0.7
      ctx.beginPath()
      ctx.arc(cx, cy, r, im.ang + spread, im.ang + spread + 0.09)
      ctx.moveTo(cx + Math.cos(im.ang - spread - 0.09) * r, cy + Math.sin(im.ang - spread - 0.09) * r)
      ctx.arc(cx, cy, r, im.ang - spread - 0.09, im.ang - spread)
      ctx.stroke()
      drawGlow(ctx, im.hot ? glowSoft : glowIon, cx + Math.cos(im.ang) * r, cy + Math.sin(im.ang) * r, 18, grow * fade * 0.6)
    }
    ctx.lineCap = 'butt'

    // Pointer tracking on the outer shield
    if (trackI > 0.02) {
      const r = R * SHIELDS[2].r * squeeze + 9
      ctx.strokeStyle = pal.text.rgb
      ctx.lineWidth = 2
      ctx.globalAlpha = grow * trackI * 0.9
      ctx.beginPath()
      ctx.arc(cx, cy, r, trackA - 0.22, trackA + 0.22)
      ctx.stroke()
      const deg = Math.round(((trackA + Math.PI / 2 + TAU * 2) % TAU) * (180 / Math.PI))
      if (deg !== trackDeg) {
        trackDeg = deg
        trackText = `TRK ${String(deg).padStart(3, '0')}°`
      }
      const lx = cx + Math.cos(trackA) * (r + 18)
      const ly = cy + Math.sin(trackA) * (r + 18)
      label(ctx, trackText, lx, ly, {
        alpha: grow * trackI * 0.9,
        size: 8,
        align: Math.cos(trackA) > 0.2 ? 'left' : Math.cos(trackA) < -0.2 ? 'right' : 'center',
      })
    }

    drawFlares(ctx, grow)
    drawCore(ctx, grow, e, ab)
  }

  function drawScale(ctx, grow) {
    const r = R * 1.06
    ctx.strokeStyle = pal.text.rgb
    ctx.lineWidth = 1
    ctx.globalAlpha = grow * 0.22
    if (grow < 1) {
      // Drawing in: the scale is traced as it grows.
      ctx.beginPath()
      scalePath(ctx, r, grow)
      ctx.stroke()
    } else {
      if (!scaleTicks) scalePath((scaleTicks = new Path2D()), r, 1)
      ctx.stroke(scaleTicks)
    }
    label(ctx, '090', cx + r + 14, cy, { alpha: grow * 0.42, size: 8 })
    label(ctx, '270', cx - r - 14, cy, { alpha: grow * 0.42, size: 8, align: 'right' })
  }

  /** Traces `count` shield segments (arcs of `len`, every `segA`) from angle `rot`. */
  function segments(g, x, y, r, rot, count, segA, len) {
    for (let k = 0; k < count; k++) {
      const a0 = rot + k * segA
      g.moveTo(x + Math.cos(a0) * r, y + Math.sin(a0) * r)
      g.arc(x, y, r, a0, a0 + len)
    }
  }

  function scalePath(g, r, grow) {
    const n = 120
    for (let i = 0; i < n * grow; i++) {
      const a = (i / n) * TAU - Math.PI / 2
      const len = i % 10 === 0 ? 7 : 3
      const ca = Math.cos(a)
      const sa = Math.sin(a)
      g.moveTo(cx + ca * r, cy + sa * r)
      g.lineTo(cx + ca * (r + len), cy + sa * (r + len))
    }
  }

  function drawAxis(ctx, grow) {
    const top = cy - R * 1.13
    const bottom = cy + R * 1.16
    const x = Math.round(cx) + 0.5
    dotted(ctx, x, top, x, bottom, AXIS_DASH, pal.text.rgb, grow * 0.22)
    // Read beside the axis foot, clear of the tile copy below.
    label(ctx, 'ALIGN 1.000 · AXIS LOCKED', cx + 9, bottom - 3, { alpha: grow * 0.62, size: 8 })
  }

  function drawFlares(ctx, grow) {
    const r0 = R * CORE
    const r1 = R * SHIELDS[0].r
    ctx.lineWidth = 1.2
    for (let i = 0; i < flares.length; i++) {
      const f = flares[i]
      const p = (time - f.t0) / f.dur
      const head = Math.min(1, p)
      const tail = Math.max(0, (p - 0.35) / 1.0)
      if (tail >= 1) continue
      ctx.strokeStyle = f.hot ? pal.igniteSoft.rgb : pal.ion.rgb
      ctx.globalAlpha = grow * (f.hot ? 0.95 : 0.75) * (1 - tail)
      ctx.beginPath()
      const steps = 14
      for (let k = 0; k <= steps; k++) {
        const u = tail + ((head - tail) * k) / steps
        const rr = r0 + (r1 - r0) * u
        const ang = f.ang + Math.sin(u * 9 + f.wob + time * 6) * 0.06 * u
        const x = cx + Math.cos(ang) * rr
        const y = cy + Math.sin(ang) * rr
        if (k === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()
    }
  }

  function drawCore(ctx, grow, e, ab) {
    const breathe = 1 + Math.sin(time * 2.1) * 0.04 + ab * 0.3
    const r = R * CORE * breathe * grow
    drawGlow(ctx, glowAtmo, cx, cy, R * 0.8, grow * (0.42 + e * 0.2) * (1 - ab * 0.5))
    if (ab > 0.01) drawGlow(ctx, glowIgnite, cx, cy, R * 0.85, grow * ab * 0.75)

    // Plasma: layered closed loops whose radius is perturbed by drifting
    // harmonics, added together — a contained star rather than an orbit icon.
    const hot = ab > 0.3
    const amp = 0.09 + e * 0.05 + ab * 0.16
    const speed = 1 + ab * 2.2
    ctx.globalCompositeOperation = 'lighter'
    ctx.lineWidth = 1
    ctx.strokeStyle = hot ? pal.igniteSoft.rgb : pal.ion.rgb
    const n = plasmaSteps
    // Loop invariants, hoisted (same operands, same order: same values)
    const drift3 = time * 1.3 * speed
    const drift5 = time * 1.9 * speed
    const drift8 = time * 2.7 * speed
    for (let i = 0; i < filaments; i++) {
      const k = i / Math.max(1, filaments - 1)
      const base = r * (0.62 + k * 0.62)
      const ph = i * 1.7
      const ph5 = ph * 2.1
      const swell = amp * (1 + k)
      ctx.globalAlpha = grow * (0.36 - k * 0.2 + e * 0.1)
      ctx.beginPath()
      for (let j = 0; j <= n; j++) {
        const w =
          Math.sin(plasmaTh3[j] + drift3 + ph) * 0.55 +
          Math.sin(plasmaTh5[j] - drift5 + ph5) * 0.3 +
          Math.sin(plasmaTh8[j] + drift8 - ph) * 0.15
        const rr = base * (1 + swell * w)
        const x = cx + plasmaCos[j] * rr
        const y = cy + plasmaSin[j] * rr
        if (j) ctx.lineTo(x, y)
        else ctx.moveTo(x, y)
      }
      ctx.stroke()
    }
    ctx.globalCompositeOperation = 'source-over'

    // Photosphere and white-hot centre
    drawGlow(ctx, hot ? glowSoft : glowIon, cx, cy, r * 1.9, grow * 0.95)
    ctx.globalAlpha = grow * 0.55
    ctx.strokeStyle = hot ? pal.igniteSoft.rgb : pal.ion.rgb
    ctx.beginPath()
    ctx.arc(cx, cy, r * 0.5, 0, TAU)
    ctx.stroke()
    ctx.globalAlpha = grow
    ctx.fillStyle = pal.text.rgb
    ctx.beginPath()
    ctx.arc(cx, cy, Math.max(1.5, r * 0.26), 0, TAU)
    ctx.fill()
  }
}
