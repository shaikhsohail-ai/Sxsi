/**
 * "A planet that thinks": procedural city lights wired into a neural network.
 *
 * Nodes cluster into metros on procedural continents (denser along the
 * coasts), chains of nodes run along corridors between neighbouring metros,
 * every node links to its nearest neighbours (synapses), and metros are joined
 * by long arcs raised above the surface. Only the part of the planet that can
 * ever appear on screen is populated (`keep` decides), so every vertex counts.
 *
 * Planet radius = 1; the camera hovers above +Y.
 */
import { seededRandom } from '../../lib/dom.js'

/* ---- tiny deterministic 3D value noise (continents) ---------------------- */
function hash3(x, y, z) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1274126177)
  h = Math.imul(h ^ (h >>> 13), 1103515245)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

function valueNoise(x, y, z) {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const zi = Math.floor(z)
  const fx = x - xi
  const fy = y - yi
  const fz = z - zi
  const u = fx * fx * (3 - 2 * fx)
  const v = fy * fy * (3 - 2 * fy)
  const w = fz * fz * (3 - 2 * fz)
  const l = (a, b, t) => a + (b - a) * t
  return l(
    l(l(hash3(xi, yi, zi), hash3(xi + 1, yi, zi), u), l(hash3(xi, yi + 1, zi), hash3(xi + 1, yi + 1, zi), u), v),
    l(l(hash3(xi, yi, zi + 1), hash3(xi + 1, yi, zi + 1), u), l(hash3(xi, yi + 1, zi + 1), hash3(xi + 1, yi + 1, zi + 1), u), v),
    w,
  )
}

function continents(x, y, z) {
  let sum = 0
  let amp = 0.5
  let f = 9
  let norm = 0
  for (let i = 0; i < 4; i++) {
    sum += amp * valueNoise(x * f + 3.1, y * f + 7.7, z * f + 1.3)
    norm += amp
    f *= 2.07
    amp *= 0.5
  }
  return sum / norm
}

/* ---- vector helpers (plain arrays keep this allocation-light) ------------ */
const normalize = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const dist2 = (a, b) => {
  const x = a[0] - b[0]
  const y = a[1] - b[1]
  const z = a[2] - b[2]
  return x * x + y * y + z * z
}

/** Spatial hash over the unit sphere with numeric keys (no string churn). */
function createHash(cellSize) {
  const map = new Map()
  const cellOf = (v) => Math.floor(v / cellSize)
  const key = (x, y, z) => ((x + 4096) * 8192 + (y + 4096)) * 8192 + (z + 4096)
  return {
    add(p, value) {
      const k = key(cellOf(p[0]), cellOf(p[1]), cellOf(p[2]))
      const list = map.get(k)
      if (list) list.push(value)
      else map.set(k, [value])
    },
    /** Calls fn(value) for everything within `r` cells of p. Return true to stop. */
    near(p, r, fn) {
      const cx = cellOf(p[0])
      const cy = cellOf(p[1])
      const cz = cellOf(p[2])
      for (let dx = -r; dx <= r; dx++)
        for (let dy = -r; dy <= r; dy++)
          for (let dz = -r; dz <= r; dz++) {
            const list = map.get(key(cx + dx, cy + dy, cz + dz))
            if (list) for (let i = 0; i < list.length; i++) if (fn(list[i])) return true
          }
      return false
    },
  }
}

function tangentBasis(n) {
  const up = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
  const t1 = normalize([up[1] * n[2] - up[2] * n[1], up[2] * n[0] - up[0] * n[2], up[0] * n[1] - up[1] * n[0]])
  const t2 = [n[1] * t1[2] - n[2] * t1[1], n[2] * t1[0] - n[0] * t1[2], n[0] * t1[1] - n[1] * t1[0]]
  return [t1, t2]
}

