/**
 * SYS-01 · REASONING — a launch cone of candidate trajectories that is
 * explored, scored, pruned, and committed to a single optimal path.
 *
 * The search tree is laid out in "polar" space: depth is range from T−0,
 * each branch has a bearing, so the explored tree opens like a dispersion
 * cone and its leaves land on an arc (the rim). Every edge leaves its parent
 * along the parent's bearing and bends onto the child's — a family of
 * trajectories rather than a flowchart.
 *
 * Cycle: grow (depth by depth) → evaluate (a scan front sweeps out from T−0
 * and scores each leaf with a value tick) → prune (dead branches fade back,
 * leaves first) → converge (the optimal path lights up, packets flow to a
 * target lock beyond the rim) → dissolve → re-seed.
 * With a pointer over the tile the target follows the pointer's bearing and
 * the committed path re-routes live.
 */
import { seededRandom, pad } from '../../../lib/dom.js'
import { byTier } from '../../../lib/quality.js'
import { glowSprite, drawGlow, label, easeOut, easeInOut, approach, sat, rectBatch, NO_DASH, hypot } from './core.js'

const GROW_STEP = 0.32 // seconds between depth levels
const GROW_DUR = 0.66 // seconds for one edge to draw
const EVAL_DUR = 1.5
const PRUNE_DUR = 1.5
const HOLD = 5.2
const FADE = 0.9
const RIM_U = 1.1 // where the target sits, just outside the rim
const EDGE_LEVELS = 40 // alpha quantisation of the explored edges
const RING_DASH = [1, 4]
const RIM_DASH = [2, 6]
const APPROACH_DASH = [2, 4]
const LOCK_DASH = [3, 5]

