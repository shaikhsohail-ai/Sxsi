/**
 * Procedural vehicles for the fleet hologram — original "intelligence cores",
 * not rockets: each one is a geometric idea of a kind of mind.
 *
 *   NOVA    compact geodesic core with one fast orbit           (an atom: small, quick)
 *   VECTOR  hexagonal bipyramid with a heading and three agents  (a vessel: directed, acting)
 *   APOGEE  lattice globe, nested dodecahedron, meridian ring and
 *           a ring system with a gap                             (a ringed world: vast)
 *   ZENITH  black hole: dark horizon, lensed halo (scene.js), thin
 *           accretion disc, polar jets, a 4D hypercube inside    (beyond — classified)
 *
 * Read in order they climb the cosmic scale — atom, vessel, world, singularity.
 *
 * Each vehicle is described twice in the same object space:
 *   - `swarm`: N particle targets (xyz + size) plus a spin per particle (axis +
 *     angular speed), so rings of light flow along their own orbits;
 *   - `lines`: LineSegments data that rotate with exactly the same spins, so the
 *     particles and the wireframe stay registered.
 * The ZENITH hypercube is animated in 4D by the scene and has no particles.
 */
import { DodecahedronGeometry, EdgesGeometry, IcosahedronGeometry, Vector3 } from 'three'
import { lerp, seededRandom } from '../../lib/dom.js'

const TAU = Math.PI * 2
const Y = new Vector3(0, 1, 0)

/** Unit normal tilted `tilt` radians away from +Y, toward azimuth `phi`. */
const tilted = (tilt, phi = 0) =>
  new Vector3(Math.sin(tilt) * Math.cos(phi), Math.cos(tilt), Math.sin(tilt) * Math.sin(phi)).normalize()

/** Orthonormal pair spanning the plane perpendicular to `n`. */
function basis(n) {
  const ref = Math.abs(n.y) < 0.95 ? Y : new Vector3(1, 0, 0)
  const u = new Vector3().crossVectors(n, ref).normalize()
  const v = new Vector3().crossVectors(n, u).normalize()
  return [u, v]
}

/* --------------------------------------------------------------------------
 * Segment lists: flat [ax, ay, az, bx, by, bz, …]
 * ------------------------------------------------------------------------ */
function edgesOf(geometry) {
  const edges = new EdgesGeometry(geometry, 1)
  const segs = Array.from(edges.attributes.position.array)
  edges.dispose()
  geometry.dispose()
  return segs
}

function verticesOf(geometry) {
  const pos = geometry.attributes.position.array
  const seen = new Map()
  for (let i = 0; i < pos.length; i += 3) {
    const key = `${pos[i].toFixed(3)},${pos[i + 1].toFixed(3)},${pos[i + 2].toFixed(3)}`
    if (!seen.has(key)) seen.set(key, [pos[i], pos[i + 1], pos[i + 2]])
  }
  geometry.dispose()
  return [...seen.values()]
}

/** Circle (optionally dashed as [on, off] segment counts) around normal `n`. */
function ringSegs(radius, n, segments = 128, dash = null) {
  const [u, v] = basis(n)
  const segs = []
  for (let k = 0; k < segments; k++) {
    if (dash && k % (dash[0] + dash[1]) >= dash[0]) continue
    for (const j of [k, k + 1]) {
      const a = (j / segments) * TAU
      const c = Math.cos(a) * radius
      const s = Math.sin(a) * radius
      segs.push(u.x * c + v.x * s, u.y * c + v.y * s, u.z * c + v.z * s)
    }
  }
  return segs
}

/** Hexagonal (or n-sided) bipyramid along Y. */
function bipyramid(height, radius, sides, twist = 0) {
  const ring = Array.from({ length: sides }, (_, k) => {
    const a = twist + (k / sides) * TAU
    return [Math.cos(a) * radius, 0, Math.sin(a) * radius]
  })
  const segs = []
  ring.forEach((p, k) => {
    const q = ring[(k + 1) % sides]
    segs.push(0, height, 0, ...p, 0, -height, 0, ...p, ...p, ...q)
  })
  return { segs, ring }
}

/* --------------------------------------------------------------------------
 * Particle samplers: (rand) => [x, y, z, size, speed?]
 * ------------------------------------------------------------------------ */
const between = (r, [a, b]) => a + (b - a) * r()

