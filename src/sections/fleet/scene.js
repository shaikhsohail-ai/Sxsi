/**
 * Fleet hologram — one WebGL canvas, additive light only (no depth buffer).
 *
 *   swarm     one Points cloud whose particles hold a target in every vehicle and
 *             re-form along the rising scan plane (see shaders.js)
 *   rigs      per-vehicle line art; parts spin exactly like their particles
 *   tesseract ZENITH's 4D hypercube, rotated in 4D and projected each frame
 *   horizon   ZENITH's black shadow, photon ring and lensed halo (billboard)
 *   pad       projector pad rings + ticks, beam cone, motes and floor glow
 *   scanner   the ring that rides the scan plane during a rebuild
 *
 * Draw order is explicit (no depth buffer): floor, beam, motes, pad, horizon,
 * swarm, line art, scanner — so the horizon can swallow the beam behind it
 * while the near side of ZENITH's disc still crosses in front of it.
 *
 * The scene only *reads* `view` ({ from, to, mix, heat, boost, px, py, yaw }); all
 * choreography lives in fleet.js. It decays `view.boost` (a scroll-velocity
 * impulse) itself. Placement comes from an anchor element in the DOM: its
 * centre is the hologram's focus and its width is one world unit, so CSS owns
 * the layout at every breakpoint.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  CustomBlending,
  CylinderGeometry,
  DoubleSide,
  Group,
  LineSegments,
  Mesh,
  OneFactor,
  OneMinusSrcAlphaFactor,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  Scene,
  ShaderMaterial,
  Vector3,
  Vector4,
  WebGLRenderer,
} from 'three'
import { createRenderLoop } from '../../lib/visibility.js'
import { byTier, dpr, tier } from '../../lib/quality.js'
import { clamp, lerp, seededRandom } from '../../lib/dom.js'
import { HORIZON_RADIUS, buildFleet, buildPad, buildScanner, tesseract } from './shapes.js'
import * as GLSL from './shaders.js'

const FOV = 30
const PAD_Y = -1.62
const TARGET_Y = 0.1
const ELEVATION = 0.19 // camera pitch above the pad, radians
const SCAN_START = -2.7 // low enough that no particle has started moving at mix = 0
const SCAN_END = 2.4 // above the tallest vehicle
const POINT_WORLD = 0.024 // particle diameter at size 1, in world units
const BEAM_H = 3 // projector beam height above the pad
const BEAM_TOP = 1.32 // beam cone radii
const BEAM_BOTTOM = 0.24

/** sRGB triplets (kept as raw sRGB — these materials skip colour management). */
const rgb = (hex) => new Vector3(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255)

const SWARM_COLORS = [rgb(0x6fc3ff), rgb(0x5aaeff), rgb(0x4f95ff), rgb(0xff6b2c)]
const SWARM_HOT = [rgb(0xeaf8ff), rgb(0xd8f0ff), rgb(0xd4ecff), rgb(0xffd2a0)]
const SWARM_GAIN = [1, 1.05, 1, 1.55] // ZENITH's orange reads darker than blue; lift it
const LINE_COLORS = [rgb(0x8fd3ff), rgb(0x7cc6ff), rgb(0x78b4ff), rgb(0xff7a3a)]
const ATMO = rgb(0x6fc3ff)
const IGNITE = rgb(0xff6b2c)
const IGNITE_HOT = rgb(0xffc48a)
const LINE_GAIN = dpr >= 1.5 ? 1.5 : 1 // 1-device-pixel lines read thinner on dense screens

// Draw order (see header)
const ORDER = { floor: 1, beam: 2, motes: 3, pad: 4, horizon: 5, swarm: 6, rigs: 7, scanner: 8 }

const additive = {
  transparent: true,
  depthTest: false,
  depthWrite: false,
  blending: AdditiveBlending,
}