function slerp(a, b, t) {
  const dot = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))
  const omega = Math.acos(dot)
  if (omega < 1e-6) return a.slice()
  const so = Math.sin(omega)
  const ka = Math.sin((1 - t) * omega) / so
  const kb = Math.sin(t * omega) / so
  return [a[0] * ka + b[0] * kb, a[1] * ka + b[1] * kb, a[2] * ka + b[2] * kb]
}

/**
 * Builds the `keep(p)` test from serialisable camera poses:
 * `{ m: number[16] (projection × view, column-major), pos: [x, y, z] }`.
 * A surface point is kept if, for any pose, it faces the camera and lands
 * inside a padded frame.
 */
export function createKeep(poses) {
  return (p) => {
    for (const { m, pos } of poses) {
      const dx = pos[0] - p[0]
      const dy = pos[1] - p[1]
      const dz = pos[2] - p[2]
      if (dx * p[0] + dy * p[1] + dz * p[2] <= 0) continue // beyond the horizon
      const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15]
      if (w <= 0) continue
      const x = (m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / w
      const y = (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / w
      if (Math.abs(x) < 1.12 && y > -1.15 && y < 1.05) return true
    }
    return false
  }
}

/** Typed arrays to hand back across a worker boundary without copying. */
export function transferablesOf(net) {
  return [...Object.values(net.nodes), ...Object.values(net.links)].map((a) => a.buffer)
}

/**
 * @param {object} o
 * @param {number} o.nodes      target node count
 * @param {number} o.metros     number of metro clusters
 * @param {number} o.maxTheta   angular radius (rad) of the cap below the camera to populate
 * @param {(p: number[]) => boolean} o.keep  true if a surface point can be on screen
 * @param {number} [o.seed]
 */
export function buildNetwork({ nodes: target, metros: metroTarget, maxTheta, keep, seed = 11 }) {
  const rand = seededRandom(seed)
  const gauss = () => {
    const u = Math.max(rand(), 1e-9)
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand())
  }
  const cosMax = Math.cos(maxTheta)
  const capPoint = (ct, phi) => {
    const st = Math.sqrt(Math.max(0, 1 - ct * ct))
    return [st * Math.cos(phi), ct, st * Math.sin(phi)]
  }

  // Coarse visibility map of the cap (θ × φ cells, dilated by one cell), so
  // sampling never wastes time on ground the camera can't see.
  const TH = 24
  const PH = 96
  const seen = new Uint8Array(TH * PH)
  for (let i = 0; i < TH; i++)
    for (let j = 0; j < PH; j++) {
      for (let s = 0; s < 5 && !seen[i * PH + j]; s++) {
        const u = s === 4 ? 0.5 : s & 1
        const v = s === 4 ? 0.5 : s >> 1
        const ct = 1 - ((i + u) / TH) * (1 - cosMax)
        if (keep(capPoint(ct, ((j + v) / PH) * Math.PI * 2))) seen[i * PH + j] = 1
      }
    }
  const cells = []
  for (let i = 0; i < TH; i++)
    for (let j = 0; j < PH; j++) {
      let hit = false
      for (let di = -1; di <= 1 && !hit; di++)
        for (let dj = -1; dj <= 1 && !hit; dj++) {
          const ii = i + di
          if (ii >= 0 && ii < TH && seen[ii * PH + ((j + dj + PH) % PH)]) hit = true
        }
      // Cells are equal-area (uniform in cos θ and φ), so pick them uniformly
      if (hit) cells.push({ i, j })
    }
  const randomCapPoint = () => {
    if (!cells.length) return capPoint(1 - rand() * (1 - cosMax), rand() * Math.PI * 2)
    const c = cells[Math.floor(rand() * cells.length)]
    const ct = 1 - ((c.i + rand()) / TH) * (1 - cosMax)
    return capPoint(ct, ((c.j + rand()) / PH) * Math.PI * 2)
  }
  const landAt = (p) => continents(p[0], p[1], p[2])
  const LAND = 0.5

  /* ---- metros ----------------------------------------------------------- */
  const metros = []
  for (let tries = 0; metros.length < metroTarget && tries < metroTarget * 400; tries++) {
    const p = randomCapPoint()
    if (landAt(p) < LAND + 0.02 || !keep(p)) continue
    if (metros.some((m) => dist3(m.p, p) < 0.012)) continue
    const weight = 0.25 + Math.pow(rand(), 2.2) * 1.75
    metros.push({ p, weight, sigma: 0.0035 + Math.pow(rand(), 1.5) * 0.009 * (0.6 + weight * 0.4), basis: tangentBasis(p) })
  }
  const totalWeight = metros.reduce((sum, m) => sum + m.weight, 0)
  const pickMetro = () => {
    let r = rand() * totalWeight
    for (const m of metros) if ((r -= m.weight) <= 0) return m
    return metros[metros.length - 1]
  }

  // Each metro's nearest neighbours (for corridors and long arcs)
  for (const m of metros) {
    m.near = metros
      .filter((o) => o !== m)
      .map((o) => ({ o, d: dist3(m.p, o.p) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 3)
  }

  /* ---- nodes -------------------------------------------------------------- */
  const nodes = [] // { p, bright, size, metro }
  // Poisson-disc style spacing: lights never pile up into blown-out blobs
  const occupied = createHash(0.0016)
  const spaced = (p, minD) => {
    const min2 = minD * minD
    return !occupied.near(p, 1, (q) => dist2(p, q) < min2)
  }
  const addNode = (p, bright, size, metro = null) => {
    nodes.push({ p, bright, size, metro })
    occupied.add(p, p)
  }

  const metroShare = Math.round(target * 0.62)
  const corridorShare = Math.round(target * 0.16)
  const ruralShare = target - metroShare - corridorShare

  for (let i = 0, tries = 0; i < metroShare && tries < metroShare * 6 && metros.length; tries++) {
    const m = pickMetro()
    // Heavy-tailed sprawl: dense cores, ragged suburbs
    const r = m.sigma * Math.pow(Math.abs(gauss()), 1.25) * 0.9
    const a = rand() * Math.PI * 2
    const [t1, t2] = m.basis
    const p = normalize([
      m.p[0] + t1[0] * Math.cos(a) * r + t2[0] * Math.sin(a) * r,
      m.p[1] + t1[1] * Math.cos(a) * r + t2[1] * Math.sin(a) * r,
      m.p[2] + t1[2] * Math.cos(a) * r + t2[2] * Math.sin(a) * r,
    ])
    const core = Math.exp(-((r / m.sigma) ** 2) * 1.4)
    if (!spaced(p, 0.00085 + (1 - core) * 0.0006) || landAt(p) < LAND - 0.01 || !keep(p)) continue
    addNode(p, 0.34 + 0.6 * core * Math.min(1, 0.45 + m.weight * 0.4), 0.0008 + core * 0.0007 * m.weight, m)
    i++
  }

  // Corridors: chains of lights following the great circle between metros
  for (let i = 0, tries = 0; i < corridorShare && tries < corridorShare * 6 && metros.length > 1; tries++) {
    const m = pickMetro()
    const link = m.near[Math.floor(rand() * Math.min(2, m.near.length))]
    if (!link || link.d > 0.09) continue
    const t = rand()
    const base = slerp(m.p, link.o.p, t)
    const [t1, t2] = m.basis
    const wob = Math.sin(t * Math.PI * (2 + (m.weight % 1) * 3)) * link.d * 0.06
    const j = 0.0011
    const p = normalize([
      base[0] + t1[0] * (gauss() * j + wob) + t2[0] * gauss() * j,
      base[1] + t1[1] * (gauss() * j + wob) + t2[1] * gauss() * j,
      base[2] + t1[2] * (gauss() * j + wob) + t2[2] * gauss() * j,
    ])
    if (!spaced(p, 0.0011) || landAt(p) < LAND - 0.03 || !keep(p)) continue
    addNode(p, 0.28 + rand() * 0.22, 0.0007 + rand() * 0.0003)
    i++
  }

  // Rural scatter, biased toward coastlines
  for (let i = 0, tries = 0; i < ruralShare && tries < ruralShare * 24; tries++) {
    const p = randomCapPoint()
    const land = landAt(p)
    if (land < LAND) continue
    const coast = Math.exp(-(((land - LAND) / 0.025) ** 2))
    if (rand() > 0.18 + coast * 0.82 || !spaced(p, 0.0015) || !keep(p)) continue
    addNode(p, 0.18 + rand() * 0.26, 0.0006 + rand() * 0.0003)
    i++
  }

  /* ---- synapses: k-nearest links via a spatial hash ------------------------ */
  // Small cells first (dense metros); widen the search only for sparse nodes.
  const LINK_MAX = 0.0105
  const fine = createHash(LINK_MAX / 3)
  const coarse = createHash(LINK_MAX)
  nodes.forEach((n, i) => {
    fine.add(n.p, i)
    coarse.add(n.p, i)
  })

  const edges = new Set()
  const adjacency = nodes.map(() => [])
  const bestJ = [-1, -1, -1]
  const bestD = [0, 0, 0]
  nodes.forEach((n, i) => {
    const k = rand() < 0.35 ? 3 : 2
    let found = 0
    const consider = (j) => {
      if (j === i) return false
      const d = dist2(n.p, nodes[j].p)
      if (d >= LINK_MAX * LINK_MAX) return false
      // insertion into a tiny sorted top-k
      let slot = Math.min(found, k)
      while (slot > 0 && bestD[slot - 1] > d) {
        if (slot < k) {
          bestD[slot] = bestD[slot - 1]
          bestJ[slot] = bestJ[slot - 1]
        }
        slot--
      }
      if (slot < k) {
        bestD[slot] = d
        bestJ[slot] = j
        if (found < k) found++
      }
      return false
    }
    fine.near(n.p, 1, consider)
    if (found < k) {
      found = 0
      coarse.near(n.p, 1, consider)
    }
    for (let c = 0; c < found; c++) {
      const j = bestJ[c]
      const id = i < j ? i * 1e6 + j : j * 1e6 + i
      if (edges.has(id)) continue
      edges.add(id)
      adjacency[i].push(j)
      adjacency[j].push(i)
    }
  })

  /* ---- intro cascade: hop distance from the brightest metro --------------- */
  const delays = new Float32Array(nodes.length).fill(-1)
  let seedIndex = 0
  nodes.forEach((n, i) => {
    if (n.bright > nodes[seedIndex].bright) seedIndex = i
  })
  // Multi-source BFS: each metro's densest node ignites, staggered by distance
  const queue = []
  if (nodes.length) {
    delays[seedIndex] = 0
    queue.push(seedIndex)
  }
  const hop = new Int32Array(nodes.length).fill(-1)
  if (nodes.length) hop[seedIndex] = 0
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q]
    for (const j of adjacency[i]) {
      if (hop[j] !== -1) continue
      hop[j] = hop[i] + 1
      queue.push(j)
    }
  }
  let maxHop = 1
  for (const h of hop) if (h > maxHop) maxHop = h
  // Disconnected islands light up from their own spot, keyed to distance from the seed
  const seedP = nodes[seedIndex]?.p ?? [0, 1, 0]
  nodes.forEach((n, i) => {
    delays[i] =
      hop[i] >= 0
        ? (hop[i] / maxHop) * 0.85 + rand() * 0.04
        : Math.min(0.95, (dist3(n.p, seedP) / (maxTheta * 1.2)) * 0.9 + rand() * 0.08)
  })

  /* ---- long arcs between metros ------------------------------------------- */
  const arcs = []
  const arcSet = new Set()
  metros.forEach((m, mi) => {
    const count = m.weight > 1 ? 2 : 1
    for (const { o, d } of m.near.slice(0, count)) {
      const oi = metros.indexOf(o)
      const id = Math.min(mi, oi) * 1000 + Math.max(mi, oi)
      if (arcSet.has(id) || d < 0.016 || d > 0.11) continue
      arcSet.add(id)
      arcs.push({ a: m, b: o, d })
    }
  })
  // Each metro's delay = the earliest node delay within it
  const metroDelay = new Map()
  nodes.forEach((n, i) => {
    if (!n.metro) return
    const prev = metroDelay.get(n.metro)
    if (prev === undefined || delays[i] < prev) metroDelay.set(n.metro, delays[i])
  })

  /* ---- pack buffers --------------------------------------------------------- */
  const pointCount = nodes.length + metros.length
  const nodeBuf = {
    position: new Float32Array(pointCount * 3),
    size: new Float32Array(pointCount),
    bright: new Float32Array(pointCount),
    seed: new Float32Array(pointCount),
    delay: new Float32Array(pointCount),
    halo: new Float32Array(pointCount),
  }
  let o = 0
  // Light-pollution halos under each metro (drawn as huge, faint sprites)
  metros.forEach((m) => {
    const lift = 1.0004
    nodeBuf.position.set([m.p[0] * lift, m.p[1] * lift, m.p[2] * lift], o * 3)
    nodeBuf.size[o] = m.sigma * 4.2
    nodeBuf.bright[o] = 0.05 + 0.07 * m.weight
    nodeBuf.seed[o] = rand()
    nodeBuf.delay[o] = (metroDelay.get(m) ?? 0.5) + 0.05
    nodeBuf.halo[o] = 1
    o++
  })
  nodes.forEach((n, i) => {
    const lift = 1.0006
    nodeBuf.position.set([n.p[0] * lift, n.p[1] * lift, n.p[2] * lift], o * 3)
    nodeBuf.size[o] = n.size
    nodeBuf.bright[o] = n.bright
    nodeBuf.seed[o] = rand()
    nodeBuf.delay[o] = delays[i]
    nodeBuf.halo[o] = 0
    o++
  })

  const ARC_SEGMENTS = 32
  const segCount = edges.size + arcs.length * ARC_SEGMENTS
  const linkBuf = {
    position: new Float32Array(segCount * 2 * 3),
    t: new Float32Array(segCount * 2),
    seed: new Float32Array(segCount * 2),
    kind: new Float32Array(segCount * 2),
    delay: new Float32Array(segCount * 2),
  }
  let v = 0
  const pushVertex = (p, t, s, kind, delay) => {
    linkBuf.position.set(p, v * 3)
    linkBuf.t[v] = t
    linkBuf.seed[v] = s
    linkBuf.kind[v] = kind
    linkBuf.delay[v] = delay
    v++
  }
  for (const id of edges) {
    const i = Math.floor(id / 1e6)
    const j = id % 1e6
    const s = rand()
    const delay = Math.max(delays[i], delays[j])
    const lift = 1.0006
    pushVertex(nodes[i].p.map((c) => c * lift), 0, s, 0, delay)
    pushVertex(nodes[j].p.map((c) => c * lift), 1, s, 0, delay)
  }
  for (const { a, b, d } of arcs) {
    const s = rand()
    const height = Math.min(d * 0.07, 0.0035)
    const delay = Math.min(0.98, Math.max(metroDelay.get(a) ?? 0.5, metroDelay.get(b) ?? 0.5) + 0.08)
    let prev = null
    for (let k = 0; k <= ARC_SEGMENTS; k++) {
      const t = k / ARC_SEGMENTS
      const dir = normalize(slerp(a.p, b.p, t))
      const r = 1.0006 + height * Math.sin(Math.PI * t)
      const p = [dir[0] * r, dir[1] * r, dir[2] * r]
      if (prev) {
        pushVertex(prev.p, prev.t, s, 1, delay)
        pushVertex(p, t, s, 1, delay)
      }
      prev = { p, t }
    }
  }

  return { nodes: nodeBuf, pointCount, links: linkBuf, vertexCount: v }
}