export function createReasoning({ pal, seed = 1 }) {
  const depthMax = byTier({ high: 6, medium: 6, low: 5 })
  const maxNodes = byTier({ high: 220, medium: 180, low: 110 })

  const T_GROW = (depthMax - 1) * GROW_STEP + GROW_DUR
  const T_EVAL = T_GROW + 0.1
  const T_PRUNE = T_EVAL + EVAL_DUR
  const T_COMMIT = T_PRUNE + 0.55
  const T_FADE = T_COMMIT + HOLD
  const T_END = T_FADE + FADE
  const T_STATIC = T_PRUNE + (depthMax - 1) * 0.13 + 0.6

  const glowIon = glowSprite(pal.ion)
  const glowAtmo = glowSprite(pal.atmo)
  const dots = rectBatch()
  const depthLabels = Array.from({ length: depthMax }, (_, i) => `D${i + 1}`)
  // Per-frame scratch, allocated once: explored edges bucketed by quantised
  // alpha (a count marks each bucket's live part) and still-growing edges.
  const edgeBuckets = Array.from({ length: EDGE_LEVELS + 1 }, () => [])
  const edgeCounts = new Uint32Array(EDGE_LEVELS + 1)
  const partialNodes = []
  const partialGrow = new Float64Array(maxNodes)
  const partialAlpha = new Float64Array(maxNodes)
  // An edge's growth and prune fade depend only on its depth: worked out per level.
  const levelGrow = new Float64Array(depthMax + 1)
  const levelAlpha = new Float64Array(depthMax + 1)
  // Once pruning is complete the explored tree is static: cache it as a bitmap.
  let cache = null
  let cacheValid = false

  let nodes = []
  let leaves = []
  let path = [] // root → optimal leaf
  let cycle = 0
  let c = 0 // cycle clock
  let goal = 0 // goal bearing (rad, smoothed)
  let goalHome = 0
  let lock = 0 // 0..1 target lock
  let solvedFor = NaN // the goal solve() last ran for
  // Fan geometry (CSS px): origin, range at bearing 0, half-height, max bearing
  const fan = { x0: 0, y0: 0, L: 1, H: 1, phiMax: 1, sinMax: 1 }
  let laidOut = false // node positions + the static strokes below are valid for this tree + fan
  let rings = null // Path2D: the dotted range rings
  let rim = null // Path2D: the rim
  let layoutStamp = 0
  // Leaf value ticks + dots (Path2D), and what they were traced for
  const scores = { low: null, high: null, dots: null, scan: NaN, goal: NaN, best: null, stamp: -1 }
  const tmp = [0, 0] // scratch points (out-params)
  const pt = [0, 0]
  let lockBearing = NaN
  let lockText = ''

  const api = {
    status: 'Exploring',
    tone: '',
    resize,
    step,
    draw,
    trigger,
    settle,
    readout,
  }

  build()
  return api

  /* ---- Tree ------------------------------------------------------------------ */
  function build() {
    // A few attempts so every cycle opens a properly wide cone.
    for (let attempt = 0; attempt < 6; attempt++) {
      grow(seededRandom(seed * 7919 + cycle * 104729 + attempt * 7))
      if (leaves.filter((l) => l.d === depthMax).length >= 22) break
    }
    path = []
    cacheValid = false
    laidOut = false
    solvedFor = NaN
    solve()
  }

  function grow(rand) {
    nodes = []
    leaves = []
    const root = makeNode(null, 0)
    const queue = [root]
    while (queue.length) {
      const n = queue.shift()
      if (n.d >= depthMax) continue
      if (n.d >= 2 && rand() < 0.15) continue // dead end
      // Wide early, then mostly continuing trajectories with the odd fork.
      const k = n.d === 0 ? 3 : n.d === 1 ? (rand() < 0.5 ? 3 : 2) : n.d === 2 ? 2 : rand() < 0.56 ? 2 : 1
      for (let i = 0; i < k && nodes.length < maxNodes; i++) {
        const child = makeNode(n, n.d + 1)
        child.noise = rand()
        queue.push(child)
      }
    }

    // Leaves take evenly spaced bearings in depth-first order; each branch
    // point sits on the mean bearing of its children (with a little jitter).
    const order = []
    const visit = (n) => {
      if (!n.kids.length) order.push(n)
      for (const kid of n.kids) visit(kid)
    }
    visit(root)
    order.forEach((leaf, i) => (leaf.b = ((i + 0.5) / order.length) * 2 - 1))
    const place = (n) => {
      if (!n.kids.length) return n.b
      let sum = 0
      for (const kid of n.kids) sum += place(kid)
      n.b = sum / n.kids.length + (n.parent ? (rand() - 0.5) * 0.03 : 0)
      return n.b
    }
    place(root)
    root.b = 0
    // Range: a gentle power curve opens up the inner levels.
    for (const n of nodes) n.u = Math.pow(n.d / depthMax, 0.86) + (n.d ? (rand() - 0.5) * 0.012 : 0)

    for (const n of nodes) if (!n.kids.length && n.parent) leaves.push(n)
    goalHome = (rand() - 0.5) * 1.1
    goal = goalHome
  }

  function makeNode(parent, d) {
    const n = { parent, d, u: 0, b: 0, kids: [], on: 0, onPath: false, noise: 0, score: 0, sx: 0, sy: 0, dx: 1, dy: 0, edge: null }
    if (parent) parent.kids.push(n)
    nodes.push(n)
    return n
  }

  /** Optimal leaf = deepest leaf whose bearing is closest to the goal. */
  function solve() {
    if (goal === solvedFor) return // same tree, same goal: same scores and path
    solvedFor = goal
    let best = null
    let bestCost = Infinity
    for (let i = 0; i < leaves.length; i++) {
      const leaf = leaves[i]
      const off = Math.abs(leaf.b - goal)
      leaf.score = sat(1 - off * 1.15 - leaf.noise * 0.12) * (leaf.d < depthMax ? 0.35 : 1)
      const cost = off + (leaf.d < depthMax ? 2 : 0) + leaf.noise * 0.02
      if (cost < bestCost) {
        bestCost = cost
        best = leaf
      }
    }
    if (path.length && path[path.length - 1] === best) return
    for (let i = 0; i < path.length; i++) path[i].onPath = false
    path = []
    for (let n = best; n; n = n.parent) {
      n.onPath = true
      path.unshift(n)
    }
  }

  /* ---- Layout ----------------------------------------------------------------- */
  function resize(s) {
    const wide = s.w / s.h > 1.1
    fan.x0 = s.w * (wide ? 0.075 : 0.1)
    fan.y0 = s.band.mid + (wide ? 4 : 0)
    fan.L = s.w * (wide ? 0.74 : 0.7)
    fan.H = Math.max(40, s.band.h * (wide ? 0.385 : 0.37))
    fan.phiMax = wide ? 1.02 : 0.96
    fan.sinMax = Math.sin(fan.phiMax)
    cacheValid = false
    laidOut = false
  }

  /** Screen position for range u (0 = T−0, 1 = rim) and normalised bearing b (−1..1). */
  function toScreen(u, b, out) {
    const phi = b * fan.phiMax
    out[0] = fan.x0 + u * fan.L * Math.cos(phi)
    out[1] = fan.y0 + (u * fan.H * Math.sin(phi)) / fan.sinMax
    return out
  }

  /** Unit direction of the ray at bearing b. */
  function rayDir(b, out) {
    const phi = b * fan.phiMax
    const x = fan.L * Math.cos(phi)
    const y = (fan.H * Math.sin(phi)) / fan.sinMax
    const d = hypot(x, y) || 1
    out[0] = x / d
    out[1] = y / d
    return out
  }

  /** Bearing (−1..1) of a screen point, seen from T−0. */
  function bearingOf(x, y) {
    const phi = Math.atan2(((y - fan.y0) / fan.H) * fan.sinMax, (x - fan.x0) / fan.L)
    return Math.max(-1, Math.min(1, phi / fan.phiMax))
  }

  /**
   * Screen positions + ray directions, and the strokes that only change with
   * them (each edge, the range rings, the rim) traced once into Path2Ds: a
   * frame then strokes them instead of re-issuing every segment.
   */
  function layout() {
    if (laidOut) return
    laidOut = true
    layoutStamp++
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]
      toScreen(n.u, n.b, tmp)
      n.sx = tmp[0]
      n.sy = tmp[1]
      rayDir(n.b, tmp)
      n.dx = tmp[0]
      n.dy = tmp[1]
    }
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]
      if (!n.parent) continue
      n.edge = new Path2D()
      edgePath(n.edge, n.parent, n)
    }
    rings = new Path2D()
    for (let d = 1; d <= depthMax; d++) arcPath(rings, Math.pow(d / depthMax, 0.86), 1.06)
    rim = new Path2D()
    arcPath(rim, RIM_U, 1.04)
  }

  /* ---- Simulation --------------------------------------------------------------- */
  function step(dt, s) {
    c += dt * (1 + s.energy * 0.25)
    if (c >= T_END) {
      cycle++
      c = 0
      build()
    }

    // Goal follows the pointer's bearing, or rests at home.
    const target = s.pointer ? bearingOf(s.mx, s.my) : goalHome
    goal += (target - goal) * approach(s.pointer ? 6 : 2, dt)
    solve()

    const committing = c >= T_COMMIT && c < T_FADE + FADE
    const k = approach(7, dt)
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]
      const target = committing && n.onPath ? 1 : 0
      if (n.on !== target) n.on += (target - n.on) * k // (at its target, the step is a no-op)
    }
    lock += ((committing ? 1 : 0) - lock) * approach(4, dt)

    api.status = c < T_GROW ? 'Exploring' : c < T_PRUNE ? 'Evaluating' : c < T_COMMIT ? 'Pruning' : s.pointer ? 'Re-planning' : 'Converged'
  }

  function settle() {
    // A resolved still: full tree, pruned, path committed.
    c = T_COMMIT + 1.6
    goal = goalHome
    solve()
    for (let i = 0; i < nodes.length; i++) nodes[i].on = nodes[i].onPath ? 1 : 0
    lock = 1
    api.status = 'Converged'
  }

  function trigger() {
    cycle++
    c = 0
    lock = 0
    build()
  }

  function readout() {
    const scored = c < T_EVAL ? 0 : c < T_PRUNE ? Math.round(leaves.length * sat((c - T_EVAL) / EVAL_DUR)) : leaves.length
    const prunedFrac = 1 - path.length / Math.max(1, nodes.length)
    const pruned = c < T_PRUNE ? 0 : prunedFrac * 100 * easeInOut((c - T_PRUNE) / PRUNE_DUR)
    return `Paths ${pad(scored, 4)} · Pruned ${pruned.toFixed(1)}%`
  }

  /* ---- Drawing ----------------------------------------------------------------------- */
  function draw(ctx, s) {
    const boot = s.boot
    if (boot <= 0) return
    const fade = c > T_FADE ? 1 - easeInOut((c - T_FADE) / FADE) : 1
    const e = s.energy
    const alpha = boot * fade

    layout()
    drawGuides(ctx, boot, e)

    if (c >= T_STATIC) {
      // Static explored tree (all edges pruned to the same alpha) from cache.
      if (!cacheValid) renderCache(ctx)
      ctx.globalAlpha = alpha * (0.09 + e * 0.05)
      ctx.drawImage(cache, 0, 0, s.w, s.h)
    } else {
      drawExplored(ctx, alpha, e)
    }

    drawScores(ctx, alpha)

    // Branch points near the root
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]
      if (!n.parent || n.d > 3 || !n.kids.length || c < (n.d - 1) * GROW_STEP + GROW_DUR) continue
      dots.dot(n.sx, n.sy, 2, alpha * (0.6 - n.d * 0.1))
    }
    dots.flush(ctx, pal.text.rgb)

    drawPath(ctx, s, alpha)
    drawRoot(ctx, alpha)
    drawTarget(ctx, alpha)
  }

  /** Range of the evaluation front (−1 before evaluation starts). */
  function scanRange() {
    return c < T_EVAL ? -1 : 0.04 + 1.02 * easeInOut((c - T_EVAL) / EVAL_DUR)
  }

  function edgePath(g, p, n) {
    const k = hypot(n.sx - p.sx, n.sy - p.sy) * 0.42
    g.moveTo(p.sx, p.sy)
    g.bezierCurveTo(p.sx + p.dx * k, p.sy + p.dy * k, n.sx - n.dx * k, n.sy - n.dy * k, n.sx, n.sy)
  }

  function renderCache(ctx) {
    const { width, height } = ctx.canvas
    if (!cache) cache = document.createElement('canvas')
    if (cache.width !== width || cache.height !== height) {
      cache.width = width
      cache.height = height
    }
    const g = cache.getContext('2d')
    g.setTransform(ctx.getTransform())
    g.clearRect(0, 0, width, height)
    g.strokeStyle = pal.atmo.rgb
    g.lineWidth = 1
    g.beginPath()
    for (let i = 0; i < nodes.length; i++) if (nodes[i].parent) edgePath(g, nodes[i].parent, nodes[i])
    g.stroke()
    cacheValid = true
  }

  function drawExplored(ctx, alpha, e) {
    // Explored edges, batched by quantised alpha.
    let partials = 0
    const scan = scanRange()
    for (let d = 1; d <= depthMax; d++) {
      levelGrow[d] = easeOut((c - (d - 1) * GROW_STEP) / GROW_DUR)
      const prune = easeInOut((c - T_PRUNE - (depthMax - d) * 0.13) / 0.55)
      levelAlpha[d] = (0.4 + e * 0.2) * (1 - prune) + (0.09 + e * 0.05) * prune
    }
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]
      if (!n.parent) continue
      const grow = levelGrow[n.d]
      if (grow <= 0) continue
      let a = levelAlpha[n.d]
      // A brief wake just inside the evaluation front.
      if (scan > 0 && c < T_PRUNE) {
        const du = scan - n.u
        if (du > 0 && du < 0.16) a += 0.36 * (1 - du / 0.16)
      }
      a *= alpha
      if (grow < 1) {
        partialNodes[partials] = n
        partialGrow[partials] = grow
        partialAlpha[partials] = a
        partials++
        continue
      }
      let key = Math.round(a * EDGE_LEVELS)
      if (key <= 0) continue
      if (key > EDGE_LEVELS) key = EDGE_LEVELS
      edgeBuckets[key][edgeCounts[key]++] = n
    }

    ctx.lineWidth = 1
    ctx.strokeStyle = pal.atmo.rgb
    for (let key = 1; key <= EDGE_LEVELS; key++) {
      const count = edgeCounts[key]
      if (!count) continue
      const list = edgeBuckets[key]
      const bucket = new Path2D()
      for (let i = 0; i < count; i++) bucket.addPath(list[i].edge)
      ctx.globalAlpha = key / EDGE_LEVELS
      ctx.stroke(bucket)
      edgeCounts[key] = 0
    }
    for (let i = 0; i < partials; i++) {
      const n = partialNodes[i]
      ctx.globalAlpha = partialAlpha[i]
      ctx.beginPath()
      partialEdge(ctx, n.parent, n, partialGrow[i], pt)
      ctx.stroke()
      // Bright growth tip
      dots.dot(pt[0], pt[1], 1.6, alpha * 0.95)
    }
    dots.flush(ctx, pal.ion.rgb)

    // Evaluation front: an arc of constant range sweeping outwards
    if (scan > 0 && c < T_PRUNE + 0.25) {
      const a = alpha * (1 - easeInOut((c - T_PRUNE) / 0.25)) * Math.min(1, (c - T_EVAL) / 0.25)
      const front = new Path2D() // traced once, stroked twice (glow, then core)
      arcPath(front, scan, 1.1)
      ctx.globalCompositeOperation = 'lighter'
      ctx.strokeStyle = pal.atmo.rgb
      ctx.lineWidth = 9
      ctx.globalAlpha = a * 0.07
      ctx.stroke(front)
      ctx.lineWidth = 1
      ctx.globalAlpha = a * 0.75
      ctx.strokeStyle = pal.ion.rgb
      ctx.stroke(front)
      ctx.globalCompositeOperation = 'source-over'
    }
  }

  /** Traces the arc of constant range u across bearings ±span (as its own subpath). */
  function arcPath(g, u, span) {
    const steps = 36
    for (let i = 0; i <= steps; i++) {
      toScreen(u, -span + (2 * span * i) / steps, tmp)
      if (i) g.lineTo(tmp[0], tmp[1])
      else g.moveTo(tmp[0], tmp[1])
    }
  }

  /** Leaf value ticks: drawn as the evaluation front passes, faded by pruning. */
  function drawScores(ctx, alpha) {
    if (c < T_EVAL) return
    const scan = scanRange()
    const prune = easeInOut((c - T_PRUNE) / 0.9)
    const best = path[path.length - 1]
    // The ticks only change while the front sweeps or the goal moves: retrace them then.
    if (scan !== scores.scan || goal !== scores.goal || best !== scores.best || layoutStamp !== scores.stamp) {
      scores.scan = scan
      scores.goal = goal
      scores.best = best
      scores.stamp = layoutStamp
      scores.low = new Path2D()
      scores.high = new Path2D()
      scores.dots = new Path2D()
      for (let i = 0; i < leaves.length; i++) {
        const leaf = leaves[i]
        if (leaf.u > scan) continue
        scores.dots.rect(leaf.sx - 0.8, leaf.sy - 0.8, 1.6, 1.6)
        if (leaf === best) continue
        const g = leaf.score > 0.72 ? scores.high : scores.low
        const len = 2 + leaf.score * 11
        g.moveTo(leaf.sx + leaf.dx * 3, leaf.sy + leaf.dy * 3)
        g.lineTo(leaf.sx + leaf.dx * (3 + len), leaf.sy + leaf.dy * (3 + len))
      }
    }
    ctx.lineWidth = 1
    ctx.strokeStyle = pal.atmo.rgb
    ctx.globalAlpha = alpha * 0.55 * (1 - prune * 0.88)
    ctx.stroke(scores.low)
    ctx.strokeStyle = pal.ion.rgb
    ctx.globalAlpha = alpha * 0.95 * (1 - prune * 0.88)
    ctx.stroke(scores.high)
    // Leaf dots: one alpha for all, quantised like rectBatch's.
    const a = alpha * (0.75 - prune * 0.45)
    if (a > 0.01) {
      ctx.fillStyle = pal.atmo.rgb
      ctx.globalAlpha = Math.min(16, Math.max(1, Math.round(a * 16))) / 16
      ctx.fill(scores.dots)
    }
  }

  function drawGuides(ctx, boot, e) {
    // Range rings (D1…Dn) as dotted arcs, labelled at their upper end.
    ctx.strokeStyle = pal.text.rgb
    ctx.lineWidth = 1
    ctx.globalAlpha = (0.13 + e * 0.04) * boot
    ctx.setLineDash(RING_DASH) // restarts on each ring (each is its own subpath)
    ctx.stroke(rings)
    ctx.setLineDash(NO_DASH)
    for (let d = 1; d <= depthMax; d++) {
      const u = Math.pow(d / depthMax, 0.86)
      toScreen(u, -1.13, tmp)
      label(ctx, depthLabels[d - 1], tmp[0], tmp[1] - 2, { alpha: 0.45 * boot, align: 'center', size: 8.5 })
    }
    // The rim: where candidate trajectories are scored.
    ctx.globalAlpha = (0.2 + e * 0.06) * boot
    ctx.strokeStyle = pal.atmo.rgb
    ctx.setLineDash(RIM_DASH)
    ctx.stroke(rim)
    ctx.setLineDash(NO_DASH)
  }

  function drawPath(ctx, s, alpha) {
    if (path.length < 2) return
    // Glow underlay + crisp core line, per edge so a re-route cross-fades.
    ctx.lineCap = 'round'
    for (let pass = 0; pass < 2; pass++) {
      ctx.lineWidth = pass ? 1.6 : 7
      ctx.strokeStyle = pass ? pal.text.rgb : pal.atmo.rgb
      ctx.globalCompositeOperation = pass ? 'source-over' : 'lighter'
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i]
        if (!n.parent || n.on < 0.01) continue
        ctx.globalAlpha = alpha * n.on * (pass ? 0.95 : 0.16 + s.energy * 0.1)
        ctx.stroke(n.edge)
      }
    }
    ctx.globalCompositeOperation = 'source-over'
    ctx.lineCap = 'butt'

    // Path waypoints
    for (let i = 0; i < path.length; i++) {
      const n = path[i]
      if (n.parent && n.on > 0.05) dots.dot(n.sx, n.sy, 3, alpha * n.on)
    }
    dots.flush(ctx, pal.text.rgb)

    // Packets streaming root → target
    if (lock > 0.05) {
      const segs = path.length - 1
      const speed = 2.4 + s.energy * 2
      for (let i = 0; i < 3; i++) {
        let u = ((c * speed) / segs + i / 3) % 1
        u *= segs
        const si = Math.min(segs - 1, Math.floor(u))
        edgePoint(path[si], path[si + 1], u - si, pt)
        drawGlow(ctx, glowIon, pt[0], pt[1], 13, alpha * lock * 0.75)
        ctx.globalAlpha = alpha * lock
        ctx.fillStyle = pal.text.rgb
        ctx.fillRect(pt[0] - 1.25, pt[1] - 1.25, 2.5, 2.5)
      }
    }
  }

  function drawRoot(ctx, alpha) {
    const root = nodes[0]
    ctx.globalAlpha = alpha
    ctx.fillStyle = pal.text.rgb
    ctx.beginPath()
    ctx.arc(root.sx, root.sy, 2.6, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = pal.text.rgb
    ctx.lineWidth = 1
    ctx.globalAlpha = alpha * 0.45
    ctx.beginPath()
    ctx.arc(root.sx, root.sy, 8, 0, Math.PI * 2)
    ctx.stroke()
    drawGlow(ctx, glowAtmo, root.sx, root.sy, 30, alpha * 0.55)
    label(ctx, 'T−0', root.sx, root.sy - 19, { alpha: alpha * 0.65, align: 'center', size: 8.5 })
  }

  function drawTarget(ctx, alpha) {
    const leaf = path[path.length - 1]
    toScreen(RIM_U, goal, tmp)
    const x = tmp[0]
    const y = tmp[1]
    const a = alpha * (0.55 + lock * 0.45)
    // Final approach: optimal leaf → target
    if (leaf && lock > 0.02) {
      ctx.globalAlpha = alpha * lock * 0.75
      ctx.strokeStyle = pal.text.rgb
      ctx.lineWidth = 1
      ctx.setLineDash(APPROACH_DASH)
      ctx.beginPath()
      ctx.moveTo(leaf.sx + leaf.dx * 4, leaf.sy + leaf.dy * 4)
      const d = hypot(x - leaf.sx, y - leaf.sy) || 1
      ctx.lineTo(x - ((x - leaf.sx) / d) * 13, y - ((y - leaf.sy) / d) * 13)
      ctx.stroke()
      ctx.setLineDash(NO_DASH)
    }
    const r = 9 - lock * 1.5
    ctx.strokeStyle = lock > 0.5 ? pal.text.rgb : pal.atmo.rgb
    ctx.lineWidth = 1
    ctx.globalAlpha = a
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.moveTo(x - r - 7, y)
    ctx.lineTo(x - r - 2, y)
    ctx.moveTo(x + r + 2, y)
    ctx.lineTo(x + r + 7, y)
    ctx.moveTo(x, y - r - 7)
    ctx.lineTo(x, y - r - 2)
    ctx.moveTo(x, y + r + 2)
    ctx.lineTo(x, y + r + 7)
    ctx.stroke()
    if (lock > 0.02) {
      // Rotating lock ring
      ctx.globalAlpha = alpha * lock * 0.7
      ctx.setLineDash(LOCK_DASH)
      ctx.lineDashOffset = -c * 12
      ctx.beginPath()
      ctx.arc(x, y, 17, 0, Math.PI * 2)
      ctx.stroke()
      ctx.setLineDash(NO_DASH)
      ctx.lineDashOffset = 0
      drawGlow(ctx, glowAtmo, x, y, 34, alpha * lock * 0.6)
      ctx.globalAlpha = alpha * lock
      ctx.fillStyle = pal.text.rgb
      ctx.fillRect(x - 1.5, y - 1.5, 3, 3)
    }
    const bearing = Math.round(goal * fan.phiMax * (180 / Math.PI))
    if (bearing !== lockBearing) {
      lockBearing = bearing
      lockText = `LOCK ${bearing >= 0 ? '+' : '−'}${pad(Math.abs(bearing), 2)}°`
    }
    const text = lock > 0.5 ? lockText : 'TGT'
    label(ctx, text, x, y - 29, { alpha: a * 0.85, align: 'center', size: 8.5 })
  }

  /* ---- Edge geometry: a cubic that leaves along the parent's ray -------------- */
  function edgePoint(p, n, u, out) {
    const k = hypot(n.sx - p.sx, n.sy - p.sy) * 0.42
    const x1 = p.sx + p.dx * k
    const y1 = p.sy + p.dy * k
    const x2 = n.sx - n.dx * k
    const y2 = n.sy - n.dy * k
    const iu = 1 - u
    const b0 = iu * iu * iu
    const b1 = 3 * iu * iu * u
    const b2 = 3 * iu * u * u
    const b3 = u * u * u
    out[0] = b0 * p.sx + b1 * x1 + b2 * x2 + b3 * n.sx
    out[1] = b0 * p.sy + b1 * y1 + b2 * y2 + b3 * n.sy
    return out
  }

  /**
   * Traces the first `grow` (0..1) of edge p → n: the matching piece of its
   * cubic, split with de Casteljau, so a growing edge is the same curve it
   * completes as. Its tip goes to `tip`.
   */
  function partialEdge(ctx, p, n, grow, tip) {
    const k = hypot(n.sx - p.sx, n.sy - p.sy) * 0.42
    const x1 = p.sx + p.dx * k
    const y1 = p.sy + p.dy * k
    const x2 = n.sx - n.dx * k
    const y2 = n.sy - n.dy * k
    const ax = p.sx + (x1 - p.sx) * grow
    const ay = p.sy + (y1 - p.sy) * grow
    const bx = x1 + (x2 - x1) * grow
    const by = y1 + (y2 - y1) * grow
    const cx = x2 + (n.sx - x2) * grow
    const cy = y2 + (n.sy - y2) * grow
    const abx = ax + (bx - ax) * grow
    const aby = ay + (by - ay) * grow
    const bcx = bx + (cx - bx) * grow
    const bcy = by + (cy - by) * grow
    tip[0] = abx + (bcx - abx) * grow
    tip[1] = aby + (bcy - aby) * grow
    ctx.moveTo(p.sx, p.sy)
    ctx.bezierCurveTo(ax, ay, abx, aby, tip[0], tip[1])
  }
}
