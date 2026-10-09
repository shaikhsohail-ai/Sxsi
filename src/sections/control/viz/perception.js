/**
 * SYS-03 · PERCEPTION — a radar sweep revealing contacts, fed by a live
 * spectrum band.
 *
 * Contacts are only visible as the sweep passes (phosphor decay); on their
 * second pass they're resolved and labelled by modality (TXT, IMG, AUD…).
 * The spectrum spikes when contacts are painted. A ping reveals everything
 * at once. With a pointer inside the scope, the nearest contact is locked.
 */
import { seededRandom, pad } from '../../../lib/dom.js'
import { byTier } from '../../../lib/quality.js'
import { glowSprite, drawGlow, label, easeOut, approach, rectBatch, dotted, TAU, NO_DASH, hypot } from './core.js'

const KINDS = ['TXT', 'IMG', 'AUD', 'VID', 'SIG', 'GEO', 'DOC', 'SEN']
const DECAY = 0.75 // phosphor decay rate (1/s)
const FEED_DASH = [2, 2]
const LOCK_DASH = [2, 3]
// Corner brackets: the four corners' signs, walked with an index (no per-call arrays).
const CORNER_X = [-1, 1, 1, -1]
const CORNER_Y = [-1, -1, 1, 1]

export function createPerception({ pal, seed = 3 }) {
  const rand = seededRandom(seed * 92821)
  const count = byTier({ high: 11, medium: 10, low: 8 })
  const glowIon = glowSprite(pal.ion)
  const glowAtmo = glowSprite(pal.atmo)
  const hasConic = typeof CanvasRenderingContext2D !== 'undefined' && 'createConicGradient' in CanvasRenderingContext2D.prototype

  let cx = 0
  let cy = 0
  let R = 100
  let wave = null // { x0, x1, y, amp, bars: Float32Array }
  let a = -Math.PI / 2 // sweep angle
  let time = 0
  let serial = 1
  let lastResolve = -9
  let lockAlpha = 0
  let lockTarget = null
  let lockShown = null // last locked contact, kept while the lock fades out
  const contacts = []
  const pings = []
  const barBatch = rectBatch(12)
  const glow = new Float64Array(count) // per-frame phosphor intensity of each contact
  let bearingTicks = null // Path2D: the scope's bearing ticks (once the boot has drawn it in)
  const pt = [0, 0] // scratch point (pos() out-param)

  for (let i = 0; i < count; i++) contacts.push(makeContact(true))

  const api = { status: 'Scanning', tone: '', resize, step, draw, trigger, settle, readout }
  return api

  function makeContact(initial = false) {
    const c = {
      r: 0.18 + rand() * 0.76,
      th: rand() * TAU,
      dth: (rand() - 0.5) * 0.05,
      dr: (rand() - 0.5) * 0.012,
      hit: -99,
      hits: initial && rand() < 0.7 ? 1 : 0, // most of the opening picture is already tracked
      kind: KINDS[Math.floor(rand() * KINDS.length)],
      id: pad(serial++ % 100),
      tag: '',
      band: rand(),
      life: initial ? 6 + rand() * 20 : 14 + rand() * 14,
      fadeIn: initial ? 1 : 0,
    }
    c.tag = `${c.kind}-${c.id}`
    return c
  }

  /* ---- Layout --------------------------------------------------------------------- */
  function resize(s) {
    const wide = s.w / s.h > 1.3
    // Wide tiles: the scope sits right of centre, vertically centred and sized
    // to clear the HUD (top), the status pill and the run button (right).
    R = wide ? Math.min(s.h * 0.35, s.w * 0.205) : Math.min(s.w * 0.34, s.band.h * 0.4)
    cx = wide ? s.w - R - Math.max(60, s.w * 0.11) : s.w * 0.6
    cy = wide ? s.h * 0.5 : s.band.mid + 4
    const x0 = Math.max(20, s.w * 0.045)
    const x1 = cx - R - 40
    if (x1 - x0 > 110) {
      const n = Math.floor((x1 - x0) / 5)
      wave = { x0, x1: x0 + n * 5, y: wide ? s.h * 0.47 : s.band.mid, amp: s.h * 0.1, bars: new Float32Array(n) }
    } else {
      wave = null
    }
    bearingTicks = null
  }

  function pos(c, out) {
    out[0] = cx + Math.cos(c.th) * c.r * R
    out[1] = cy + Math.sin(c.th) * c.r * R
    return out
  }

  /* ---- Simulation --------------------------------------------------------------------- */
  function step(dt, s) {
    time += dt
    const e = s.energy
    const prev = a
    a += dt * (1.05 + e * 0.9)
    const swept = a - prev

    for (let i = 0; i < contacts.length; i++) {
      const c = contacts[i]
      c.th += c.dth * dt
      c.r = Math.min(0.95, Math.max(0.15, c.r + c.dr * dt))
      c.life -= dt
      c.fadeIn = Math.min(1, c.fadeIn + dt)
      if (c.life <= 0) {
        contacts[i] = makeContact()
        continue
      }
      // Did the sweep cross this contact's bearing this frame?
      const rel = (((c.th - prev) % TAU) + TAU) % TAU
      if (rel <= swept) paint(c)
    }

    for (let k = pings.length - 1; k >= 0; k--) {
      const p = pings[k]
      const prevR = p.r
      p.r = easeOut((time - p.t0) / 1.2)
      for (let i = 0; i < contacts.length; i++) {
        const c = contacts[i]
        if (c.r > prevR && c.r <= p.r) paint(c, true)
      }
      if (time - p.t0 > 1.4) pings.splice(k, 1)
    }

    // Pointer lock: the resolved contact nearest the pointer inside the scope.
    lockTarget = null
    if (s.pointer && hypot(s.mx - cx, s.my - cy) < R * 1.1) {
      let best = 60
      for (let i = 0; i < contacts.length; i++) {
        const c = contacts[i]
        if (c.hits < 2) continue
        pos(c, pt)
        const d = hypot(s.mx - pt[0], s.my - pt[1])
        if (d < best) {
          best = d
          lockTarget = c
        }
      }
    }
    lockAlpha += ((lockTarget ? 1 : 0) - lockAlpha) * approach(8, dt)
    if (lockTarget) lockShown = lockTarget

    if (wave) {
      const n = wave.bars.length
      const k = approach(10, dt)
      // Each contact's phosphor glow is the same for every bar: once per frame.
      // (Like the hoisted terms below: same operands, same order, same values.)
      for (let j = 0; j < contacts.length; j++) glow[j] = Math.exp(-(time - contacts[j].hit) * DECAY * 1.6)
      const t1 = time * 3.1
      const t2 = time * 1.3
      const t3 = time * 7.3
      const lift = e * 0.08
      for (let i = 0; i < n; i++) {
        const u = i / n
        let v = 0.14 + 0.1 * Math.sin(i * 0.37 + t1) * Math.sin(i * 0.11 - t2) + 0.06 * Math.sin(i * 1.7 + t3) + lift
        for (let j = 0; j < contacts.length; j++) {
          const I = glow[j]
          if (I < 0.02) continue
          const d = (u - contacts[j].band) * 22
          v += I * 0.75 * Math.exp(-d * d)
        }
        wave.bars[i] += (Math.min(1, Math.max(0.03, v)) - wave.bars[i]) * k
      }
    }

    api.status = time - lastResolve < 1.2 ? 'Contact' : s.pointer && lockTarget ? 'Locked' : 'Scanning'
  }

  function paint(c, fromPing = false) {
    c.hit = time
    c.hits++
    if (c.hits === 2 || (fromPing && c.hits < 2)) {
      c.hits = Math.max(2, c.hits)
      lastResolve = time
    }
  }

  function trigger() {
    pings.push({ t0: time, r: 0 })
  }

  function settle(s) {
    for (let i = 0; i < 300; i++) step(1 / 30, s)
    // Make every contact resolved with a spread of phosphor ages.
    for (let i = 0; i < contacts.length; i++) {
      const c = contacts[i]
      c.hits = 2
      const behind = (((a - c.th) % TAU) + TAU) % TAU
      c.hit = time - behind / 1.05
      c.fadeIn = 1
    }
    api.status = 'Scanning'
  }

  function readout() {
    let resolved = 0
    for (let i = 0; i < contacts.length; i++) if (contacts[i].hits >= 2) resolved++
    return `Contacts ${pad(contacts.length)} · Resolved ${pad(resolved)}`
  }

  /* ---- Drawing ------------------------------------------------------------------------- */
  function draw(ctx, s) {
    const boot = s.boot
    if (boot <= 0) return
    const e = s.energy
    const grow = easeOut(boot * 1.3)
    const r = R * (0.9 + 0.1 * grow)

    // Scope: range rings, crosshair, bearing ticks
    ctx.strokeStyle = pal.atmo.rgb
    ctx.lineWidth = 1
    for (let i = 1; i <= 4; i++) {
      ctx.globalAlpha = grow * (i === 4 ? 0.34 + e * 0.15 : 0.12 + e * 0.05)
      ctx.beginPath()
      ctx.arc(cx, cy, (r * i) / 4, 0, TAU)
      ctx.stroke()
    }
    ctx.globalAlpha = grow * 0.1
    ctx.beginPath()
    ctx.moveTo(cx - r, cy)
    ctx.lineTo(cx + r, cy)
    ctx.moveTo(cx, cy - r)
    ctx.lineTo(cx, cy + r)
    ctx.stroke()

    ctx.globalAlpha = grow * 0.32
    if (grow < 1) {
      ctx.beginPath()
      ticksPath(ctx, r)
      ctx.stroke()
    } else {
      if (!bearingTicks) ticksPath((bearingTicks = new Path2D()), r)
      ctx.stroke(bearingTicks)
    }
    label(ctx, '000', cx, cy - r - 18, { alpha: grow * 0.45, align: 'center', size: 8 })
    label(ctx, '180', cx, cy + r + 19, { alpha: grow * 0.45, align: 'center', size: 8 })
    label(ctx, '270', cx - r - 14, cy, { alpha: grow * 0.45, align: 'right', size: 8 })

    // Sweep wedge (clipped to the scope) and leading edge
    const sweepA = 0.26 + e * 0.12
    ctx.save()
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, TAU)
    ctx.clip()
    if (hasConic) {
      const span = 1.25
      const g = ctx.createConicGradient(a - span, cx, cy)
      const f = span / TAU
      g.addColorStop(0, pal.atmo.a(0))
      g.addColorStop(f * 0.999, pal.atmo.a(sweepA))
      g.addColorStop(f, pal.atmo.a(0))
      g.addColorStop(1, pal.atmo.a(0))
      ctx.globalAlpha = grow
      ctx.fillStyle = g
      ctx.fillRect(cx - r, cy - r, r * 2, r * 2)
    } else {
      ctx.fillStyle = pal.atmo.rgb
      for (let i = 0; i < 20; i++) {
        ctx.globalAlpha = grow * sweepA * (1 - i / 20)
        ctx.beginPath()
        ctx.moveTo(cx, cy)
        ctx.arc(cx, cy, r, a - (i + 1) * 0.06, a - i * 0.06)
        ctx.fill()
      }
    }
    ctx.restore()
    ctx.globalAlpha = grow * 0.85
    ctx.strokeStyle = pal.ion.rgb
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r)
    ctx.stroke()

    // Pings
    ctx.strokeStyle = pal.ion.rgb
    for (let i = 0; i < pings.length; i++) {
      const p = pings[i]
      ctx.globalAlpha = boot * (1 - p.r) * 0.85
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.arc(cx, cy, p.r * r, 0, TAU)
      ctx.stroke()
    }
    ctx.lineWidth = 1

    // Contacts
    for (let i = 0; i < contacts.length; i++) {
      const c = contacts[i]
      if (c.hit < -50) continue
      const I = Math.exp(-(time - c.hit) * DECAY) * c.fadeIn * Math.min(1, c.life / 1.5)
      pos(c, pt)
      const x = pt[0]
      const y = pt[1]
      const vis = Math.max(I, c.hits >= 2 ? 0.16 * c.fadeIn * Math.min(1, c.life / 1.5) : 0)
      if (vis < 0.02) continue
      drawGlow(ctx, glowIon, x, y, 9 + I * 9, boot * I * 0.85)
      ctx.globalAlpha = boot * (0.3 + 0.7 * vis)
      ctx.fillStyle = pal.text.rgb
      ctx.fillRect(x - 1.25, y - 1.25, 2.5, 2.5)
      if (c.hits >= 2) {
        const ba = boot * (0.22 + 0.6 * I)
        brackets(ctx, x, y, 7, ba, pal.atmo.rgb)
        label(ctx, c.tag, x + 11, y - 9, { alpha: ba * 1.1, size: 8, color: pal.ion.rgb })
      }
    }

    // Pointer lock
    if (lockAlpha > 0.02 && lockShown) {
      pos(lockShown, pt)
      const x = pt[0]
      const y = pt[1]
      ctx.strokeStyle = pal.text.rgb
      ctx.globalAlpha = boot * lockAlpha * 0.5
      ctx.setLineDash(LOCK_DASH)
      ctx.beginPath()
      ctx.moveTo(cx, cy)
      ctx.lineTo(x, y)
      ctx.stroke()
      ctx.setLineDash(NO_DASH)
      brackets(ctx, x, y, 12, boot * lockAlpha, pal.text.rgb)
      drawGlow(ctx, glowAtmo, x, y, 22, boot * lockAlpha * 0.6)
      label(ctx, 'LOCK', x + 16, y + 10, { alpha: boot * lockAlpha, size: 8 })
    }

    // Centre
    ctx.globalAlpha = grow
    ctx.fillStyle = pal.text.rgb
    ctx.fillRect(cx - 1.5, cy - 1.5, 3, 3)

    if (wave) drawWave(ctx, grow, e)
  }

  function ticksPath(g, r) {
    for (let i = 0; i < 72; i++) {
      const ang = (i / 72) * TAU
      const len = i % 9 === 0 ? 7 : 3
      const ca = Math.cos(ang)
      const sa = Math.sin(ang)
      g.moveTo(cx + ca * (r + 3), cy + sa * (r + 3))
      g.lineTo(cx + ca * (r + 3 + len), cy + sa * (r + 3 + len))
    }
  }

  function drawWave(ctx, grow, e) {
    const { x0, x1, y, amp, bars } = wave
    const n = bars.length
    const shown = Math.floor(n * grow)
    for (let i = 0; i < shown; i++) {
      const v = bars[i]
      const hgt = Math.max(1, v * amp)
      barBatch.add(x0 + i * 5, y - hgt, 2, hgt * 2, grow * (0.22 + v * 0.7 + e * 0.1))
    }
    barBatch.flush(ctx, pal.atmo.rgb)
    // Baseline + feed line into the scope
    ctx.globalAlpha = grow * 0.18
    ctx.fillRect(x0, y, x1 - x0, 1)
    dotted(ctx, x1 + 6, y + 0.5, cx - R - 6, y + 0.5, FEED_DASH, pal.text.rgb, grow * 0.22)
    label(ctx, 'SPECTRUM · 0.4–12 GHZ', x0, y - amp - 12, { alpha: grow * 0.5, size: 8 })
  }
}

function brackets(ctx, x, y, r, alpha, color) {
  const t = Math.max(3, r * 0.45)
  ctx.globalAlpha = Math.min(1, alpha)
  ctx.strokeStyle = color
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let i = 0; i < 4; i++) {
    const sx = CORNER_X[i]
    const sy = CORNER_Y[i]
    ctx.moveTo(x + sx * r, y + sy * (r - t))
    ctx.lineTo(x + sx * r, y + sy * r)
    ctx.lineTo(x + sx * (r - t), y + sy * r)
  }
  ctx.stroke()
}