export function createFleetScene({ canvas, viz, anchor, view, animate = true, onFrame, onLost }) {
  const renderer = new WebGLRenderer({
    canvas,
    alpha: true,
    antialias: tier !== 'low',
    powerPreference: 'high-performance',
  })
  renderer.setPixelRatio(dpr)
  renderer.setClearColor(0x000000, 0)

  const scene = new Scene()
  const camera = new PerspectiveCamera(FOV, 1, 0.1, 100)
  const target = new Vector3(0, TARGET_Y, 0)
  const shared = { uTime: { value: 0 }, uFocus: { value: 12 } }

  /* ---- Hologram ---------------------------------------------------------- */
  const holo = new Group()
  scene.add(holo)

  const fleet = buildFleet(byTier({ high: 7200, medium: 4800, low: 2800 }))
  const swarm = createSwarm(fleet, shared)
  swarm.points.renderOrder = ORDER.swarm
  holo.add(swarm.points)

  const rigs = fleet.vehicles.map((vehicle, i) => {
    const rig = createRig(vehicle.lines, LINE_COLORS[i], shared, true)
    holo.add(rig.group)
    return rig
  })
  const hyper = createTesseract(rigs[3])
  createHorizon(rigs[3], shared)
  // ZENITH's horizon in view space (xyz) + radius (w), refreshed every frame.
  // Shared by the swarm and ZENITH's own lines; w = 0 switches occlusion off.
  const hole = new Vector4(0, 0, 0, 0)
  rigs[3].uniforms.uHole.value = hole
  swarm.uniforms.uHole.value = hole

  /* ---- Projector --------------------------------------------------------- */
  const pad = createRig(buildPad(), ATMO.clone(), shared, false, ORDER.pad)
  pad.group.position.y = PAD_Y
  scene.add(pad.group)

  const scanner = createRig(buildScanner(), rgb(0xd9f2ff), shared, false, ORDER.scanner)
  scanner.group.visible = false
  scene.add(scanner.group)

  const beam = createBeam(shared)
  beam.position.y = PAD_Y + BEAM_H / 2
  beam.renderOrder = ORDER.beam
  scene.add(beam)

  const motes = createMotes(shared, byTier({ high: 260, medium: 160, low: 90 }))
  motes.renderOrder = ORDER.motes
  scene.add(motes)

  const floor = createFloor(shared)
  floor.position.y = PAD_Y - 0.01
  floor.renderOrder = ORDER.floor
  scene.add(floor)

  /* ---- Layout ------------------------------------------------------------ */
  let dist = 12
  const layout = () => {
    const w = Math.max(1, viz.clientWidth)
    const h = Math.max(1, viz.clientHeight)
    const box = viz.getBoundingClientRect()
    const a = anchor.getBoundingClientRect()
    const unit = Math.max(20, a.width) // px per world unit at the focus
    const cx = a.left + a.width / 2 - box.left
    const cy = a.top + a.height / 2 - box.top

    renderer.setSize(w, h, false)
    camera.aspect = w / h
    dist = h / (unit * 2 * Math.tan(((FOV / 2) * Math.PI) / 180))
    camera.setViewOffset(w, h, -(cx - w / 2), -(cy - h / 2), w, h)
    camera.updateProjectionMatrix()

    shared.uFocus.value = dist
    swarm.uniforms.uSize.value = POINT_WORLD * unit * dpr * dist
    swarm.uniforms.uMinSize.value = 1.25 * dpr
    motes.material.uniforms.uSize.value = POINT_WORLD * 1.3 * unit * dpr * dist
  }

  /* ---- Frame --------------------------------------------------------------- */
  let clock = 2.4 // spin clock (advances faster while scrolling)
  let spin = 0
  const color = new Vector3()

  const update = (time, dt) => {
    spin += (view.boost - spin) * (1 - Math.exp(-dt * 4))
    view.boost *= Math.exp(-dt * 2.2)
    clock += dt * (1 + spin)
    shared.uTime.value = time

    holo.rotation.y = clock * 0.13 + (view.yaw || 0)
    holo.rotation.x = Math.sin(clock * 0.21) * 0.03

    // Rebuild: one scan plane drives particles, line cuts and the scanner ring.
    const morphing = view.mix < 1

    // Camera: a slow orbit nudged by the pointer; it eases back a touch while a
    // vehicle rebuilds (a cinematic breath) and settles in as it locks.
    const breath = morphing ? Math.sin(Math.PI * view.mix) * 0.07 : 0
    const r = dist * (1 + breath)
    const az = 0.32 + view.px * 0.16 + Math.sin(time * 0.07) * 0.05
    const el = ELEVATION + view.py * 0.05
    camera.position.set(Math.sin(az) * Math.cos(el) * r, TARGET_Y + Math.sin(el) * r, Math.cos(az) * Math.cos(el) * r)
    camera.lookAt(target)
    camera.updateMatrixWorld()

    const scan = morphing ? lerp(SCAN_START, SCAN_END, view.mix) : 99
    const u = swarm.uniforms
    u.uClock.value = clock
    u.uFrom.value = morphing ? view.from : view.to
    u.uTo.value = view.to
    u.uScan.value = scan

    rigs.forEach((rig, i) => {
      let cut = -99
      let dir = 1
      if (i === view.to) cut = morphing ? scan : 99
      else if (morphing && i === view.from) {
        cut = scan
        dir = -1
      }
      rig.uniforms.uCut.value = cut
      rig.uniforms.uDir.value = dir
      rig.group.visible = cut > -50
      if (rig.group.visible) rig.spin(clock)
    })
    if (rigs[3].group.visible) hyper.update(animate ? time : 1.7)

    // Event horizon, in view space, for occluding what passes behind it.
    hole.set(0, 0, 0, 1).applyMatrix4(camera.matrixWorldInverse)
    hole.w = rigs[3].group.visible ? HORIZON_RADIUS : 0

    const heat = clamp(view.heat)
    rigs[3].uniforms.uHeat.value = heat
    color.copy(ATMO).lerp(IGNITE, heat)
    pad.uniforms.uColor.value.copy(color)
    beam.material.uniforms.uColor.value.copy(color)
    motes.material.uniforms.uColor.value.copy(color)
    floor.material.uniforms.uColor.value.copy(color)
    pad.spin(clock)

    const sweep = morphing ? Math.sin(Math.PI * clamp((scan - PAD_Y) / (SCAN_END - PAD_Y))) : 0
    scanner.group.visible = sweep > 0.01
    scanner.group.position.y = scan
    scanner.uniforms.uOpacity.value = sweep * 0.9
    beam.material.uniforms.uOpacity.value = 0.55 + sweep * 0.5
    motes.material.uniforms.uOpacity.value = 0.75 + sweep * 0.6
    floor.material.uniforms.uOpacity.value = 0.32 + sweep * 0.25 + heat * 0.08

    renderer.render(scene, camera)
    onFrame?.(((holo.rotation.y * 180) / Math.PI) % 360)
  }

  /* ---- Lifecycle --------------------------------------------------------- */
  layout()
  renderer.compile(scene, camera) // no shader-compile hitch on the first visible frame
  const ro = new ResizeObserver(() => {
    layout()
    if (!animate) update(1.7, 0)
  })
  ro.observe(viz)

  let loop = null
  if (animate) loop = createRenderLoop(viz, update, { rootMargin: '120px' })
  else update(1.7, 0)

  const onContextLost = (event) => {
    event.preventDefault()
    destroy()
    onLost?.()
  }
  canvas.addEventListener('webglcontextlost', onContextLost, { once: true })

  function destroy() {
    loop?.destroy()
    ro.disconnect()
    scene.traverse((obj) => {
      obj.geometry?.dispose()
      obj.material?.dispose()
    })
    renderer.dispose()
  }

  return {
    /** Draws one frame (used when not animating, e.g. reduced motion). */
    render: () => update(1.7, 0),
    layout,
    destroy,
    count: fleet.count,
  }
}