function onEdges(segs, jitter, size) {
  const n = segs.length / 6
  const cum = new Float64Array(n)
  let total = 0
  for (let i = 0; i < n; i++) {
    const o = i * 6
    total += Math.hypot(segs[o + 3] - segs[o], segs[o + 4] - segs[o + 1], segs[o + 5] - segs[o + 2])
    cum[i] = total
  }
  return (r) => {
    const x = r() * total
    let lo = 0
    let hi = n - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (cum[mid] < x) lo = mid + 1
      else hi = mid
    }
    const o = lo * 6
    const t = r()
    return [
      lerp(segs[o], segs[o + 3], t) + (r() - 0.5) * jitter,
      lerp(segs[o + 1], segs[o + 4], t) + (r() - 0.5) * jitter,
      lerp(segs[o + 2], segs[o + 5], t) + (r() - 0.5) * jitter,
      between(r, size),
    ]
  }
}

function randomDir(r) {
  const u = r() * 2 - 1
  const a = r() * TAU
  const s = Math.sqrt(1 - u * u)
  return [Math.cos(a) * s, u, Math.sin(a) * s]
}

function inBall(radius, size, power = 2) {
  return (r) => {
    const [x, y, z] = randomDir(r)
    const d = radius * Math.pow(r(), power)
    return [x * d, y * d, z * d, between(r, size)]
  }
}

function onSphere(radius, size, thickness = 0) {
  return (r) => {
    const [x, y, z] = randomDir(r)
    const d = radius + (r() - 0.5) * thickness
    return [x * d, y * d, z * d, between(r, size)]
  }
}

function atPoints(points, radius, size) {
  const ball = inBall(radius, size, 1.4)
  return (r) => {
    const p = points[Math.floor(r() * points.length)]
    const [x, y, z, s] = ball(r)
    return [p[0] + x, p[1] + y, p[2] + z, s]
  }
}

function onRing(radius, n, size, spread = 0, thickness = 0) {
  const [u, v] = basis(n)
  return (r) => {
    const a = r() * TAU
    const rr = radius + (r() - 0.5) * spread
    const h = (r() - 0.5) * thickness
    const c = Math.cos(a) * rr
    const s = Math.sin(a) * rr
    return [u.x * c + v.x * s + n.x * h, u.y * c + v.y * s + n.y * h, u.z * c + v.z * s + n.z * h, between(r, size)]
  }
}

/** A tight cluster sitting on an orbit at angle `a0` — it orbits via its spin. */
function satellite(radius, n, a0, size) {
  const [u, v] = basis(n)
  const c = Math.cos(a0) * radius
  const s = Math.sin(a0) * radius
  const centre = [u.x * c + v.x * s, u.y * c + v.y * s, u.z * c + v.z * s]
  return atPoints([centre], 0.055, size)
}

/** Flat disc, denser toward the centre, with Keplerian angular speeds. */
function accretion(inner, outer, n, size, k) {
  const [u, v] = basis(n)
  return (r) => {
    const a = r() * TAU
    const rr = inner + (outer - inner) * Math.pow(r(), 1.7)
    const h = (r() - 0.5) * 0.05 * (rr / outer)
    const c = Math.cos(a) * rr
    const s = Math.sin(a) * rr
    const speed = k * Math.pow(inner / rr, 1.5)
    return [u.x * c + v.x * s + n.x * h, u.y * c + v.y * s + n.y * h, u.z * c + v.z * s + n.z * h, between(r, size), speed]
  }
}

/** Polar jets along `n`: a long one up, a short one down, flaring with distance. */
function jets(n, up, down, size) {
  const [u, v] = basis(n)
  return (r) => {
    const dir = r() < up / (up + down) ? 1 : -1
    const h = (0.22 + Math.pow(r(), 0.8) * ((dir > 0 ? up : down) - 0.22)) * dir
    const spread = 0.025 + Math.abs(h) * 0.07
    const a = r() * TAU
    const c = Math.cos(a) * spread
    const s = Math.sin(a) * spread
    return [n.x * h + u.x * c + v.x * s, n.y * h + u.y * c + v.y * s, n.z * h + u.z * c + v.z * s, between(r, size)]
  }
}

/* --------------------------------------------------------------------------
 * Vehicles
 * ------------------------------------------------------------------------ */
const comp = (weight, sample, axis = Y, speed = 0) => ({ weight, sample, axis, speed })
const part = (segs, alpha, axis = Y, speed = 0) => ({ segs, alpha, axis, speed })

