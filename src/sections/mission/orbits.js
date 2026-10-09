/**
 * Ambient orbital chart behind the manifesto (decorative, aria-hidden).
 *
 * A schematic Earth — dark disc, atmospheric limb, slowly turning graticule —
 * ringed by hairline orbits seen from just above their plane (LEO, MEO, GEO,
 * BEYOND). The far half of every orbit passes behind the planet. A few
 * satellites of light ride the orbits; when two pass close they link up, a
 * constellation that keeps rewiring itself (intelligence as a network of
 * light). Plain Canvas 2D — a few hundred strokes a frame, no WebGL context.
 *
 * Reads every frame from `state`:
 *   enter     0..1  how far the stage has scrolled in (fades the chart in)
 *   progress  0..1  how much of the manifesto is lit (the camera rises a
 *                   little and the network reaches further)
 *   wave      int   bumped by mission.js each time a key word lights: the
 *                   planet sends a broadcast ring out across the orbital
 *                   plane, and each orbit (and its satellites) flares as the
 *                   wavefront crosses it. `waveStrength` scales the ring.
 * Once the statement is fully lit the constellation is complete and data
 * pulses run along its links: the type and the chart finish together.
 * `avoid` (optional element) is kept clear of orbit labels.
 *
 * Garbage-light frame path: no strings, arrays, closures or gradients are
 * built per frame in steady state (colours come from prebuilt per-alpha-step
 * rgba() tables, gradients are cached, scratch storage is preallocated) and
 * the hot loops keep float maths to a minimum.
 */
import { createRenderLoop } from '../../lib/visibility.js'
import { byTier, dpr, isTouch, reducedMotion } from '../../lib/quality.js'
import { clamp, lerp, seededRandom } from '../../lib/dom.js'

const TAU = Math.PI * 2
const WHITE = '244, 246, 251'
const ATMO = '111, 195, 255'
const DEEP = '31, 107, 255'
const LABELS = ['LEO', 'MEO', 'GEO', 'BEYOND']
const LIGHT = -0.7 // direction of the sun on the planet (radians, screen space)
const STILL_T = 24 // the moment shown under reduced motion
const WAVE_LIFE = 3.6 // seconds a broadcast ring takes to cross the system
const SWEEP_GAIN = 1.5 // headroom baked into the wave sweep gradient (strength ≤ 1.35)
const LATITUDES = [-0.9, -0.45, 0, 0.45, 0.9] // graticule parallels
const NO_DASH = []
const LABEL_FONT = "500 10px 'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, monospace"
const LABEL_FONT_MOBILE = "500 9px 'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, monospace"
const PARALLEL = `rgba(${ATMO}, 0.12)`
const EQUATOR = `rgba(${ATMO}, 0.26)`

// Colour strings, prebuilt per 8-bit alpha step (as fine as the canvas can
// show): `atmo(0.42)` is 'rgba(111, 195, 255, 0.4196)', and a frame builds none.
const ALPHA_STEPS = 255
const WHITE_STEPS = rgbaSteps(WHITE)
const ATMO_STEPS = rgbaSteps(ATMO)
const DEEP_STEPS = rgbaSteps(DEEP)
const ICE_STEPS = rgbaSteps('214, 240, 255')
const toStep = (alpha) => (alpha > 0 ? (alpha < 1 ? Math.round(alpha * ALPHA_STEPS) : ALPHA_STEPS) : 0)
const white = (alpha) => WHITE_STEPS[toStep(alpha)]
const atmo = (alpha) => ATMO_STEPS[toStep(alpha)]
const deep = (alpha) => DEEP_STEPS[toStep(alpha)]
const ice = (alpha) => ICE_STEPS[toStep(alpha)]

