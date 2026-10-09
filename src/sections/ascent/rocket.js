/**
 * The SXSI launch vehicle — an original two-stage design.
 *
 * Slender white body, swept black fins, a black interstage band with a single
 * atmospheric-blue pinstripe, a stacked S·X·S·I mark, and a hammerhead fairing
 * that tapers into a long ogive with a black needle tip. Inside the fairing
 * rides the payload: a sphere of linked nodes — a network of light.
 *
 * Units: 1 = ~6 m. y = 0 is the bottom of the first-stage skirt.
 */
import * as THREE from 'three'
import { seededRandom } from '../../lib/dom.js'
import { NODE_VERT, NODE_FRAG, EDGE_VERT, EDGE_FRAG, RING_VERT, RING_FRAG } from './shaders.js'

export const DIM = {
  R: 0.42,
  stage1Top: 5.6,
  interTop: 6.3,
  stage2Bottom: 6.32,
  stage2Top: 8.55,
  fairingR: 0.47,
  shoulder: 9.4,
  noseTip: 10.9,
  needleTip: 11.4,
  payloadY: 9.08,
  hullY: 7.45,
  nozzle1Exit: -0.36,
  nozzle2Exit: 5.68,
  nozzle2R: 0.32,
}

// ---------------------------------------------------------------------------
// Geometry helpers

/** LatheGeometry from [radius, y] pairs. phiStart = −π puts u = 0.5 facing the camera (+z). */
function lathe(points, { segments = 72, phiStart = -Math.PI, phiLength = Math.PI * 2, uvY } = {}) {
  const geo = new THREE.LatheGeometry(
    points.map(([r, y]) => new THREE.Vector2(Math.max(r, 0.0001), y)),
    segments,
    phiStart,
    phiLength,
  )
  if (uvY) {
    // Re-map v to true height so painted markings keep their proportions.
    const pos = geo.attributes.position
    const uv = geo.attributes.uv
    for (let i = 0; i < uv.count; i++) uv.setY(i, (pos.getY(i) - uvY[0]) / (uvY[1] - uvY[0]))
  }
  return geo
}

/** Tangent ogive nose profile from radius R over length L, starting at y0. */
function ogive(R, L, y0, steps = 22) {
  const rho = (R * R + L * L) / (2 * R)
  const pts = []
  for (let i = 1; i <= steps; i++) {
    const x = (i / steps) * L
    const r = Math.sqrt(rho * rho - x * x) + R - rho
    pts.push([Math.max(r, 0.0001), y0 + x])
  }
  return pts
}

function canvasTexture(width, height, paint) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  paint(ctx, width, height)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  return {
    tex,
    repaint() {
      paint(ctx, width, height)
      tex.needsUpdate = true
    },
  }
}

// ---------------------------------------------------------------------------
// Painted skins

const WHITE = '#eef1f5'
const BLACK = '#0b0d11'
const FONT = '"Saira Variable", "Saira", "Arial Narrow", sans-serif'
const MONO = '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace'