function nova() {
  const shell = edgesOf(new IcosahedronGeometry(0.56, 1))
  const nodes = verticesOf(new IcosahedronGeometry(0.56, 1))
  const inner = edgesOf(new IcosahedronGeometry(0.27, 0))
  const orbit = tilted(0.36, 0.5)
  const outer = tilted(-0.62, 2.1)
  return {
    swarm: [
      comp(0.34, onEdges(shell, 0.008, [0.75, 1.05]), Y, 0.24),
      comp(0.12, atPoints(nodes, 0.016, [1.3, 2.1]), Y, 0.24),
      comp(0.1, onEdges(inner, 0.006, [0.8, 1.2]), Y, -0.55),
      comp(0.1, inBall(0.13, [1.1, 1.9], 1.6)),
      comp(0.24, onRing(0.86, orbit, [0.65, 1.05], 0.03, 0.012), orbit, 1.15),
      comp(0.1, onRing(0.99, outer, [0.45, 0.75], 0.01), outer, -0.62),
    ],
    lines: [
      part(shell, 0.5, Y, 0.24),
      part(inner, 0.38, Y, -0.55),
      part(ringSegs(0.86, orbit, 160, [3, 1]), 0.42, orbit, 1.15),
      part(ringSegs(0.99, outer, 140, [1, 2]), 0.22, outer, -0.62),
    ],
  }
}

function vector() {
  const outer = bipyramid(1.02, 0.44, 6)
  const inner = bipyramid(0.56, 0.22, 6, Math.PI / 6)
  const heading = [0, 1.06, 0, 0, 1.46, 0, 0, 1.46, 0, 0.07, 1.34, 0, 0, 1.46, 0, -0.07, 1.34, 0, 0, 1.46, 0, 0, 1.34, 0.07]
  const orbits = [
    { r: 0.8, n: tilted(1.08, 0.3), s: 0.95, a0: 0.4 },
    { r: 0.94, n: tilted(-0.98, 2.2), s: -0.72, a0: 2.6 },
    { r: 1.1, n: tilted(1.36, 4.1), s: 0.56, a0: 4.4 },
  ]
  return {
    swarm: [
      comp(0.28, onEdges(outer.segs, 0.008, [0.75, 1.05]), Y, 0.3),
      comp(0.1, onEdges(inner.segs, 0.006, [0.7, 1.0]), Y, -0.48),
      comp(0.08, atPoints(outer.ring, 0.024, [1.5, 2.3]), Y, 0.3),
      comp(0.07, inBall(0.12, [1.1, 1.8], 1.5)),
      ...orbits.flatMap((o) => [
        comp(0.07, onRing(o.r, o.n, [0.4, 0.7], 0.008), o.n, o.s),
        comp(0.04, satellite(o.r, o.n, o.a0, [1.2, 2.0]), o.n, o.s),
      ]),
      comp(0.04, onEdges(heading, 0.004, [0.9, 1.3]), Y, 0.3),
    ],
    lines: [
      part(outer.segs, 0.58, Y, 0.3),
      part(inner.segs, 0.32, Y, -0.48),
      ...orbits.map((o) => part(ringSegs(o.r, o.n, 150, [2, 2]), 0.3, o.n, o.s)),
      part(heading, 0.65, Y, 0.3),
    ],
  }
}

function apogee() {
  const net = edgesOf(new IcosahedronGeometry(0.95, 2))
  const dode = edgesOf(new DodecahedronGeometry(0.5, 0))
  const dodeNodes = verticesOf(new DodecahedronGeometry(0.5, 0))
  const dodeAxis = tilted(0.5, 0.8)
  // A ringed world: lattice globe, a reasoning core inside it, one meridian
  // ring and a broad ring system with a Cassini-like gap.
  const band = tilted(0.3, 2.4)
  const meridian = tilted(Math.PI / 2 - 0.2, 0.9)
  return {
    swarm: [
      comp(0.15, onSphere(0.95, [0.45, 0.8], 0.012), Y, 0.08),
      comp(0.11, onEdges(net, 0.004, [0.55, 0.85]), Y, 0.08),
      comp(0.1, onEdges(dode, 0.006, [0.85, 1.25]), dodeAxis, -0.3),
      comp(0.05, atPoints(dodeNodes, 0.02, [1.6, 2.4]), dodeAxis, -0.3),
      comp(0.05, inBall(0.16, [1.2, 2.1], 1.5)),
      comp(0.06, onRing(1.12, meridian, [0.6, 1.0], 0.012, 0.004), meridian, 0.32),
      comp(0.27, accretion(1.3, 1.54, band, [0.7, 1.2], 0.34), band, 0.3),
      comp(0.16, accretion(1.62, 1.86, band, [0.6, 1.0], 0.27), band, 0.24),
      comp(0.05, onRing(2.0, band, [0.4, 0.7], 0.03), band, 0.1),
    ],
    lines: [
      part(net, 0.14, Y, 0.08),
      part(dode, 0.55, dodeAxis, -0.3),
      part(ringSegs(1.12, meridian, 200), 0.3, meridian, 0.32),
      part(ringSegs(1.3, band, 220), 0.44, band, 0.3),
      part(ringSegs(1.54, band, 220, [3, 1]), 0.16, band, 0.3),
      part(ringSegs(1.62, band, 220, [3, 1]), 0.16, band, 0.24),
      part(ringSegs(1.86, band, 240), 0.36, band, 0.24),
      part(ringSegs(2.0, band, 240, [1, 3]), 0.14, band, 0.1),
    ],
  }
}