export function createOrbits({ canvas, host, state, avoid }) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  const rand = seededRandom(0x5a51)
  const ORBIT_COUNT = byTier({ high: 7, medium: 6, low: 5 })
  const SEGMENTS = byTier({ high: 32, medium: 24, low: 16 }) // per orbit, for depth shading
  const TRAIL = byTier({ high: 14, medium: 9, low: 0 }) // trail segments per satellite
  const MERIDIANS = byTier({ high: 9, medium: 7, low: 5 })
  const pixelRatio = Math.min(dpr, 2)

  // Per-frame tables, precomputed so the hot loops do little float maths
  // (every float an unoptimised loop makes is a heap allocation).
  // Orbit segments: boundary angles, and a base brightness that rises toward
  // the near side. The first half of the segments is the near half.
  const HALF = SEGMENTS / 2
  const segAngle = new Float64Array(SEGMENTS + 1)
  const segN = new Float64Array(SEGMENTS) // depth: 0 far … 1 near
  const segBase = new Float64Array(SEGMENTS)
  for (let s = 0; s <= SEGMENTS; s++) segAngle[s] = (s / SEGMENTS) * TAU
  for (let s = 0; s < SEGMENTS; s++) {
    segN[s] = (Math.sin((segAngle[s] + segAngle[s + 1]) / 2) + 1) / 2
    segBase[s] = 0.03 + 0.15 * segN[s] * segN[s]
  }
  // White orbit strokes, per orbit and segment, for the current alpha step
  const orbitStyles = Array.from({ length: ORBIT_COUNT }, () => new Array(SEGMENTS).fill(''))
  let orbitStep = -1
  // Satellite trails: alpha step of trail segment k, for each body alpha step
  const trailSteps = new Uint8Array((ALPHA_STEPS + 1) * TRAIL)
  for (let b = 0; b <= ALPHA_STEPS; b++) {
    for (let k = 0; k < TRAIL; k++) trailSteps[b * TRAIL + k] = Math.round((1 - k / TRAIL) ** 2 * 0.55 * b)
  }

  // ---- The system (deterministic) -----------------------------------------
  const orbits = Array.from({ length: ORBIT_COUNT }, (_, i) => {
    const k = i / (ORBIT_COUNT - 1)
    return {
      r: 0.2 + Math.pow(k, 1.15) * 0.86 + (rand() - 0.5) * 0.03, // × R
      ratio: 0.2 + rand() * 0.1, // apparent minor/major axis (camera elevation)
      rot: -0.16 + (rand() - 0.5) * 0.2, // position angle of the line of nodes
      sway: 0.05 + rand() * 0.06, // bounded precession (radians)
      phase: rand() * TAU,
      dash: i % 3 === 1 ? [1, 5] : null,
      bright: i === 1 || i === 3 ? 1.45 : 1,
      label: null,
      labelTheta: null,
      rx: 0,
      ry: 0,
      rotNow: 0,
      flare: 0, // 0..1 while a broadcast wavefront crosses this orbit
    }
  })
  ;[1, 2, Math.min(4, ORBIT_COUNT - 2), ORBIT_COUNT - 1].forEach((index, i) => (orbits[index].label = LABELS[i]))
  const meanRot = orbits.reduce((sum, o) => sum + o.rot, 0) / orbits.length
  const meanRatio = orbits.reduce((sum, o) => sum + o.ratio, 0) / orbits.length

  // Broadcast rings, spawned when mission.js bumps `state.wave`
  const waves = []
  let seenWave = state.wave || 0

  const satellites = []
  orbits.forEach((orbit, i) => {
    const count = i === 0 ? 1 : 1 + Math.floor(rand() * byTier({ high: 3, medium: 2.4, low: 2 }))
    for (let n = 0; n < count; n++) {
      satellites.push({
        orbit,
        theta: rand() * TAU,
        speed: (0.085 / Math.pow(orbit.r + 0.25, 1.5)) * (0.8 + rand() * 0.4), // outer = slower
        size: 0.9 + rand() * 0.9,
        accent: rand() < 0.34,
        ping: 7 + rand() * 5, // seconds between sonar pings (accent satellites)
        pingOffset: rand() * 12,
        x: 0,
        y: 0,
        depth: 0,
      })
    }
  })

  // ---- Sprites ------------------------------------------------------------
  const glowAtmo = makeGlow(ATMO)
  const glowWhite = makeGlow(WHITE)
  let stars = null
  let halo = null
  let body = null
  let shade = null // night side of the planet, in planet-centred space
  let haze = null // deep-blue haze around the planet, planet-centred …
  let hazeStep = -1 // … rebuilt only when its strength (in alpha steps) changes
  const sweep = makeSweep(ctx) // unit-radius wave sweep, scaled per ring

  // ---- Layout -------------------------------------------------------------
  let W = 0
  let H = 0
  let cx = 0
  let cy = 0
  let R = 0
  let pr = 0 // planet radius
  let mobile = false
  let keepOut = null // { x0, y0, x1, y1 } in canvas px

  // Text-aware layout: keep labels off the statement, and on desktop hang the
  // planet just past the statement's last word, wherever the lines break.
  const measure = () => {
    if (!avoid) return null
    const c = canvas.getBoundingClientRect()
    const a = avoid.getBoundingClientRect()
    const pad = 14
    keepOut = { x0: a.left - c.left - pad, y0: a.top - c.top - pad, x1: a.right - c.left + pad, y1: a.bottom - c.top + pad }
    const last = avoid.querySelector('.s-mission__visual')?.lastElementChild
    if (!last) return null
    const r = last.getBoundingClientRect()
    return { right: r.right - c.left, mid: r.top - c.top + r.height * 0.52 }
  }

  const resize = () => {
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (!w || !h) return
    if (w !== W || h !== H) {
      W = w
      H = h
      mobile = W < 720
      canvas.width = Math.round(W * pixelRatio)
      canvas.height = Math.round(H * pixelRatio)
      R = mobile ? Math.max(W * 1.05, H * 0.46) : Math.max(W * 0.56, H * 0.8)
      pr = R * (mobile ? 0.098 : 0.086)
      stars = makeStars(W, H, pixelRatio, seededRandom(0x57a5))
      ;[halo, body] = makePlanet(pr, pixelRatio)
      shade = makeShade(ctx, pr)
      hazeStep = -1
    }
    const anchor = measure()
    if (mobile) {
      // A poster: the chart above, the statement anchored below it
      cx = W * 0.7
      cy = H * 0.255
    } else if (anchor) {
      cx = clamp(anchor.right + pr * 2.4, W * 0.62, W - pr * 2.6)
      cy = clamp(anchor.mid, H * 0.3, H * 0.78)
    } else {
      cx = W * 0.795
      cy = H * 0.7
    }
    placeLabels()
    if (reducedMotion) draw(STILL_T, 0)
  }

  let px = 0 // project() writes here (no array per call)
  let py = 0
  /** Point at parametric angle `theta` on an ellipse centred on (x0, y0) → (px, py). */
  const project = (x0, y0, rx, ry, rot, theta) => {
    const lx = rx * Math.cos(theta)
    const ly = ry * Math.sin(theta)
    const c = Math.cos(rot)
    const s = Math.sin(rot)
    px = x0 + lx * c - ly * s
    py = y0 + lx * s + ly * c
  }

  const inKeepOut = (x, y) => keepOut && x > keepOut.x0 && x < keepOut.x1 && y > keepOut.y0 && y < keepOut.y1

  // Label each named orbit on its near side, on screen and clear of the text
  // (evaluated for the fully-lit framing; a label hides if it drifts into it).
  function placeLabels() {
    const tilt = 1.32
    for (const orbit of orbits) {
      if (!orbit.label) continue
      orbit.labelTheta = null
      const rx = orbit.r * R
      const ry = rx * orbit.ratio * tilt
      for (let i = 0; i <= 40 && orbit.labelTheta === null; i++) {
        // sweep the near half from its lowest point outwards, right side first
        const off = (i / 40) * (Math.PI / 2)
        for (const theta of [Math.PI / 2 - off, Math.PI / 2 + off]) {
          project(cx, cy, rx, ry, orbit.rot, theta)
          const x = px
          const y = py
          const ok = x > 24 && x < W - (mobile ? 70 : 96) && y > H * 0.14 && y < H * 0.86 && !inKeepOut(x, y - 10) && !inKeepOut(x + 60, y - 10)
          if (ok && Math.hypot(x - cx, y - cy) > pr * 1.6) {
            orbit.labelTheta = theta
            break
          }
        }
      }
    }
  }

  // ---- Pointer parallax (desktop only) --------------------------------------
  const pointer = { x: 0, y: 0, tx: 0, ty: 0 }
  const onPointer = (event) => {
    pointer.tx = (event.clientX / window.innerWidth - 0.5) * 2
    pointer.ty = (event.clientY / window.innerHeight - 0.5) * 2
  }
  if (!isTouch && !reducedMotion) window.addEventListener('pointermove', onPointer, { passive: true })

  // ---- Frame ----------------------------------------------------------------
  let open = 0 // eased copy of state.progress

  function draw(t, dt) {
    if (!W) return
    const enter = reducedMotion ? 1 : clamp(state.enter)
    open = reducedMotion ? 1 : lerp(open, clamp(state.progress), 1 - Math.exp(-dt * 3))
    pointer.x = lerp(pointer.x, pointer.tx, 1 - Math.exp(-dt * 2.2))
    pointer.y = lerp(pointer.y, pointer.ty, 1 - Math.exp(-dt * 2.2))

    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
    ctx.clearRect(0, 0, W, H)
    if (enter <= 0.001) return

    const alpha = enter * (0.62 + 0.38 * open)
    const tilt = 1 + 0.32 * open // the camera rises above the plane as the text lights
    const ox = cx - pointer.x * 22
    const oy = cy - pointer.y * 14

    // Stars (pre-rendered), parallaxing less than the chart
    ctx.globalAlpha = enter
    ctx.drawImage(stars, -pointer.x * 7, -pointer.y * 4, W, H)
    ctx.globalAlpha = 1

    // Orbit geometry for this frame
    for (let i = 0; i < orbits.length; i++) {
      const orbit = orbits[i]
      orbit.rx = orbit.r * R
      orbit.ry = orbit.rx * orbit.ratio * tilt
      orbit.rotNow = orbit.rot + orbit.sway * Math.sin(t * 0.045 + orbit.phase) - 0.05 * open
    }

    const emit = updateWaves(t)

    // Faint deep-blue haze around the planet (swells as it transmits). The
    // gradient lives in planet space and carries the strength; `alpha` rides
    // on globalAlpha, so it is rebuilt only while the strength moves.
    const step = Math.round(clamp(0.13 * (0.6 + 0.4 * open) + 0.12 * emit) * ALPHA_STEPS)
    if (step !== hazeStep) {
      hazeStep = step
      haze = ctx.createRadialGradient(0, 0, pr, 0, 0, R * 0.42)
      haze.addColorStop(0, deep(step / ALPHA_STEPS))
      haze.addColorStop(0.4, deep(0.04))
      haze.addColorStop(1, deep(0))
    }
    ctx.globalAlpha = alpha
    ctx.fillStyle = haze
    ctx.translate(ox, oy)
    ctx.fillRect(-R * 0.42, -R * 0.42, R * 0.84, R * 0.84)
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
    ctx.globalAlpha = 1

    // Satellites: advance + project
    for (let i = 0; i < satellites.length; i++) {
      const sat = satellites[i]
      if (!reducedMotion) sat.theta += sat.speed * dt
      project(ox, oy, sat.orbit.rx, sat.orbit.ry, sat.orbit.rotNow, sat.theta)
      sat.x = px
      sat.y = py
      sat.depth = (Math.sin(sat.theta) + 1) / 2 // 0 far … 1 near
    }

    // --- Far side: orbits, rings, satellites, links (the planet then covers them) ---
    strokeOrbits(ox, oy, alpha, false)
    drawWaves(ox, oy, t, tilt, alpha, false)
    for (let i = 0; i < satellites.length; i++) if (satellites[i].depth < 0.5) drawSatellite(satellites[i], ox, oy, alpha, t)
    drawLinks(alpha, t)

    // --- Planet ---
    drawPlanet(ox, oy, t, alpha, enter, emit)

    // --- Near side ---
    strokeOrbits(ox, oy, alpha, true)
    drawWaves(ox, oy, t, tilt, alpha, true)
    for (let i = 0; i < satellites.length; i++) if (satellites[i].depth >= 0.5) drawSatellite(satellites[i], ox, oy, alpha, t)
    drawLabels(ox, oy, alpha)
  }

  // ---- Broadcast waves --------------------------------------------------------
  /** Wavefront radius (px, along the orbits' major axes) at life fraction p. */
  const waveRadius = (p) => lerp(pr * 1.05, R * 1.2, 1 - Math.pow(1 - p, 2.1))

  /**
   * Spawns a ring when mission.js asks for one, retires spent rings and
   * works out how strongly each orbit is lit by a passing wavefront: a sharp
   * leading edge, a slower afterglow. Returns the planet's emission (0..1),
   * a brief swell of its atmosphere as each ring leaves.
   */
  function updateWaves(t) {
    if (!reducedMotion && (state.wave || 0) !== seenWave) {
      seenWave = state.wave || 0
      waves.push({ t0: t, strength: state.waveStrength || 1 })
      if (waves.length > 4) waves.shift()
    }
    let live = 0 // retire spent rings in place
    for (let i = 0; i < waves.length; i++) if (t - waves[i].t0 <= WAVE_LIFE) waves[live++] = waves[i]
    waves.length = live

    const band = R * 0.05
    let emit = 0
    for (let i = 0; i < orbits.length; i++) orbits[i].flare = 0
    for (let w = 0; w < waves.length; w++) {
      const wave = waves[w]
      const p = (t - wave.t0) / WAVE_LIFE
      const r = waveRadius(p)
      const life = Math.pow(1 - p, 0.7) * wave.strength
      emit = Math.max(emit, Math.pow(1 - clamp(p * 3), 2) * wave.strength)
      for (let i = 0; i < orbits.length; i++) {
        const orbit = orbits[i]
        const d = r - orbit.rx // > 0 once the front has passed
        const f = d >= 0 ? Math.exp(-d / (band * 2.2)) : Math.exp(d / (band * 0.35))
        orbit.flare = Math.max(orbit.flare, f * life)
      }
    }
    for (let i = 0; i < orbits.length; i++) orbits[i].flare = Math.min(1, orbits[i].flare)
    return Math.min(1, emit)
  }

  /** Each ring: a soft wide band, a crisp front and a fainter echo behind it. */
  function drawWaves(ox, oy, t, tilt, alpha, near) {
    if (!waves.length) return
    const a0 = near ? 0 : Math.PI
    const a1 = near ? Math.PI : TAU
    const rot = meanRot - 0.05 * open
    const side = near ? 1 : 0.45
    for (let w = 0; w < waves.length; w++) {
      const wave = waves[w]
      const p = (t - wave.t0) / WAVE_LIFE
      const fade = Math.pow(1 - p, 1.5) * Math.min(1, p * 14) * wave.strength * alpha * side
      const r = waveRadius(p)
      const ratio = meanRatio * tilt
      if (!near) {
        // A translucent sweep of light across the plane, brightest at the
        // front (drawn once, before the planet, so the globe sits above it).
        // One unit gradient, scaled to the ring; its strength on globalAlpha.
        ctx.save()
        ctx.translate(ox, oy)
        ctx.rotate(rot)
        ctx.scale(r, r * ratio)
        ctx.globalAlpha = Math.min(1, fade / side / SWEEP_GAIN)
        ctx.fillStyle = sweep
        ctx.beginPath()
        ctx.arc(0, 0, 1, 0, TAU)
        ctx.fill()
        ctx.restore()
      }
      ctx.lineWidth = 9
      ctx.strokeStyle = deep(0.16 * fade)
      ctx.beginPath()
      ctx.ellipse(ox, oy, r * 0.985, r * 0.985 * ratio, rot, a0, a1)
      ctx.stroke()
      ctx.lineWidth = 1.25
      ctx.strokeStyle = atmo(0.7 * fade)
      ctx.beginPath()
      ctx.ellipse(ox, oy, r, r * ratio, rot, a0, a1)
      ctx.stroke()
      const echo = r * 0.86
      if (echo > pr * 1.1) {
        ctx.lineWidth = 1
        ctx.strokeStyle = atmo(0.22 * fade)
        ctx.beginPath()
        ctx.ellipse(ox, oy, echo, echo * ratio, rot, a0, a1)
        ctx.stroke()
      }
    }
  }

  /** Orbits are stroked in segments so the near side reads brighter. */
  function strokeOrbits(ox, oy, alpha, near) {
    const step = toStep(alpha)
    if (step !== orbitStep) {
      orbitStep = step
      for (let i = 0; i < orbits.length; i++) {
        const k = (orbits[i].bright * step) / ALPHA_STEPS
        for (let s = 0; s < SEGMENTS; s++) orbitStyles[i][s] = white(segBase[s] * k)
      }
    }
    const from = near ? 0 : HALF
    ctx.lineWidth = 1
    for (let i = 0; i < orbits.length; i++) {
      const { rx, ry, rotNow, flare, bright, dash } = orbits[i]
      const styles = orbitStyles[i]
      ctx.setLineDash(dash || NO_DASH)
      let a0 = segAngle[from]
      for (let s = from; s < from + HALF; s++) {
        const a1 = segAngle[s + 1]
        // a crossing wavefront tints the orbit atmo blue and lifts it
        ctx.strokeStyle =
          flare > 0.04
            ? atmo(Math.min(1, segBase[s] * bright + flare * (0.2 + 0.4 * segN[s])) * alpha)
            : styles[s]
        ctx.beginPath()
        ctx.ellipse(ox, oy, rx, ry, rotNow, a0, a1)
        ctx.stroke()
        a0 = a1
      }
    }
    ctx.setLineDash(NO_DASH)
  }

  function drawSatellite(sat, ox, oy, alpha, t) {
    const { rx, ry, rotNow, flare } = sat.orbit
    const { x, y, depth, accent } = sat
    const bodyAlpha = Math.min(1, (0.3 + 0.7 * depth) * (1 + flare * 0.8)) * alpha

    if (TRAIL) {
      // fading arc behind it, (1 - k / TRAIL)² × 0.55 × bodyAlpha (trailSteps)
      const styles = accent || flare > 0.3 ? ATMO_STEPS : WHITE_STEPS
      const row = toStep(bodyAlpha) * TRAIL
      const step = Math.min(0.9, (96 + 60 * flare) / Math.max(rx, 1)) / TRAIL // ~96px of arc
      let a1 = sat.theta
      ctx.lineWidth = 1
      for (let k = 0; k < TRAIL; k++) {
        const a0 = a1 - step
        ctx.strokeStyle = styles[trailSteps[row + k]]
        ctx.beginPath()
        ctx.ellipse(ox, oy, rx, ry, rotNow, a0, a1)
        ctx.stroke()
        a1 = a0
      }
    }

    // Sonar ping: a slow ring that expands and fades (never a flash)
    if (accent && !reducedMotion) {
      const phase = ((t + sat.pingOffset) % sat.ping) / 2.4
      if (phase < 1) {
        const ease = 1 - Math.pow(1 - phase, 3)
        ctx.strokeStyle = atmo((1 - phase) * 0.5 * bodyAlpha)
        ctx.beginPath()
        ctx.arc(x, y, 3 + ease * 22, 0, TAU)
        ctx.stroke()
      }
    }

    const glow = (accent ? 28 : 16) * (0.55 + 0.55 * depth) * (1 + flare * 1.3)
    ctx.globalAlpha = bodyAlpha * (accent ? 0.95 : 0.5 + 0.45 * flare)
    ctx.drawImage(accent || flare > 0.3 ? glowAtmo : glowWhite, x - glow / 2, y - glow / 2, glow, glow)
    ctx.globalAlpha = 1
    ctx.fillStyle = (accent ? ice : white)(bodyAlpha)
    ctx.beginPath()
    ctx.arc(x, y, sat.size * (0.65 + 0.6 * depth) * (1 + flare * 0.35), 0, TAU)
    ctx.fill()
  }


  /**
   * The constellation. Two kinds of link:
   *  - proximity: satellites that pass close join up (reach grows with `open`)
   *  - network: as the statement lights, every satellite also reaches for
   *    its two nearest neighbours, so by the last word the scattered lights
   *    form one connected web. Each link's weight fades to zero just before
   *    the neighbour ranking would swap, so links never pop.
   * Late in the read, data pulses run along the strongest links.
   */
  const N = satellites.length
  const weights = new Float32Array(N * N)
  const linked = new Uint8Array(N * N) // 1 where weights[] is set this frame
  // The pair maths runs on integer quarter-pixel positions (small integers
  // stay unboxed), taking square roots only where a link's weight needs one.
  const qx = new Int32Array(N)
  const qy = new Int32Array(N)
  const dist2 = new Int32Array(N * N) // squared distance, in quarter pixels²
  const pulses = new Float64Array(((N * (N - 1)) / 2) * 3) // x, y, strength per link

  /** Network link i–n: full weight until the 3rd neighbour nears (d → d3). */
  function join(i, n, d, d3, rank, net) {
    const w = clamp((d3 - d) / (0.35 * d3)) * rank * net
    const key = i < n ? i * N + n : n * N + i
    if (w > weights[key]) {
      weights[key] = w
      linked[key] = 1
    }
  }

  function drawLinks(alpha, t) {
    const reach = (mobile ? 120 : 180) * (0.62 + 0.6 * open)
    const net = clamp((open - 0.2) / 0.8) // network assembles as the text lights
    const flow = reducedMotion ? 0.7 : clamp((open - 0.62) / 0.38)
    const reach2 = reach * reach * 16
    const unit = 1 / (4 * reach)
    weights.fill(0)
    linked.fill(0)

    for (let i = 0; i < N; i++) {
      qx[i] = Math.round(satellites[i].x * 4)
      qy[i] = Math.round(satellites[i].y * 4)
    }
    for (let i = 0; i < N; i++) {
      const x = qx[i]
      const y = qy[i]
      for (let j = i + 1; j < N; j++) {
        const dx = x - qx[j]
        const dy = y - qy[j]
        const d2 = dx * dx + dy * dy
        dist2[i * N + j] = dist2[j * N + i] = d2
        if (d2 < reach2) {
          const f = 1 - Math.sqrt(d2) * unit
          weights[i * N + j] = f * f
          linked[i * N + j] = 1
        }
      }
    }
    if (net > 0 && N > 3) {
      for (let i = 0; i < N; i++) {
        // three nearest neighbours (d1 ≤ d2 ≤ d3, squared)
        let n1 = -1
        let n2 = -1
        let d1 = Infinity
        let d2 = Infinity
        let d3 = Infinity
        for (let j = 0; j < N; j++) {
          if (j === i) continue
          const d = dist2[i * N + j]
          if (d < d1) {
            d3 = d2
            d2 = d1
            n2 = n1
            d1 = d
            n1 = j
          } else if (d < d2) {
            d3 = d2
            d2 = d
            n2 = j
          } else if (d < d3) {
            d3 = d
          }
        }
        const r3 = Math.sqrt(d3)
        join(i, n1, Math.sqrt(d1), r3, 0.62, net)
        join(i, n2, Math.sqrt(d2), r3, 0.4, net)
      }
    }

    let count = 0 // pulses written this frame (× 3)
    ctx.lineWidth = 1
    for (let i = 0; i < N; i++) {
      const a = satellites[i]
      for (let j = i + 1; j < N; j++) {
        if (!linked[i * N + j]) continue
        const w = weights[i * N + j]
        if (w < 0.01) continue
        const b = satellites[j]
        const lift = 1 + 1.6 * Math.max(a.orbit.flare, b.orbit.flare)
        const depth = 0.3 + 0.7 * Math.max(a.depth, b.depth)
        ctx.strokeStyle = atmo(Math.min(0.9, w * 0.42 * lift) * alpha * depth)
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
        if (flow > 0 && w > 0.12) {
          // deterministic per link: speed, offset and direction
          const seed = ((i + 1) * 73856093) ^ ((j + 1) * 19349663)
          const speed = 0.14 + ((seed >>> 3) % 7) * 0.03
          let k = (t * speed + ((seed >>> 5) % 97) / 97) % 1
          if (seed & 1) k = 1 - k
          pulses[count++] = lerp(a.x, b.x, k)
          pulses[count++] = lerp(a.y, b.y, k)
          pulses[count++] = flow * Math.min(1, w * 2.2) * depth * Math.sin(k * Math.PI)
        }
      }
    }
    for (let p = 0; p < count; p += 3) {
      const s = 9
      ctx.globalAlpha = pulses[p + 2] * alpha
      ctx.drawImage(glowAtmo, pulses[p] - s / 2, pulses[p + 1] - s / 2, s, s)
    }
    ctx.globalAlpha = 1
  }

  /**
   * Atmosphere halo (brightens into a soft sunrise as the manifesto completes
   * and swells briefly each time the planet transmits), opaque body + lit
   * limb, then a slowly turning graticule clipped inside.
   */
  function drawPlanet(ox, oy, t, alpha, enter, emit) {
    const size = halo.width / pixelRatio
    ctx.globalAlpha = Math.min(1, alpha * (0.55 + 0.45 * open + 0.6 * emit))
    ctx.drawImage(halo, ox - size / 2, oy - size / 2, size, size)
    if (emit > 0.01) {
      // the transmit swell: halo drawn again, a touch larger
      const swell = size * (1 + 0.12 * (1 - emit))
      ctx.globalAlpha = 0.5 * emit * alpha
      ctx.drawImage(halo, ox - swell / 2, oy - swell / 2, swell, swell)
    }
    ctx.globalAlpha = enter // opaque once in: the far orbits pass behind it
    ctx.drawImage(body, ox - size / 2, oy - size / 2, size, size)
    ctx.globalAlpha = alpha

    ctx.save()
    ctx.beginPath()
    ctx.arc(ox, oy, pr - 0.5, 0, TAU)
    ctx.clip()
    ctx.translate(ox, oy)
    ctx.rotate(meanRot)
    ctx.lineWidth = 0.6
    // Meridians: half-ellipses on the visible hemisphere, fading at the limb
    const spin = reducedMotion ? 0.4 : t * 0.06
    for (let k = 0; k < MERIDIANS * 2; k++) {
      const lambda = (k / (MERIDIANS * 2)) * TAU + spin
      const facing = Math.cos(lambda)
      if (facing <= 0.02) continue
      const sx = Math.sin(lambda)
      ctx.strokeStyle = atmo(0.15 * facing)
      ctx.beginPath()
      ctx.ellipse(0, 0, pr * Math.abs(sx), pr, 0, -Math.PI / 2, Math.PI / 2, sx < 0)
      ctx.stroke()
    }
    // Parallels (near halves), seen from just above the equator
    const elev = 0.25 * (1 + 0.32 * open)
    for (let i = 0; i < LATITUDES.length; i++) {
      const lat = LATITUDES[i]
      const r = pr * Math.cos(lat)
      ctx.strokeStyle = lat === 0 ? EQUATOR : PARALLEL
      ctx.beginPath()
      ctx.ellipse(0, -pr * Math.sin(lat), r, r * elev, 0, 0, Math.PI)
      ctx.stroke()
    }
    // Night side: a soft terminator so the globe reads as a lit sphere
    ctx.rotate(-meanRot)
    ctx.fillStyle = shade
    ctx.fillRect(-pr, -pr, pr * 2, pr * 2)
    ctx.restore()
    ctx.globalAlpha = 1
  }

  function drawLabels(ox, oy, alpha) {
    ctx.font = mobile ? LABEL_FONT_MOBILE : LABEL_FONT
    ctx.textBaseline = 'alphabetic'
    if ('letterSpacing' in ctx) ctx.letterSpacing = '2px'
    for (let i = 0; i < orbits.length; i++) {
      const orbit = orbits[i]
      if (!orbit.label || orbit.labelTheta === null) continue
      project(ox, oy, orbit.rx, orbit.ry, orbit.rotNow, orbit.labelTheta)
      const x = px
      const y = py
      if (inKeepOut(x, y - 10) || inKeepOut(x + 60, y - 10)) continue // drifted under the text
      ctx.fillStyle = white(0.7 * alpha)
      ctx.fillRect(x - 1.5, y - 1.5, 3, 3)
      ctx.strokeStyle = white(0.35 * alpha)
      ctx.beginPath()
      ctx.moveTo(x + 4, y - 4)
      ctx.lineTo(x + 10, y - 10)
      ctx.stroke()
      ctx.fillStyle = white(0.55 * alpha)
      ctx.fillText(orbit.label, x + 13, y - 10)
    }
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px'
  }

  // ---- Lifecycle ------------------------------------------------------------
  const ro = new ResizeObserver(resize)
  ro.observe(canvas)
  if (avoid) ro.observe(avoid)
  resize()
  document.fonts?.ready.then(resize)

  const loop = reducedMotion ? null : createRenderLoop(host, draw)

  return {
    destroy() {
      loop?.destroy()
      ro.disconnect()
      window.removeEventListener('pointermove', onPointer)
    },
  }
}