/** First-stage skin (y 0 → 5.6). Canvas x = around (u 0.5 faces camera), canvas y = height. */
function paintStage1(ctx, W, H) {
  const yToPx = (y) => H - (y / DIM.stage1Top) * H
  ctx.fillStyle = WHITE
  ctx.fillRect(0, 0, W, H)

  // soft engine soot rising from the skirt
  const soot = ctx.createLinearGradient(0, yToPx(0), 0, yToPx(1.25))
  soot.addColorStop(0, 'rgba(22, 24, 30, 0.55)')
  soot.addColorStop(0.35, 'rgba(40, 42, 50, 0.18)')
  soot.addColorStop(1, 'rgba(40, 42, 50, 0)')
  ctx.fillStyle = soot
  ctx.fillRect(0, yToPx(1.25), W, yToPx(0) - yToPx(1.25))

  // panel seams
  ctx.fillStyle = 'rgba(30, 36, 48, 0.16)'
  for (const y of [0.74, 1.95, 3.15, 4.4]) ctx.fillRect(0, yToPx(y), W, 3)
  ctx.fillStyle = 'rgba(30, 36, 48, 0.08)'
  ctx.fillRect(W * 0.04, 0, 3, H) // weld line on the far side

  // atmospheric-blue pinstripe + black ring just below the interstage
  ctx.fillStyle = '#6fc3ff'
  ctx.fillRect(0, yToPx(5.42), W, 7)
  ctx.fillStyle = BLACK
  ctx.fillRect(0, yToPx(5.6), W, yToPx(5.5) - yToPx(5.6))

  // stacked S · X · S · I mark, upright letters reading top to bottom
  ctx.fillStyle = BLACK
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  try {
    ctx.fontStretch = 'expanded'
  } catch {
    /* older canvas implementations */
  }
  const letterH = (0.5 / DIM.stage1Top) * H
  ctx.font = `700 ${Math.round(letterH * 1.32)}px ${FONT}`
  const letters = ['S', 'X', 'S', 'I']
  letters.forEach((ch, i) => {
    const y = yToPx(4.75 - i * 0.66)
    ctx.fillText(ch, W * 0.5, y)
  })

  // small mono stencil near the base
  ctx.font = `600 ${Math.round(H * 0.0105)}px ${MONO}`
  ctx.fillStyle = 'rgba(11, 13, 17, 0.75)'
  ctx.fillText('S1 · 001', W * 0.5, yToPx(1.42))
  ctx.fillRect(W * 0.5 - W * 0.03, yToPx(1.32), W * 0.06, 3)
}

/** Second stage + fairing skin (y 6.32 → 10.9). */
function paintUpper(ctx, W, H) {
  const y0 = DIM.stage2Bottom
  const y1 = DIM.noseTip
  const yToPx = (y) => H - ((y - y0) / (y1 - y0)) * H
  ctx.fillStyle = WHITE
  ctx.fillRect(0, 0, W, H)
  ctx.fillStyle = 'rgba(30, 36, 48, 0.14)'
  for (const y of [7.05, 7.8]) ctx.fillRect(0, yToPx(y), W, 3)
  // forward skirt + fairing base band
  ctx.fillStyle = BLACK
  ctx.fillRect(0, yToPx(8.55), W, yToPx(8.42) - yToPx(8.55))
  ctx.fillRect(0, yToPx(8.82), W, yToPx(8.76) - yToPx(8.82))
  ctx.fillStyle = '#6fc3ff'
  ctx.fillRect(0, yToPx(8.4), W, 5)
  // stage-2 mark
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  try {
    ctx.fontStretch = 'expanded'
  } catch {
    /* noop */
  }
  ctx.font = `700 ${Math.round(H * 0.052)}px ${FONT}`
  ctx.fillStyle = BLACK
  ctx.fillText('SXSI', W * 0.5, yToPx(7.42))
  ctx.font = `600 ${Math.round(H * 0.014)}px ${MONO}`
  ctx.fillStyle = 'rgba(11, 13, 17, 0.7)'
  ctx.fillText('S2 · INTELLIGENCE PAYLOAD', W * 0.5, yToPx(7.15))
  // fairing seam (front + back) — the clamshell splits here
  ctx.fillStyle = 'rgba(20, 24, 32, 0.35)'
  const seamTop = 0
  ctx.fillRect(W * 0.5 - 1, seamTop, 2, yToPx(8.57) - seamTop)
  ctx.fillRect(0, seamTop, 2, yToPx(8.57) - seamTop)
}

/** Vertical emissive gradient for the second-stage nozzle extension (hot at the exit). */
function nozzleGlowTexture() {
  return canvasTexture(4, 128, (ctx, W, H) => {
    const g = ctx.createLinearGradient(0, 0, 0, H)
    g.addColorStop(0, '#000000')
    g.addColorStop(0.45, '#1a0400')
    g.addColorStop(0.8, '#ff5a1a')
    g.addColorStop(1, '#ffd2a0')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, W, H)
  }).tex
}