function zenith() {
  // Nearly edge-on to the camera, like the classic picture of a black hole:
  // the near side of the disc crosses in front of the shadow, the far side is
  // hidden behind it, and the lensed halo (drawn by the scene) arcs over it.
  const disc = tilted(0.1, 0.6)
  const jetSegs = (() => {
    const segs = []
    for (const [from, to] of [[0.62, 2.15], [-0.62, -1.35]]) {
      // split into steps so the line alpha can fade with distance
      const steps = 12
      for (let i = 0; i < steps; i++) {
        const a = from + ((to - from) * i) / steps
        const b = from + ((to - from) * (i + 1)) / steps
        segs.push(disc.x * a, disc.y * a, disc.z * a, disc.x * b, disc.y * b, disc.z * b)
      }
    }
    return segs
  })()
  const kepler = (r) => 0.9 * Math.pow(0.9 / r, 1.5)
  return {
    swarm: [
      comp(0.5, accretion(0.88, 2.15, disc, [0.6, 1.45], 0.95), disc, 0.7),
      comp(0.12, onRing(0.9, disc, [1.0, 1.7], 0.035, 0.008), disc, kepler(0.9)),
      comp(0.12, jets(disc, 2.15, 1.35, [0.45, 0.9]), disc, 1.6),
      comp(0.1, onSphere(1.5, [0.25, 0.5], 0.6), Y, 0.04),
      comp(0.16, onRing(2.4, disc, [0.35, 0.7], 0.12), disc, 0.14),
    ],
    lines: [
      part(ringSegs(0.9, disc, 160), 0.55, disc, kepler(0.9)),
      part(ringSegs(1.25, disc, 180, [6, 2]), 0.32, disc, kepler(1.25)),
      part(ringSegs(1.65, disc, 200, [3, 3]), 0.26, disc, kepler(1.65)),
      part(ringSegs(2.15, disc, 220, [1, 3]), 0.2, disc, kepler(2.15)),
      part(ringSegs(2.45, disc, 240), 0.15, disc, 0.14),
      part(jetSegs, (x, y) => 0.5 * Math.max(0, 1 - Math.abs(y) / 2.3), disc, 0),
    ],
  }
}

/* --------------------------------------------------------------------------
 * Assembly
 * ------------------------------------------------------------------------ */
function fillSwarm(components, count, rand) {
  const total = components.reduce((sum, c) => sum + c.weight, 0)
  const rows = []
  components.forEach((c, index) => {
    const n = index === components.length - 1 ? count - rows.length : Math.round((c.weight / total) * count)
    for (let k = 0; k < n; k++) {
      const [x, y, z, size, speed] = c.sample(rand)
      rows.push([x, y, z, size, c.axis.x, c.axis.y, c.axis.z, speed ?? c.speed])
    }
  })
  // Order by azimuth so particle i sits in a similar direction in every vehicle:
  // morphs then read as the swarm re-forming in place, not exploding.
  const order = rows.map((row, i) => [Math.atan2(row[2], row[0]), i]).sort((a, b) => a[0] - b[0])

  const pos = new Float32Array(count * 4)
  const spin = new Float32Array(count * 4)
  order.forEach(([, index], i) => {
    const row = rows[index]
    for (let k = 0; k < 4; k++) {
      pos[i * 4 + k] = row[k]
      spin[i * 4 + k] = row[k + 4]
    }
  })
  return { pos, spin }
}

