/**
 * SYS-06 · SCALE — a constellation growing node by node into a galaxy.
 *
 * New nodes ignite along the arms of a logarithmic spiral near the rim and
 * link to their nearest neighbour on the same arm, while the whole field
 * slowly zooms out — an endless "powers of ten". Older structure sinks into
 * a bright core and is absorbed there.
 *
 * The trick: a log spiral scaled about its centre is the same spiral,
 * rotated. So as the view zooms out and new nodes keep landing on the arm at
 * the rim, the arms appear to wind inwards forever while every node simply
 * travels toward the core. The pointer seeds growth where it points.
 */
import { seededRandom } from '../../../lib/dom.js'
import { byTier } from '../../../lib/quality.js'
import { glowSprite, drawGlow, label, easeOut, rectBatch, TAU, NO_DASH, hypot } from './core.js'

const ZOOM_RATE = 0.05 // 1/s, continuous zoom-out
const LINK_TIME = 0.6
const ABSORB = 0.085 // normalised radius where nodes are absorbed by the core
const ARMS = 3
const PITCH = 0.3 // log-spiral tightness: r = a·e^(PITCH·θ)
const GUIDE_DASH = [2, 6]
const SEED_DASH = [2, 4]

export function createScale({ pal, seed = 6 }) {
  const rand = seededRandom(seed * 7727)
  const maxNodes = byTier({ high: 280, medium: 210, low: 130 })
  const maxDust = byTier({ high: 420, medium: 280, low: 140 })
  const maxRate = byTier({ high: 5, medium: 4, low: 2.6 })
  const dustRate = byTier({ high: 22, medium: 15, low: 8 })
  const glowIon = glowSprite(pal.ion)
  const glowAtmo = glowSprite(pal.atmo)
  const dots = rectBatch(12)

  let cx = 0
  let cy = 0
  let ex = 100 // disc radii (px): the disc is a circle seen at an inclination
  let ey = 40
  let z = 1 // zoom: screen = centre + z · world
  let a = 0.02 // spiral scale (world units); renormalised with z
  let time = 0
  let spawnAcc = 0
  let dustAcc = 0
  let rate = 3
  let count = 0
  let burst = 0 // nodes still to spawn quickly (seed)
  let seedAt = null
  let ready = false
  // World positions only change when renormalised, so each keeps its radius (r).
  const nodes = [] // { x, y (world, unit disc), r, arm, born, hub, dead, tw }
  const links = [] // { a, b, born }
  const dust = [] // { x, y, r }
  // Per-frame scratch: links still drawing in, with their progress
  const growing = []
  const growingK = []

  const api = {
    status: 'Expanding',
    tone: '',
    get count() {
      return count
    },
    resize,
    step,
    draw,
    trigger,
    settle,
    readout,
  }
  return api

  function resize(s) {
    const wide = s.w / s.h > 1.4
    cx = s.w * 0.5
    cy = wide ? s.h * 0.47 : s.band.mid + 4
    ex = wide ? s.w * 0.46 : s.w * 0.56
    ey = wide ? Math.min(s.h * 0.44, ex * 0.42) : Math.min(s.band.h * 0.5, ex * 0.7)
    if (!ready) {
      ready = true
      // Arrive with a mature galaxy; growth then continues node by node.
      // (40 simulated seconds: enough for arms to wind in from the rim to the core.)
      const quiet = { energy: 0, pointer: false }
      for (let i = 0; i < 400; i++) advance(0.1, quiet)
      time += 3 // no ignition ripples on arrival
    }
  }

  /* ---- Geometry -------------------------------------------------------------------- */
  function sx(n) {
    return cx + n.x * z * ex
  }

  function sy(n) {
    return cy + n.y * z * ey
  }

  /** Normalised on-screen disc radius of a world point (1 = rim). */
  function rhoOf(n) {
    return n.r * z
  }

  /** A world point on arm `arm` at on-screen disc radius `rho` (with scatter). */
  function onArm(arm, rho, scatter) {
    const r = rho / z
    const th = Math.log(r / a) / PITCH + (arm * TAU) / ARMS + (rand() - 0.5) * scatter
    const rr = r * (1 + (rand() - 0.5) * scatter * 0.35)
    const x = Math.cos(th) * rr
    const y = Math.sin(th) * rr
    return { x, y, r: hypot(x, y) }
  }

  /* ---- Growth ------------------------------------------------------------------------ */
  function spawn(near = null) {
    let p
    let arm = -1
    if (near) {
      const ang = rand() * TAU
      const d = 8 + rand() * 30
      const x = (near.x + Math.cos(ang) * d - cx) / (z * ex)
      const y = (near.y + Math.sin(ang) * d - cy) / (z * ey)
      p = { x, y, r: hypot(x, y) }
    } else {
      arm = Math.floor(rand() * ARMS)
      p = onArm(arm, 0.55 + 0.45 * Math.sqrt(rand()), 0.26)
    }
    if (p.r * z < ABSORB * 2.5) return
    const node = { x: p.x, y: p.y, r: p.r, arm, born: time, hub: rand() < 0.07, dead: -1, tw: rand() * TAU }

    // Link to the nearest live node on the same arm (or any, for seeded growth),
    // within a short reach — filaments, not spaghetti.
    const px = sx(node)
    const py = sy(node)
    const reach = ex * 0.125 + 14
    let best = null
    let bestD = reach
    let bridge = null
    let bridgeD = reach * 0.7
    for (let i = nodes.length - 1, seen = 0; i >= 0 && seen < 140; i--, seen++) {
      const n = nodes[i]
      if (n.dead >= 0) continue
      const d = hypot(sx(n) - px, sy(n) - py)
      if ((arm < 0 || n.arm === arm) && d < bestD) {
        bestD = d
        best = n
      } else if (d < bridgeD) {
        bridgeD = d
        bridge = n
      }
    }
    if (best) links.push({ a: best, b: node, born: time })
    if (bridge && (!best || rand() < 0.22)) links.push({ a: bridge, b: node, born: time + 0.15 })

    nodes.push(node)
    count++
    if (nodes.length > maxNodes) retire(nodes.find((n) => n.dead < 0))
  }

  function retire(n) {
    if (n && n.dead < 0) n.dead = time
  }

  function advance(dt, s) {
    time += dt
    const e = s.energy
    z *= Math.exp(-ZOOM_RATE * dt * (1 + e * 0.6))
    // Renormalise so world coordinates never blow up (the picture is unchanged).
    if (z < 0.25) {
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i]
        n.x *= z
        n.y *= z
        n.r = hypot(n.x, n.y)
      }
      for (let i = 0; i < dust.length; i++) {
        const d = dust[i]
        d.x *= z
        d.y *= z
        d.r = hypot(d.x, d.y)
      }
      a *= z
      z = 1
    }

    rate = Math.min(maxRate, rate + dt * 0.02)
    spawnAcc += dt * rate * (1 + e * 0.8)
    if (burst > 0) spawnAcc += dt * 40
    while (spawnAcc >= 1) {
      spawnAcc -= 1
      const near = s.pointer && rand() < 0.6 ? { x: s.mx, y: s.my } : seedAt && time - seedAt.t < 0.6 ? seedAt : null
      spawn(near)
      if (burst > 0) burst--
    }

    // Dust lanes along the arms
    dustAcc += dt * dustRate
    while (dustAcc >= 1) {
      dustAcc -= 1
      dust.push(onArm(Math.floor(rand() * ARMS), 0.5 + 0.52 * Math.sqrt(rand()), 0.42))
      if (dust.length > maxDust) dust.shift()
    }

    // Absorb what has sunk into the core; drop the dead.
    for (let i = 0; i < nodes.length; i++) if (nodes[i].dead < 0 && rhoOf(nodes[i]) < ABSORB) retire(nodes[i])
    for (let k = nodes.length - 1; k >= 0; k--) {
      if (nodes[k].dead >= 0 && time - nodes[k].dead > 0.8) nodes.splice(k, 1)
    }
    for (let k = links.length - 1; k >= 0; k--) {
      const l = links[k]
      if ((l.a.dead >= 0 && time - l.a.dead > 0.8) || (l.b.dead >= 0 && time - l.b.dead > 0.8)) links.splice(k, 1)
    }
    for (let k = dust.length - 1; k >= 0; k--) if (dust[k].r * z < ABSORB * 0.7) dust.splice(k, 1)
  }

  function step(dt, s) {
    advance(dt, s)
    api.status = s.pointer ? 'Seeding' : 'Expanding'
  }

  function trigger(s) {
    const near = s.pointer ? { x: s.mx, y: s.my } : (() => {
      const n = nodes[nodes.length - 1 - Math.floor(rand() * Math.min(30, nodes.length))]
      return n ? { x: sx(n), y: sy(n) } : { x: cx + ex * 0.5, y: cy }
    })()
    seedAt = { ...near, t: time }
    burst += 14
  }

  function settle(s) {
    burst = 0
    for (let i = 0; i < 300; i++) advance(1 / 30, s)
    time += 5 // everything mature: no ripples in the still
  }

  function readout() {
    return `Growth +${rate.toFixed(1)}/s`
  }

  /* ---- Drawing ------------------------------------------------------------------------- */
  function draw(ctx, s) {
    const boot = s.boot
    if (boot <= 0) return
    const e = s.energy
    const grow = easeOut(boot * 1.3)

    // Disc guides: two orbits of the inclined disc
    ctx.strokeStyle = pal.atmo.rgb
    ctx.lineWidth = 1
    ctx.setLineDash(GUIDE_DASH)
    ctx.globalAlpha = grow * 0.14
    ctx.beginPath()
    ctx.ellipse(cx, cy, ex * 0.5, ey * 0.5, 0, 0, TAU)
    ctx.stroke()
    ctx.globalAlpha = grow * 0.1
    ctx.beginPath()
    ctx.ellipse(cx, cy, ex * 1.02, ey * 1.02, 0, 0, TAU)
    ctx.stroke()
    ctx.setLineDash(NO_DASH)

    // Galactic glow: a wide, flattened halo and a hot core
    ctx.save()
    ctx.translate(cx, cy)
    ctx.scale(1, ey / ex)
    drawGlow(ctx, glowAtmo, 0, 0, ex * 0.62, grow * (0.3 + e * 0.12))
    ctx.restore()
    drawGlow(ctx, glowAtmo, cx, cy, ey * 0.7, grow * (0.4 + e * 0.15))
    drawGlow(ctx, glowIon, cx, cy, ey * 0.2, grow * 0.85)

    // Dust: faint grains tracing the arms
    for (let i = 0; i < dust.length; i++) {
      const d = dust[i]
      const r = d.r * z
      const x = cx + d.x * z * ex
      const y = cy + d.y * z * ey
      dots.dot(x, y, 1, grow * (0.14 + 0.42 * Math.min(1, r * 1.3)))
    }
    dots.flush(ctx, pal.ion.rgb)

    // Links
    ctx.strokeStyle = pal.atmo.rgb
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.globalAlpha = grow * (0.26 + e * 0.12)
    let growingLen = 0
    for (let i = 0; i < links.length; i++) {
      const l = links[i]
      const k = (time - l.born) / LINK_TIME
      if (k <= 0) continue
      if (l.a.dead >= 0 || l.b.dead >= 0) continue
      if (k < 1) {
        growing[growingLen] = l
        growingK[growingLen] = k
        growingLen++
        continue
      }
      ctx.moveTo(sx(l.a), sy(l.a))
      ctx.lineTo(sx(l.b), sy(l.b))
    }
    ctx.stroke()
    ctx.strokeStyle = pal.ion.rgb
    ctx.globalAlpha = grow * 0.75
    ctx.beginPath()
    for (let i = 0; i < growingLen; i++) {
      const l = growing[i]
      const k = easeOut(growingK[i])
      const ax = sx(l.a)
      const ay = sy(l.a)
      ctx.moveTo(ax, ay)
      ctx.lineTo(ax + (sx(l.b) - ax) * k, ay + (sy(l.b) - ay) * k)
    }
    ctx.stroke()

    // Nodes
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]
      const x = sx(n)
      const y = sy(n)
      const age = time - n.born
      const fadeIn = Math.min(1, age / 0.4)
      const fadeOut = n.dead >= 0 ? 1 - (time - n.dead) / 0.8 : 1
      const alpha = grow * fadeIn * fadeOut
      if (alpha <= 0.01) continue
      const r = rhoOf(n)
      const young = Math.max(0, 1 - age / 1.3)
      if (young > 0) {
        // Ignition ripple
        ctx.strokeStyle = pal.ion.rgb
        ctx.globalAlpha = alpha * young * young * 0.65
        ctx.beginPath()
        ctx.arc(x, y, 2 + (1 - young) * 12, 0, TAU)
        ctx.stroke()
        drawGlow(ctx, glowIon, x, y, 11, alpha * young * 0.85)
      }
      if (n.hub) drawGlow(ctx, glowAtmo, x, y, 11, alpha * 0.55)
      const twinkle = 0.86 + 0.14 * Math.sin(time * 2.3 + n.tw)
      const size = (n.hub ? 2.6 : 1.7) * Math.min(1, 0.5 + r)
      dots.dot(x, y, size, alpha * twinkle * (0.5 + 0.5 * Math.min(1, r * 1.5)))
    }
    dots.flush(ctx, pal.text.rgb)

    // Pointer seed reticle
    if (s.pointer) {
      ctx.strokeStyle = pal.atmo.rgb
      ctx.globalAlpha = grow * e * 0.45
      ctx.setLineDash(SEED_DASH)
      ctx.beginPath()
      ctx.arc(s.mx, s.my, 30, 0, TAU)
      ctx.stroke()
      ctx.setLineDash(NO_DASH)
      label(ctx, 'SEED', s.mx + 36, s.my - 18, { alpha: grow * e * 0.7, size: 8 })
    }
  }
}