// ---------------------------------------------------------------------------
// Materials

/** MeshStandardMaterial with a directional fresnel rim (atmospheric back-light). */
function rimMaterial(params, rim) {
  const mat = new THREE.MeshStandardMaterial(params)
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uRimColor = rim.color
    shader.uniforms.uRimDir = rim.dir
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uRimColor;\nuniform vec3 uRimDir;')
      .replace(
        '#include <opaque_fragment>',
        `{
          float rimF = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 3.0);
          float side = saturate(dot(normal, uRimDir) * 0.75 + 0.35);
          outgoingLight += uRimColor * rimF * side;
        }
        #include <opaque_fragment>`,
      )
  }
  return mat
}

// ---------------------------------------------------------------------------
// Payload: a sphere of linked nodes

function createPayload(tier) {
  const count = tier === 'low' ? 90 : tier === 'medium' ? 130 : 170
  const rand = seededRandom(20260)
  const dirs = []
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2
    const r = Math.sqrt(1 - y * y)
    const th = golden * i
    const v = new THREE.Vector3(Math.cos(th) * r, y, Math.sin(th) * r)
    v.x += (rand() - 0.5) * 0.12
    v.y += (rand() - 0.5) * 0.12
    v.z += (rand() - 0.5) * 0.12
    v.normalize()
    dirs.push({ v, rand: rand() })
  }

  // Each node links to its 3 nearest neighbours (deduplicated).
  const edges = new Set()
  dirs.forEach((a, i) => {
    const near = dirs
      .map((b, j) => ({ j, d: a.v.distanceToSquared(b.v) }))
      .filter((n) => n.j !== i)
      .sort((x, y) => x.d - y.d)
      .slice(0, 3)
    near.forEach(({ j }) => edges.add(i < j ? `${i}-${j}` : `${j}-${i}`))
  })
  // A few long-range links turn the lattice into a constellation.
  for (let k = 0; k < Math.round(count / 10); k++) {
    const i = Math.floor(rand() * count)
    const j = Math.floor(rand() * count)
    if (i !== j) edges.add(i < j ? `${i}-${j}` : `${j}-${i}`)
  }

  const uniforms = {
    uTime: { value: 0 },
    uUnfold: { value: 0 },
    uScale: { value: 0.3 },
    uPx: { value: 5 },
    uColor: { value: new THREE.Color(0.55, 0.85, 1.0) },
    uAlpha: { value: 0 },
  }

  const nodeGeo = new THREE.BufferGeometry()
  const nPos = new Float32Array(count * 3)
  const nDir = new Float32Array(count * 3)
  const nRand = new Float32Array(count)
  dirs.forEach(({ v, rand: r }, i) => {
    nDir.set([v.x, v.y, v.z], i * 3)
    nRand[i] = r
  })
  nodeGeo.setAttribute('position', new THREE.BufferAttribute(nPos, 3))
  nodeGeo.setAttribute('aDir', new THREE.BufferAttribute(nDir, 3))
  nodeGeo.setAttribute('aRand', new THREE.BufferAttribute(nRand, 1))
  const nodes = new THREE.Points(
    nodeGeo,
    new THREE.ShaderMaterial({
      uniforms,
      vertexShader: NODE_VERT,
      fragmentShader: NODE_FRAG,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    }),
  )

  const list = [...edges].map((key) => key.split('-').map(Number))
  const ePos = new Float32Array(list.length * 6)
  const eDir = new Float32Array(list.length * 6)
  const eRand = new Float32Array(list.length * 2)
  const eT = new Float32Array(list.length * 2)
  const ePhase = new Float32Array(list.length * 2)
  list.forEach(([a, b], i) => {
    const phase = rand()
    ;[a, b].forEach((n, k) => {
      const v = dirs[n].v
      eDir.set([v.x, v.y, v.z], (i * 2 + k) * 3)
      eRand[i * 2 + k] = dirs[n].rand
      eT[i * 2 + k] = k
      ePhase[i * 2 + k] = phase
    })
  })
  const edgeGeo = new THREE.BufferGeometry()
  edgeGeo.setAttribute('position', new THREE.BufferAttribute(ePos, 3))
  edgeGeo.setAttribute('aDir', new THREE.BufferAttribute(eDir, 3))
  edgeGeo.setAttribute('aRand', new THREE.BufferAttribute(eRand, 1))
  edgeGeo.setAttribute('aT', new THREE.BufferAttribute(eT, 1))
  edgeGeo.setAttribute('aPhase', new THREE.BufferAttribute(ePhase, 1))
  const lines = new THREE.LineSegments(
    edgeGeo,
    new THREE.ShaderMaterial({
      uniforms,
      vertexShader: EDGE_VERT,
      fragmentShader: EDGE_FRAG,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    }),
  )

  const group = new THREE.Group()
  group.add(lines, nodes)
  // Positions are computed in the vertex shader, so skip culling.
  nodes.frustumCulled = false
  lines.frustumCulled = false

  // Orbit traces: three tilted ellipses, each with a bright travelling head.
  const rings = new THREE.Group()
  const ringMats = []
  ;[
    [1.3, 1.22, -0.38, 0.07, 0.0],
    [1.75, 1.32, 0.24, 0.045, 0.35],
    [2.3, 1.4, 0.62, 0.03, 0.7],
  ].forEach(([radius, tiltX, tiltZ, speed, phase]) => {
    const n = 180
    const pos = new Float32Array(n * 3)
    const t = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      pos.set([Math.cos(a) * radius, 0, Math.sin(a) * radius], i * 3)
      t[i] = i / n
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('aT', new THREE.BufferAttribute(t, 1))
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: uniforms.uTime,
        uSpeed: { value: speed },
        uPhase: { value: phase },
        uColor: { value: new THREE.Color(0.45, 0.78, 1.0) },
        uAlpha: { value: 0 },
      },
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    })
    ringMats.push(mat)
    const ring = new THREE.LineLoop(geo, mat)
    ring.rotation.set(tiltX, 0, tiltZ)
    ring.frustumCulled = false
    rings.add(ring)
  })

  return {
    group,
    uniforms,
    rings,
    setRings(alpha) {
      ringMats.forEach((m) => (m.uniforms.uAlpha.value = alpha))
      rings.visible = alpha > 0.002
    },
  }
}