/**
 * Display scale per vehicle. The hologram stage frames every vehicle generously
 * (the selector line-up carries the true relative scale), but sizes still climb
 * from NOVA to ZENITH.
 */
export const VEHICLE_SCALE = [1.34, 1.12, 1, 1]

/** ZENITH's event-horizon radius (object space) — the scene draws the shadow. */
export const HORIZON_RADIUS = 0.6

const scaleSegs = (segs, k) => (k === 1 ? segs : segs.map((v) => v * k))

/** Builds all four vehicles with `count` particles each. Deterministic. */
export function buildFleet(count) {
  const rand = seededRandom(0x5a51)
  const vehicles = [nova(), vector(), apogee(), zenith()].map((v, i) => {
    const k = VEHICLE_SCALE[i]
    const swarm = fillSwarm(v.swarm, count, rand)
    // xyz scale; w (particle size) stays
    for (let j = 0; k !== 1 && j < swarm.pos.length; j += 4) {
      swarm.pos[j] *= k
      swarm.pos[j + 1] *= k
      swarm.pos[j + 2] *= k
    }
    return { swarm, lines: v.lines.map((p) => ({ ...p, segs: scaleSegs(p.segs, k) })) }
  })

  // Shared per-particle randomness: launch lead, twinkle rate, brightness, phase.
  const random = new Float32Array(count * 4)
  for (let i = 0; i < random.length; i++) random[i] = rand()

  return { vehicles, random, count }
}

/** Projector pad line art (lies in the XZ plane at y = 0). */
export function buildPad() {
  const flat = Y
  const ticks = []
  for (let k = 0; k < 120; k++) {
    const a = (k / 120) * TAU
    const r0 = 1.4
    const r1 = k % 10 === 0 ? 1.56 : k % 5 === 0 ? 1.5 : 1.46
    ticks.push(Math.cos(a) * r0, 0, Math.sin(a) * r0, Math.cos(a) * r1, 0, Math.sin(a) * r1)
  }
  const cross = [-0.32, 0, 0, -0.1, 0, 0, 0.1, 0, 0, 0.32, 0, 0, 0, 0, -0.32, 0, 0, -0.1, 0, 0, 0.1, 0, 0, 0.32]
  // Faint polar floor grid that fades into the dark beyond the pad
  const spokes = []
  for (let k = 0; k < 36; k++) {
    const a = (k / 36) * TAU
    spokes.push(Math.cos(a) * 1.78, 0, Math.sin(a) * 1.78, Math.cos(a) * 2.9, 0, Math.sin(a) * 2.9)
  }
  const fade = (x, y, z) => 0.16 * Math.max(0, 1 - (Math.hypot(x, z) - 1.7) / 1.25)
  return [
    part(spokes, fade),
    part(ringSegs(2.1, flat, 220), fade),
    part(ringSegs(2.5, flat, 240, [2, 2]), fade),
    part(ringSegs(0.48, flat, 96), 0.42),
    part(ringSegs(0.9, flat, 128), 0.24),
    part(ringSegs(1.4, flat, 160), 0.4),
    part(ringSegs(1.72, flat, 200, [1, 2]), 0.2, flat, -0.05),
    part(ringSegs(1.12, flat, 144, [8, 4]), 0.32, flat, 0.22),
    part(ticks, 0.34, flat, -0.04),
    part(cross, 0.5),
  ]
}

/** The rebuild scanner: a dashed ring with radial ticks (XZ plane). */
export function buildScanner() {
  const ticks = []
  for (let k = 0; k < 48; k++) {
    const a = (k / 48) * TAU
    ticks.push(Math.cos(a) * 1.9, 0, Math.sin(a) * 1.9, Math.cos(a) * 2.02, 0, Math.sin(a) * 2.02)
  }
  return [part(ringSegs(1.9, Y, 180), 0.9), part(ringSegs(1.7, Y, 160, [2, 3]), 0.4), part(ticks, 0.6)]
}

/** 16 vertices and 32 edges of the unit tesseract. */
export function tesseract() {
  const verts = []
  for (let i = 0; i < 16; i++) verts.push([i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1, i & 8 ? 1 : -1])
  const edges = []
  for (let i = 0; i < 16; i++) {
    for (let bit = 0; bit < 4; bit++) {
      const j = i ^ (1 << bit)
      if (j > i) edges.push([i, j])
    }
  }
  return { verts, edges }
}