/* ---- Colours, gradients and sprites -------------------------------------- */

/** `rgba()` strings for one base colour, indexed by alpha step (0 … ALPHA_STEPS). */
function rgbaSteps(rgb) {
  return Array.from({ length: ALPHA_STEPS + 1 }, (_, i) => `rgba(${rgb}, ${Number((i / ALPHA_STEPS).toFixed(4))})`)
}

/** Night-side terminator over the planet disc (radius `pr`, centred on 0, 0). */
function makeShade(ctx, pr) {
  const lx = Math.cos(LIGHT) * pr
  const ly = Math.sin(LIGHT) * pr
  const shade = ctx.createLinearGradient(lx, ly, -lx, -ly)
  shade.addColorStop(0, 'rgba(0, 0, 0, 0)')
  shade.addColorStop(0.45, 'rgba(0, 0, 0, 0.1)')
  shade.addColorStop(1, 'rgba(0, 0, 0, 0.62)')
  return shade
}

/**
 * A broadcast ring's sweep of light at unit radius, at SWEEP_GAIN × its
 * strongest; drawn scaled to the ring with the strength on globalAlpha.
 */
function makeSweep(ctx) {
  const sweep = ctx.createRadialGradient(0, 0, 0.55, 0, 0, 1)
  sweep.addColorStop(0, `rgba(${DEEP}, 0)`)
  sweep.addColorStop(0.75, `rgba(${DEEP}, ${0.07 * SWEEP_GAIN})`)
  sweep.addColorStop(1, `rgba(${ATMO}, ${0.16 * SWEEP_GAIN})`)
  return sweep
}