/* --------------------------------------------------------------------------
 * Builders
 * ------------------------------------------------------------------------ */
function createSwarm(fleet, shared) {
  const { count, vehicles, random } = fleet
  const geometry = new BufferGeometry()
  // `position` only sets the draw count; the shader reads aP0..aP3.
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(count * 3), 3))
  vehicles.forEach((v, i) => {
    geometry.setAttribute(`aP${i}`, new BufferAttribute(v.swarm.pos, 4))
    geometry.setAttribute(`aS${i}`, new BufferAttribute(v.swarm.spin, 4))
  })
  geometry.setAttribute('aRand', new BufferAttribute(random, 4))

  const uniforms = {
    uTime: shared.uTime,
    uClock: { value: 0 },
    uFrom: { value: -1 },
    uTo: { value: 0 },
    uScan: { value: SCAN_START },
    uSize: { value: 40 },
    uMinSize: { value: 1.25 },
    uPadY: { value: PAD_Y },
    uOpacity: { value: 1 },
    uColor: { value: SWARM_COLORS },
    uHot: { value: SWARM_HOT },
    uGain: { value: SWARM_GAIN },
    uHole: { value: new Vector4(0, 0, 0, 0) },
  }
  const material = new ShaderMaterial({
    uniforms,
    vertexShader: GLSL.swarmVertex,
    fragmentShader: GLSL.swarmFragment,
    ...additive,
  })
  const points = new Points(geometry, material)
  points.frustumCulled = false
  return { points, uniforms }
}