// ---------------------------------------------------------------------------

/**
 * Builds the vehicle. Returns the scene-graph handles the director animates:
 *   vehicle (root) ─ stage1 (body, interstage, fins, engines)
 *                  └ stage2 (body, vacuum nozzle, fairingL/R, payload)
 */
export function createVehicle({ tier = 'high' } = {}) {
  const segs = tier === 'low' ? 48 : 72
  const rim = { color: { value: new THREE.Color(0, 0, 0) }, dir: { value: new THREE.Vector3(-1, 0.2, 0.3).normalize() } }

  const skin1 = canvasTexture(1024, 2048, paintStage1)
  const skinUp = canvasTexture(1024, 1792, paintUpper)

  const whiteMat1 = rimMaterial({ map: skin1.tex, roughness: 0.46, metalness: 0.04 }, rim)
  const whiteMatUp = rimMaterial({ map: skinUp.tex, roughness: 0.42, metalness: 0.04, side: THREE.DoubleSide }, rim)
  const blackMat = rimMaterial({ color: BLACK, roughness: 0.5, metalness: 0.25, side: THREE.DoubleSide }, rim)
  const metalMat = new THREE.MeshStandardMaterial({ color: '#5a5f69', roughness: 0.32, metalness: 0.85, side: THREE.DoubleSide })
  const nozzle2Mat = new THREE.MeshStandardMaterial({
    color: '#3d4048',
    roughness: 0.38,
    metalness: 0.8,
    side: THREE.DoubleSide,
    emissive: new THREE.Color('#ffffff'),
    emissiveMap: nozzleGlowTexture(),
    emissiveIntensity: 0,
  })

  const vehicle = new THREE.Group()
  const stage1 = new THREE.Group()
  const stage2 = new THREE.Group()
  vehicle.add(stage1, stage2)

  // --- Stage 1 -------------------------------------------------------------
  const s1Body = new THREE.Mesh(
    lathe(
      [
        [0.001, 0.04],
        [0.44, 0.0],
        [0.5, 0.04],
        [0.5, 0.17],
        [0.47, 0.36],
        [0.435, 0.56],
        [0.42, 0.74],
        [0.42, DIM.stage1Top],
      ],
      { segments: segs, uvY: [0, DIM.stage1Top] },
    ),
    whiteMat1,
  )
  const interstage = new THREE.Mesh(
    lathe(
      [
        [0.42, DIM.stage1Top],
        [0.42, DIM.interTop - 0.03],
        [0.425, DIM.interTop - 0.02],
        [0.425, DIM.interTop],
        [0.4, DIM.interTop],
      ],
      { segments: segs },
    ),
    blackMat,
  )
  stage1.add(s1Body, interstage)

  // Swept fins on the principal axes: two in full profile, one edge-on as a strake.
  const finShape = new THREE.Shape()
  finShape.moveTo(0, 0.12)
  finShape.lineTo(0, 1.85)
  finShape.lineTo(0.36, 0.7)
  finShape.lineTo(0.42, 0.02)
  finShape.lineTo(0.3, -0.06)
  finShape.closePath()
  const finGeo = new THREE.ExtrudeGeometry(finShape, {
    depth: 0.035,
    bevelEnabled: true,
    bevelThickness: 0.008,
    bevelSize: 0.008,
    bevelSegments: 1,
  })
  finGeo.translate(0.4, 0, -0.0175)
  for (let i = 0; i < 4; i++) {
    const fin = new THREE.Mesh(finGeo, blackMat)
    fin.rotation.y = (i * Math.PI) / 2
    stage1.add(fin)
  }

  // Engine cluster: one centre bell + a ring of four.
  const bellGeo = lathe(
    [
      [0.05, 0.05],
      [0.058, 0.0],
      [0.075, -0.08],
      [0.1, -0.18],
      [0.125, -0.28],
      [0.14, -0.36],
    ],
    { segments: 32 },
  )
  const engines = [
    [0, 0],
    [0.25, 0],
    [-0.25, 0],
    [0, 0.25],
    [0, -0.25],
  ]
  engines.forEach(([x, z]) => {
    const bell = new THREE.Mesh(bellGeo, metalMat)
    bell.position.set(x, 0, z)
    stage1.add(bell)
  })

  // --- Stage 2 -------------------------------------------------------------
  const upperUv = [DIM.stage2Bottom, DIM.noseTip]
  const s2Body = new THREE.Mesh(
    lathe(
      [
        [0.001, DIM.stage2Bottom],
        [0.34, DIM.stage2Bottom],
        [0.405, DIM.stage2Bottom + 0.05],
        [0.415, DIM.stage2Bottom + 0.1],
        [0.415, DIM.stage2Top],
      ],
      { segments: segs, uvY: upperUv },
    ),
    whiteMatUp,
  )
  const nozzle2 = new THREE.Mesh(
    lathe(
      [
        [0.09, DIM.stage2Bottom + 0.02],
        [0.1, DIM.stage2Bottom - 0.06],
        [0.15, 6.05],
        [0.22, 5.88],
        [0.28, 5.76],
        [DIM.nozzle2R, DIM.nozzle2Exit],
      ],
      { segments: 48 },
    ),
    nozzle2Mat,
  )
  // The upper-stage hull pivots about its middle so it can tumble once spent.
  const hull = new THREE.Group()
  hull.position.y = DIM.hullY
  s2Body.position.y = nozzle2.position.y = -DIM.hullY
  hull.add(s2Body, nozzle2)
  stage2.add(hull)

  // Fairing: two clamshell halves (+x and −x) that separate in flight.
  const fairingProfile = [
    [0.415, DIM.stage2Top],
    [0.43, DIM.stage2Top + 0.04],
    [DIM.fairingR, DIM.stage2Top + 0.2],
    [DIM.fairingR, DIM.shoulder],
    ...ogive(DIM.fairingR, DIM.noseTip - DIM.shoulder, DIM.shoulder),
  ]
  const halfSegs = Math.round(segs / 2)
  const fairingR = new THREE.Mesh(
    lathe(fairingProfile, { segments: halfSegs, phiStart: 0, phiLength: Math.PI, uvY: upperUv }),
    whiteMatUp,
  )
  const fairingL = new THREE.Mesh(
    lathe(fairingProfile, { segments: halfSegs, phiStart: Math.PI, phiLength: Math.PI, uvY: upperUv }),
    whiteMatUp,
  )
  // Half-lathes start at different phi, so remap u to keep the skin continuous.
  ;[
    [fairingR, 0.5],
    [fairingL, 0],
  ].forEach(([mesh, offset]) => {
    const uv = mesh.geometry.attributes.uv
    for (let i = 0; i < uv.count; i++) uv.setX(i, offset + uv.getX(i) * 0.5)
  })
  // Needle tip: split with the halves so it rides away on one of them.
  const needle = new THREE.Mesh(
    lathe(
      [
        [0.035, DIM.noseTip - 0.08],
        [0.022, DIM.noseTip + 0.05],
        [0.012, DIM.needleTip - 0.1],
        [0.002, DIM.needleTip],
      ],
      { segments: 16 },
    ),
    blackMat,
  )
  fairingR.add(needle)

  // Pivot each half at its base so it can hinge outward.
  const hingeR = new THREE.Group()
  const hingeL = new THREE.Group()
  hingeR.position.set(DIM.R, DIM.stage2Top, 0)
  hingeL.position.set(-DIM.R, DIM.stage2Top, 0)
  fairingR.position.set(-DIM.R, -DIM.stage2Top, 0)
  fairingL.position.set(DIM.R, -DIM.stage2Top, 0)
  hingeR.add(fairingR)
  hingeL.add(fairingL)
  stage2.add(hingeR, hingeL)

  const payload = createPayload(tier)
  payload.group.position.set(0, DIM.payloadY, 0)
  payload.group.visible = false
  stage2.add(payload.group)
  payload.setRings(0)
  stage2.add(payload.rings)

  // Payload adapter: a short black cone the payload sits on.
  const adapter = new THREE.Mesh(
    lathe(
      [
        [0.4, DIM.stage2Top],
        [0.3, DIM.stage2Top + 0.1],
        [0.14, DIM.stage2Top + 0.24],
        [0.1, DIM.stage2Top + 0.25],
      ],
      { segments: 40 },
    ),
    blackMat,
  )
  adapter.position.y = -DIM.hullY
  hull.add(adapter)

  // Load the display face before painting the marks (fonts are local files).
  const fontsReady = document.fonts
    ? Promise.all([
        document.fonts.load(`700 120px ${FONT}`),
        document.fonts.load(`600 20px ${MONO}`),
      ]).catch(() => {})
    : Promise.resolve()
  fontsReady.then(() => {
    skin1.repaint()
    skinUp.repaint()
  })

  const materials = [whiteMat1, whiteMatUp, blackMat, metalMat, nozzle2Mat]

  return {
    vehicle,
    stage1,
    stage2,
    hull,
    hingeL,
    hingeR,
    nozzle2Mat,
    payload,
    rim,
    dispose() {
      vehicle.traverse((obj) => obj.geometry?.dispose?.())
      materials.forEach((m) => {
        m.map?.dispose()
        m.emissiveMap?.dispose()
        m.dispose()
      })
      payload.group.children.forEach((c) => c.material.dispose())
      payload.rings.children.forEach((c) => c.material.dispose())
    },
  }
}