/** Soft round glow, used for satellites. */
function makeGlow(rgb) {
  const size = 64
  const sprite = document.createElement('canvas')
  sprite.width = sprite.height = size
  const g = sprite.getContext('2d')
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  grad.addColorStop(0, `rgba(${rgb}, 0.9)`)
  grad.addColorStop(0.25, `rgba(${rgb}, 0.35)`)
  grad.addColorStop(1, `rgba(${rgb}, 0)`)
  g.fillStyle = grad
  g.fillRect(0, 0, size, size)
  return sprite
}

/**
 * The planet, as two sprites of the same size:
 *  - halo: soft atmosphere, strongest toward the sun
 *  - body: opaque near-black disc with a crisp limb, bright on the day side
 */
function makePlanet(pr, pixelRatio) {
  const pad = pr * 0.6
  const size = Math.ceil((pr + pad) * 2)
  const px = Math.ceil(size * pixelRatio)
  const c = size / 2
  const lx = Math.cos(LIGHT)
  const ly = Math.sin(LIGHT)
  const sprite = () => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = px
    const g = canvas.getContext('2d')
    g.scale(pixelRatio, pixelRatio)
    return [canvas, g]
  }

  const [halo, h] = sprite()
  const ring = h.createRadialGradient(c, c, pr * 0.96, c, c, pr + pad)
  ring.addColorStop(0, `rgba(${ATMO}, 0.55)`)
  ring.addColorStop(0.12, `rgba(${ATMO}, 0.24)`)
  ring.addColorStop(0.45, `rgba(${DEEP}, 0.07)`)
  ring.addColorStop(1, `rgba(${DEEP}, 0)`)
  h.fillStyle = ring
  h.fillRect(0, 0, size, size)
  h.globalCompositeOperation = 'destination-in'
  const side = h.createLinearGradient(c + lx * pr, c + ly * pr, c - lx * pr, c - ly * pr)
  side.addColorStop(0, 'rgba(0,0,0,1)')
  side.addColorStop(0.55, 'rgba(0,0,0,0.25)')
  side.addColorStop(1, 'rgba(0,0,0,0.05)')
  h.fillStyle = side
  h.fillRect(0, 0, size, size)

  const [body, g] = sprite()
  const fill = g.createRadialGradient(c + lx * pr * 0.5, c + ly * pr * 0.5, 0, c, c, pr)
  fill.addColorStop(0, '#0b1626')
  fill.addColorStop(0.7, '#03070e')
  fill.addColorStop(1, '#010204')
  g.fillStyle = fill
  g.beginPath()
  g.arc(c, c, pr, 0, TAU)
  g.fill()
  const limb = g.createLinearGradient(c + lx * pr, c + ly * pr, c - lx * pr, c - ly * pr)
  limb.addColorStop(0, 'rgba(199, 236, 255, 0.95)')
  limb.addColorStop(0.45, `rgba(${ATMO}, 0.35)`)
  limb.addColorStop(1, `rgba(${ATMO}, 0.06)`)
  g.strokeStyle = limb
  g.lineWidth = 1.25
  g.beginPath()
  g.arc(c, c, pr, 0, TAU)
  g.stroke()

  return [halo, body]
}

/** A sparse, faint star field rendered once per resize. */
function makeStars(W, H, pixelRatio, rand) {
  const sprite = document.createElement('canvas')
  sprite.width = Math.round(W * pixelRatio)
  sprite.height = Math.round(H * pixelRatio)
  const g = sprite.getContext('2d')
  g.scale(pixelRatio, pixelRatio)
  const count = Math.round(((W * H) / 8000) * byTier({ high: 1, medium: 0.8, low: 0.6 }))
  for (let i = 0; i < count; i++) {
    const r = rand()
    const size = r > 0.97 ? 1.4 : r > 0.8 ? 1 : 0.7
    const a = 0.1 + Math.pow(rand(), 2.2) * 0.55
    g.fillStyle = rand() < 0.18 ? `rgba(199, 236, 255, ${a})` : `rgba(244, 246, 251, ${a})`
    g.beginPath()
    g.arc(rand() * W, rand() * H, size / 2, 0, TAU)
    g.fill()
  }
  return sprite
}
