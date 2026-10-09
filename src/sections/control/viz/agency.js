/**
 * SYS-05 · AGENCY — a craft docking under vector-field guidance.
 *
 * A potential field (attraction to the port, repulsion + swirl around
 * keep-out zones) is drawn as a lattice of arrows. The craft follows it,
 * leaving breadcrumb telemetry behind and projecting its planned trajectory
 * ahead. It aligns with the approach corridor, slows, docks, holds, and a new
 * approach begins. The pointer is a moving keep-out zone: the plan re-routes
 * around it in real time.
 */
import { seededRandom, pad } from '../../../lib/dom.js'
import { byTier } from '../../../lib/quality.js'
import { glowSprite, drawGlow, label, easeOut, easeInOut, approach, wrapAngle, rectBatch, sat, TAU, NO_DASH, hypot } from './core.js'

const SUB = 1 / 60
const POINTER_R = 42
const DOCK_HOLD = 2.4
const TIMEOUT = 16
const PLAN_STEPS = 46
const LATTICE_LEVELS = 6 // brightness buckets for the field arrows
const PLAN_DASH = [3, 5]
const RING_DASH = [2, 4]
const CORRIDOR_DASH = [1, 5]

export function createAgency({ pal, seed = 5 }) {
  let rand = seededRandom(seed * 4099)
  const spacing = byTier({ high: 28, medium: 32, low: 38 })
  const glowIgnite = glowSprite(pal.igniteSoft)
  const glowAtmo = glowSprite(pal.atmo)
  const glowIon = glowSprite(pal.ion)
  const dots = rectBatch(10)

  let w = 0
  let h = 0
  const dock = { x: 0, y: 0 }
  let corridor = 120
  let layoutSeed = seed * 31 + 7
  let zonesPx = []
  let lattice = [] // { x, y, dx, dy, arrow: Path2D }
  // What the lattice was built for: size + pointer cell (Infinity: no pointer).
  // latticeW = NaN forces a rebuild.
  let latticeW = NaN
  let latticeH = NaN
  let latticePX = Infinity
  let latticePY = Infinity
  // Per-frame scratch, allocated once
  const out = [0, 0] // field() out-param
  const latticeBuckets = Array.from({ length: LATTICE_LEVELS }, () => [])
  const latticeCounts = new Uint32Array(LATTICE_LEVELS)
  const zoneLabels = []
  const craft = { x: 0, y: 0, vx: 0, vy: 0, hd: 0, thrust: 0, alpha: 0 }
  let phase = 'approach'
  let phaseT = 0
  let time = 0
  let acc = 0
  let trail = []
  let trailClock = 0
  const plan = new Float64Array(PLAN_STEPS * 2) // planned trajectory, x/y pairs
  let planLen = 0
  const pointerZone = { x: 0, y: 0, r: POINTER_R }
  let pointer = null // pointerZone while a pointer is over the tile
  let docks = 0
  let placed = false
  let stall = 0
  let band = { top: 0, bottom: 0, h: 1, mid: 0 }

  const api = { status: 'Approach', tone: '', resize, step, draw, trigger, settle, readout }
  layoutZones()
  return api

  /* ---- Layout ------------------------------------------------------------------- */
  /** A new obstacle layout (placement itself happens in pixel space, below). */
  function layoutZones() {
    layoutSeed = Math.floor(rand() * 1e9) + 1
  }

  function resize(s) {
    w = s.w
    h = s.h
    const wide = w / h > 1.4
    dock.x = w * (wide ? 0.88 : 0.82)
    dock.y = wide ? h * 0.44 : s.band.mid
    band = s.band
    corridor = Math.min(150, w * 0.18)
    placeZones()
    if (!placed) {
      placed = true
      reset()
    }
  }

  /**
   * Keep-out zones, placed deterministically per layout so a resize re-flows
   * the same picture. Constraints: clear of the copy (wide tiles), clear of
   * the approach corridor (the pre-dock waypoint must stay reachable) and
   * well apart from each other (a narrow gap between two fields is a saddle
   * the craft could stall in).
   */
  function placeZones() {
    const r = seededRandom(layoutSeed)
    const wide = w / h > 1.4
    const m = Math.min(w, h * 1.6)
    const want = wide ? 3 : 2
    zonesPx = []
    for (let tries = 0; tries < 160 && zonesPx.length < want; tries++) {
      const radius = (0.07 + r() * 0.035) * m * (wide ? 1 : 0.85)
      const xMin = wide ? w * 0.4 : w * 0.2
      const xMax = dock.x - corridor - radius * 1.7
      // Keep the zone and its label (above it) clear of the HUD.
      const yMin = Math.max(wide ? h * 0.2 + radius * 0.4 : 0, band.top + radius + 16)
      const yMax = wide ? h * 0.74 - radius * 0.4 : band.bottom - radius
      if (xMax <= xMin || yMax <= yMin) break
      const zone = { x: xMin + r() * (xMax - xMin), y: yMin + r() * (yMax - yMin), r: radius, hatch: null }
      if (zonesPx.every((o) => hypot(o.x - zone.x, o.y - zone.y) > (o.r + zone.r) * 1.75)) zonesPx.push(zone)
    }
    // The hatching of each zone's core is static: trace it once.
    for (let i = 0; i < zonesPx.length; i++) {
      const z = zonesPx[i]
      z.hatch = new Path2D()
      for (let k = -z.r; k < z.r; k += 5) {
        z.hatch.moveTo(z.x + k - z.r, z.y + z.r)
        z.hatch.lineTo(z.x + k + z.r, z.y - z.r)
      }
    }
    while (zoneLabels.length < zonesPx.length) zoneLabels.push(`KOZ-${zoneLabels.length + 1}`)
    latticeW = NaN
  }

  function reset(keepZones = true) {
    if (!keepZones) {
      layoutZones()
      placeZones()
    }
    craft.x = w * 0.04
    craft.y = band.top + 14 + rand() * band.h * 0.45
    craft.vx = 30
    craft.vy = 0
    craft.hd = 0
    craft.alpha = 0
    phase = 'approach'
    phaseT = 0
    trail = []
  }

  /* ---- Field ---------------------------------------------------------------------- */
  function field(x, y, out) {
    // Head for a pre-dock waypoint on the corridor axis, then the port itself.
    const wx = dock.x - corridor
    const tx = x < wx - 6 ? wx : dock.x
    let fx = tx - x
    let fy = dock.y - y
    let d = hypot(fx, fy) || 1
    fx /= d
    fy /= d
    // Inside the corridor: pull onto the axis
    if (x > wx - 40 && x < dock.x) fy += (dock.y - y) * 0.03

    const gx = fx
    const gy = fy
    // Keep-out zones, then the pointer's (when there is one).
    const zones = zonesPx.length
    for (let i = 0, n = pointer ? zones + 1 : zones; i < n; i++) {
      const o = i < zones ? zonesPx[i] : pointer
      const dx = x - o.x
      const dy = y - o.y
      const dist = hypot(dx, dy) || 1
      const reach = o.r * 2.3
      if (dist > reach) continue
      const k = Math.min(3, Math.pow((reach - dist) / (reach - o.r * 0.7), 2)) * 1.6
      const nx = dx / dist
      const ny = dy / dist
      // Swirl around the obstacle along the tangent that still makes progress
      // toward the goal (dead ahead: go over the top).
      let tx = -ny
      let ty = nx
      const ahead = tx * gx + ty * gy
      if (ahead < 0 || (Math.abs(ahead) < 0.02 && ty > 0)) {
        tx = -tx
        ty = -ty
      }
      fx += nx * k + tx * k * 1.1
      fy += ny * k + ty * k * 1.1
    }
    d = hypot(fx, fy) || 1
    out[0] = fx / d
    out[1] = fy / d
  }

  function buildLattice() {
    // Rebuilt on resize, and as the pointer moves (in 4px steps).
    const px = pointer ? Math.round(pointer.x / 4) : Infinity
    const py = pointer ? Math.round(pointer.y / 4) : Infinity
    if (w === latticeW && h === latticeH && px === latticePX && py === latticePY) return
    latticeW = w
    latticeH = h
    latticePX = px
    latticePY = py
    lattice = []
    const ox = (w % spacing) / 2 + spacing / 2
    const oy = (h % spacing) / 2 + spacing / 2
    for (let y = oy; y < h; y += spacing) {
      for (let x = ox; x < w; x += spacing) {
        if (hypot(x - dock.x, y - dock.y) < 26) continue
        let inside = false
        for (let i = 0; i < zonesPx.length; i++) if (hypot(x - zonesPx[i].x, y - zonesPx[i].y) < zonesPx[i].r - 4) inside = true
        if (inside) continue
        field(x, y, out)
        lattice.push({ x, y, dx: out[0], dy: out[1], arrow: arrowPath(x, y, out[0], out[1]) })
      }
    }
  }

  /** One field arrow (shaft + head), traced once per lattice build. */
  function arrowPath(x, y, dx, dy) {
    const L = 5.5
    const tx = x + dx * L
    const ty = y + dy * L
    const g = new Path2D()
    g.moveTo(x - dx * L, y - dy * L)
    g.lineTo(tx, ty)
    g.moveTo(tx - dx * 3 - dy * 2.2, ty - dy * 3 + dx * 2.2)
    g.lineTo(tx, ty)
    g.lineTo(tx - dx * 3 + dy * 2.2, ty - dy * 3 - dx * 2.2)
    return g
  }

  /* ---- Simulation --------------------------------------------------------------------- */
  function step(dt, s) {
    time += dt
    pointer = null
    if (s.pointer) {
      pointer = pointerZone
      pointer.x = s.mx
      pointer.y = s.my
    }
    acc += dt
    while (acc >= SUB) {
      acc -= SUB
      sub(SUB, s)
    }
    buildLattice()

    // Planned trajectory: integrate the field ahead of the craft.
    planLen = 0
    if (phase === 'approach') {
      let x = craft.x
      let y = craft.y
      for (let i = 0; i < PLAN_STEPS; i++) {
        field(x, y, out)
        x += out[0] * 9
        y += out[1] * 9
        plan[planLen++] = x
        plan[planLen++] = y
        if (hypot(x - dock.x, y - dock.y) < 10) break
      }
    }

    const near = pointer && hypot(pointer.x - craft.x, pointer.y - craft.y) < 110
    const dist = hypot(dock.x - craft.x, dock.y - craft.y)
    api.status = phase === 'docked' ? 'Docked' : near ? 'Re-routing' : dist < corridor * 1.2 ? 'Final approach' : 'Approach'
  }

  function sub(dt, s) {
    phaseT += dt
    if (phase === 'docked') {
      craft.thrust *= 0.9
      if (phaseT > DOCK_HOLD) {
        craft.alpha -= dt / 0.6
        if (craft.alpha <= 0) reset(docks % 2 === 0)
      }
      return
    }
    craft.alpha = Math.min(1, craft.alpha + dt / 0.6)
    field(craft.x, craft.y, out)
    const dist = hypot(dock.x - craft.x, dock.y - craft.y)
    const vmax = 88 * (1 + s.energy * 0.35)
    const speed = vmax * Math.min(1, Math.max(0.12, dist / 210))
    let tx = out[0] * speed
    let ty = out[1] * speed
    if (dist < 34) {
      // Terminal phase: glide straight in along the axis.
      tx = (dock.x - craft.x) * 1.6
      ty = (dock.y - craft.y) * 3
    }
    const k = approach(2.4, dt)
    const ax = (tx - craft.vx) * k
    const ay = (ty - craft.vy) * k
    craft.vx += ax
    craft.vy += ay
    craft.x += craft.vx * dt
    craft.y += craft.vy * dt
    craft.thrust += (Math.min(1, hypot(ax, ay) * 1.4 + 0.15) - craft.thrust) * approach(6, dt)
    const want = dist < corridor ? 0 : Math.atan2(craft.vy, craft.vx)
    craft.hd += wrapAngle(want - craft.hd) * approach(4, dt)

    // Safety net: if the craft ever stalls in a field minimum, nudge it.
    if (hypot(craft.vx, craft.vy) < 4 && dist > 20) {
      stall += dt
      if (stall > 1.2) {
        craft.vy += (craft.y > dock.y ? -1 : 1) * 30
        stall = 0
      }
    } else {
      stall = 0
    }

    trailClock -= dt
    if (trailClock <= 0) {
      trailClock = 0.12
      trail.push({ x: craft.x, y: craft.y, t: time })
      if (trail.length > 70) trail.shift()
    }

    if (dist < 2.5) {
      craft.x = dock.x
      craft.y = dock.y
      craft.vx = craft.vy = 0
      craft.hd = 0
      phase = 'docked'
      phaseT = 0
      docks++
    } else if (phaseT > TIMEOUT) {
      reset()
    }
  }

  function trigger() {
    rand = seededRandom(seed * 4099 + Math.floor(time * 1000))
    reset()
    craft.alpha = 0.01
  }

  function settle(s) {
    reset(true)
    for (let i = 0; i < 280 && phase === 'approach'; i++) sub(SUB * 2, s)
    buildLattice()
    step(0, s)
  }

  function readout() {
    const dist = hypot(dock.x - craft.x, dock.y - craft.y)
    const v = hypot(craft.vx, craft.vy) / 60
    return `Range ${pad(dist * 1.6, 4)} m · Vc ${v.toFixed(2)} m/s`
  }

  /* ---- Drawing ------------------------------------------------------------------------- */
  function draw(ctx, s) {
    const boot = s.boot
    if (boot <= 0) return
    const e = s.energy
    const grow = easeOut(boot * 1.3)
    buildLattice()

    drawLattice(ctx, grow, e)
    drawZones(ctx, grow, e)
    drawDock(ctx, grow)

    // Breadcrumb trail
    for (let i = 0; i < trail.length; i++) {
      const p = trail[i]
      dots.dot(p.x, p.y, 2, boot * Math.max(0, 1 - (time - p.t) / 7) * 0.7 * craft.alpha)
    }
    dots.flush(ctx, pal.atmo.rgb)

    // Planned trajectory
    if (planLen > 2 && craft.alpha > 0.05) {
      ctx.globalAlpha = boot * craft.alpha * (0.5 + e * 0.3)
      ctx.strokeStyle = pal.text.rgb
      ctx.setLineDash(PLAN_DASH)
      ctx.lineDashOffset = -time * 16
      ctx.beginPath()
      ctx.moveTo(craft.x, craft.y)
      for (let i = 0; i < planLen; i += 2) ctx.lineTo(plan[i], plan[i + 1])
      ctx.stroke()
      ctx.setLineDash(NO_DASH)
      ctx.lineDashOffset = 0
    }

    // Pointer keep-out ring
    if (pointer) {
      ctx.globalAlpha = boot * (0.3 + e * 0.25)
      ctx.strokeStyle = pal.atmo.rgb
      ctx.setLineDash(RING_DASH)
      ctx.beginPath()
      ctx.arc(pointer.x, pointer.y, POINTER_R, 0, TAU)
      ctx.stroke()
      ctx.setLineDash(NO_DASH)
    }

    drawCraft(ctx, boot)
  }

  function drawLattice(ctx, grow, e) {
    // Bucket arrows by brightness: the field glows near the craft and pointer.
    for (let i = 0; i < lattice.length; i++) {
      const p = lattice[i]
      let a = 0.1 + e * 0.05
      const dc = hypot(p.x - craft.x, p.y - craft.y)
      a += 0.5 * Math.exp(-(dc * dc) / (2 * 75 * 75)) * craft.alpha
      if (pointer) {
        const dp = hypot(p.x - pointer.x, p.y - pointer.y)
        a += 0.3 * Math.exp(-(dp * dp) / (2 * 60 * 60))
      }
      // Reveal sweeps left → right during boot.
      if (p.x > w * grow) continue
      // The field lives in the band between HUD and copy: fade it out under both.
      a *= Math.min(sat((p.y - band.top + 14) / 40), sat((band.bottom + 34 - p.y) / 50))
      if (a < 0.03) continue
      const b = Math.min(LATTICE_LEVELS - 1, Math.floor(a * 9))
      latticeBuckets[b][latticeCounts[b]++] = p
    }
    ctx.lineWidth = 1
    ctx.strokeStyle = pal.atmo.rgb
    for (let b = 0; b < LATTICE_LEVELS; b++) {
      const count = latticeCounts[b]
      if (!count) continue
      latticeCounts[b] = 0
      const list = latticeBuckets[b]
      const bucket = new Path2D()
      for (let i = 0; i < count; i++) bucket.addPath(list[i].arrow)
      ctx.globalAlpha = Math.min(0.75, (b + 0.6) / 9)
      ctx.stroke(bucket)
    }
  }

  function drawZones(ctx, grow, e) {
    ctx.lineWidth = 1
    for (let i = 0; i < zonesPx.length; i++) {
      const z = zonesPx[i]
      ctx.globalAlpha = grow * 0.05
      ctx.fillStyle = pal.atmo.rgb
      ctx.beginPath()
      ctx.arc(z.x, z.y, z.r, 0, TAU)
      ctx.fill()
      ctx.globalAlpha = grow * (0.4 + e * 0.15)
      ctx.strokeStyle = pal.atmo.rgb
      ctx.setLineDash(RING_DASH)
      ctx.beginPath()
      ctx.arc(z.x, z.y, z.r * (0.9 + 0.1 * grow), 0, TAU)
      ctx.stroke()
      ctx.setLineDash(NO_DASH)
      // Hatched core
      ctx.globalAlpha = grow * 0.12
      ctx.save()
      ctx.beginPath()
      ctx.arc(z.x, z.y, z.r * 0.55, 0, TAU)
      ctx.clip()
      ctx.stroke(z.hatch)
      ctx.restore()
      label(ctx, zoneLabels[i], z.x, z.y - z.r - 9, { alpha: grow * 0.5, align: 'center', size: 8 })
    }
  }

  function drawDock(ctx, grow) {
    const { x, y } = dock
    const docked = phase === 'docked' ? easeInOut(phaseT / 0.5) * Math.min(1, (DOCK_HOLD + 0.6 - phaseT) / 0.6) : 0
    // Approach corridor
    ctx.strokeStyle = pal.text.rgb
    ctx.lineWidth = 1
    ctx.globalAlpha = grow * 0.22
    ctx.setLineDash(CORRIDOR_DASH)
    ctx.beginPath()
    ctx.moveTo(x - 12, y - 4)
    ctx.lineTo(x - corridor, y - corridor * 0.16)
    ctx.moveTo(x - 12, y + 4)
    ctx.lineTo(x - corridor, y + corridor * 0.16)
    ctx.stroke()
    ctx.setLineDash(NO_DASH)

    // Station segment: truss with cross-bracing and two radiator panels
    const tx = x + 14
    const half = Math.min(56, h * 0.2)
    ctx.globalAlpha = grow * 0.75
    ctx.beginPath()
    ctx.rect(tx, y - half, 10, half * 2)
    for (let k = -half; k < half; k += 10) {
      ctx.moveTo(tx, y + k)
      ctx.lineTo(tx + 10, y + k + 10)
    }
    ctx.moveTo(x + 10, y)
    ctx.lineTo(tx, y)
    ctx.stroke()
    ctx.globalAlpha = grow * 0.4
    ctx.beginPath()
    ctx.rect(tx + 16, y - half, 14, half * 0.8)
    ctx.rect(tx + 16, y + half * 0.2, 14, half * 0.8)
    ctx.moveTo(tx + 10, y - half * 0.6)
    ctx.lineTo(tx + 16, y - half * 0.6)
    ctx.moveTo(tx + 10, y + half * 0.6)
    ctx.lineTo(tx + 16, y + half * 0.6)
    ctx.stroke()

    // Port ring
    ctx.globalAlpha = grow * (0.8 + docked * 0.2)
    ctx.strokeStyle = docked > 0.1 ? pal.text.rgb : pal.ion.rgb
    ctx.beginPath()
    ctx.arc(x, y, 10, 0, TAU)
    ctx.stroke()
    ctx.globalAlpha = grow * 0.5
    ctx.beginPath()
    ctx.arc(x, y, 4, 0, TAU)
    ctx.moveTo(x - 16, y)
    ctx.lineTo(x - 12, y)
    ctx.moveTo(x, y - 16)
    ctx.lineTo(x, y - 12)
    ctx.moveTo(x, y + 12)
    ctx.lineTo(x, y + 16)
    ctx.stroke()
    drawGlow(ctx, glowAtmo, x, y, 30 + docked * 30, grow * (0.25 + docked * 0.6))
    label(ctx, docked > 0.2 ? 'DOCKED' : 'PORT A', x, y + half + 14, { alpha: grow * (0.5 + docked * 0.5), align: 'center', size: 8 })
  }

  function drawCraft(ctx, boot) {
    if (craft.alpha <= 0.01) return
    const a = boot * craft.alpha
    ctx.save()
    ctx.translate(craft.x, craft.y)
    ctx.rotate(craft.hd)
    // Engine plume (the one place engine fire appears in this tile)
    if (phase !== 'docked') {
      drawGlow(ctx, glowIgnite, -10, 0, 6 + craft.thrust * 10, a * craft.thrust * 0.8)
      ctx.globalAlpha = a * craft.thrust
      ctx.strokeStyle = pal.ignite.rgb
      ctx.beginPath()
      ctx.moveTo(-9, 0)
      ctx.lineTo(-9 - craft.thrust * 9, 0)
      ctx.stroke()
    }
    // Hull — an original capsule silhouette
    ctx.globalAlpha = a
    ctx.fillStyle = '#000'
    ctx.strokeStyle = pal.text.rgb
    ctx.lineWidth = 1.2
    ctx.beginPath()
    ctx.moveTo(9, 0)
    ctx.lineTo(3, -4.5)
    ctx.lineTo(-6, -4.5)
    ctx.lineTo(-8.5, -2.5)
    ctx.lineTo(-8.5, 2.5)
    ctx.lineTo(-6, 4.5)
    ctx.lineTo(3, 4.5)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
    // Radiator wings
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(-2, -4.5)
    ctx.lineTo(-2, -11)
    ctx.moveTo(-2, 4.5)
    ctx.lineTo(-2, 11)
    ctx.stroke()
    ctx.globalAlpha = a * 0.6
    ctx.fillStyle = pal.atmo.rgb
    ctx.fillRect(-4.5, -11, 5, 3)
    ctx.fillRect(-4.5, 8, 5, 3)
    ctx.restore()
    drawGlow(ctx, glowIon, craft.x, craft.y, 16, a * 0.35)
  }
}