/** Line art: one material per rig, one LineSegments per spinning part. */
function createRig(parts, color, shared, sweep = false, order = ORDER.rigs) {
  const uniforms = {
    uTime: shared.uTime,
    uFocus: shared.uFocus,
    uSweep: { value: sweep ? 1 : 0 },
    uColor: { value: color },
    uOpacity: { value: 1 },
    uCut: { value: 99 },
    uDir: { value: 1 },
    uHeat: { value: 0 },
    uGain: { value: LINE_GAIN },
    uHole: { value: new Vector4(0, 0, 0, 0) },
  }
  const material = new ShaderMaterial({
    uniforms,
    vertexShader: GLSL.lineVertex,
    fragmentShader: GLSL.lineFragment,
    ...additive,
  })
  const group = new Group()
  const spinning = []
  for (const p of parts) {
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(p.segs), 3))
    const alphas = new Float32Array(p.segs.length / 3)
    for (let v = 0; v < alphas.length; v++) {
      alphas[v] = typeof p.alpha === 'function' ? p.alpha(p.segs[v * 3], p.segs[v * 3 + 1], p.segs[v * 3 + 2]) : p.alpha
    }
    geometry.setAttribute('aAlpha', new BufferAttribute(alphas, 1))
    const lines = new LineSegments(geometry, material)
    lines.frustumCulled = false
    lines.renderOrder = order
    group.add(lines)
    if (p.speed) spinning.push({ lines, axis: p.axis.clone().normalize(), speed: p.speed })
  }
  return {
    group,
    material,
    uniforms,
    spin(clock) {
      for (const s of spinning) s.lines.quaternion.setFromAxisAngle(s.axis, s.speed * clock)
    },
  }
}

/**
 * ZENITH's hypercube: rotated in the XW and ZW planes, projected to 3D. It sits
 * inside the event horizon, so it gets its own material (same uniforms, minus
 * the occlusion) and is drawn over the shadow — something turning in the dark.
 */
function createTesseract(rig) {
  const { verts, edges } = tesseract()
  const positions = new Float32Array(edges.length * 6)
  const alphas = new Float32Array(edges.length * 2)
  const geometry = new BufferGeometry()
  const posAttr = new BufferAttribute(positions, 3)
  const alphaAttr = new BufferAttribute(alphas, 1)
  geometry.setAttribute('position', posAttr)
  geometry.setAttribute('aAlpha', alphaAttr)
  const material = new ShaderMaterial({
    uniforms: { ...rig.uniforms, uHole: { value: new Vector4(0, 0, 0, 0) } },
    vertexShader: GLSL.lineVertex,
    fragmentShader: GLSL.lineFragment,
    ...additive,
  })
  const lines = new LineSegments(geometry, material)
  lines.frustumCulled = false
  lines.renderOrder = ORDER.rigs
  rig.group.add(lines)

  const D4 = 3 // 4D camera distance
  const SCALE = 0.21 // keeps every projected vertex inside the horizon
  const projected = verts.map(() => [0, 0, 0, 1])

  return {
    update(time) {
      const a = time * 0.31
      const b = time * 0.19
      const ca = Math.cos(a)
      const sa = Math.sin(a)
      const cb = Math.cos(b)
      const sb = Math.sin(b)
      verts.forEach(([x, y, z, w], i) => {
        const x1 = x * ca - w * sa
        const w1 = x * sa + w * ca
        const z1 = z * cb - w1 * sb
        const w2 = z * sb + w1 * cb
        const k = D4 / (D4 - w2)
        const p = projected[i]
        p[0] = x1 * k * SCALE
        p[1] = y * k * SCALE
        p[2] = z1 * k * SCALE
        p[3] = k
      })
      edges.forEach(([i, j], e) => {
        const p = projected[i]
        const q = projected[j]
        const o = e * 6
        positions[o] = p[0]
        positions[o + 1] = p[1]
        positions[o + 2] = p[2]
        positions[o + 3] = q[0]
        positions[o + 4] = q[1]
        positions[o + 5] = q[2]
        // Nearer in 4D = brighter
        alphas[e * 2] = 0.14 + (p[3] - 0.75) * 0.5
        alphas[e * 2 + 1] = 0.14 + (q[3] - 0.75) * 0.5
      })
      posAttr.needsUpdate = true
      alphaAttr.needsUpdate = true
    },
  }
}

/** ZENITH's event horizon: a billboard inside ZENITH's rig (shares its cut). */
function createHorizon(rig, shared) {
  const material = new ShaderMaterial({
    uniforms: {
      uTime: shared.uTime,
      uCut: rig.uniforms.uCut,
      uDir: rig.uniforms.uDir,
      uExtent: { value: HORIZON_RADIUS * 3.4 },
      uRadius: { value: HORIZON_RADIUS },
      uShadow: { value: 0.94 },
      uColor: { value: IGNITE.clone() },
      uHot: { value: IGNITE_HOT.clone() },
    },
    vertexShader: GLSL.horizonVertex,
    fragmentShader: GLSL.horizonFragment,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: CustomBlending,
    blendSrc: OneFactor,
    blendDst: OneMinusSrcAlphaFactor,
    blendSrcAlpha: OneFactor,
    blendDstAlpha: OneMinusSrcAlphaFactor,
  })
  const mesh = new Mesh(new PlaneGeometry(2, 2), material)
  mesh.frustumCulled = false
  mesh.renderOrder = ORDER.horizon
  rig.group.add(mesh)
  return mesh
}

/** Dust drifting up through the beam — the projector's light made visible. */
function createMotes(shared, count) {
  const geometry = new BufferGeometry()
  const seeds = new Float32Array(count * 4)
  const rand = seededRandom(0x0b3a)
  for (let i = 0; i < seeds.length; i++) seeds[i] = rand()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(count * 3), 3))
  geometry.setAttribute('aSeed', new BufferAttribute(seeds, 4))
  const material = new ShaderMaterial({
    uniforms: {
      uTime: shared.uTime,
      uSize: { value: 30 },
      uPadY: { value: PAD_Y },
      uHeight: { value: BEAM_H },
      uR0: { value: BEAM_BOTTOM },
      uR1: { value: BEAM_TOP },
      uColor: { value: ATMO.clone() },
      uOpacity: { value: 0.75 },
    },
    vertexShader: GLSL.motesVertex,
    fragmentShader: GLSL.motesFragment,
    ...additive,
  })
  const points = new Points(geometry, material)
  points.frustumCulled = false
  return points
}

function createBeam(shared) {
  const geometry = new CylinderGeometry(BEAM_TOP, BEAM_BOTTOM, BEAM_H, 64, 1, true)
  const material = new ShaderMaterial({
    uniforms: { uTime: shared.uTime, uColor: { value: ATMO.clone() }, uOpacity: { value: 0.55 } },
    vertexShader: GLSL.beamVertex,
    fragmentShader: GLSL.beamFragment,
    side: DoubleSide,
    ...additive,
  })
  const mesh = new Mesh(geometry, material)
  mesh.frustumCulled = false
  return mesh
}

function createFloor(shared) {
  const geometry = new CircleGeometry(2.1, 72)
  geometry.rotateX(-Math.PI / 2)
  const material = new ShaderMaterial({
    uniforms: { uTime: shared.uTime, uColor: { value: ATMO.clone() }, uOpacity: { value: 0.32 } },
    vertexShader: GLSL.floorVertex,
    fragmentShader: GLSL.floorFragment,
    side: DoubleSide,
    ...additive,
  })
  const mesh = new Mesh(geometry, material)
  mesh.frustumCulled = false
  return mesh
}
