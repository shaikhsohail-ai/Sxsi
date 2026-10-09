/**
 * Ascent scene — one WebGL context, rendered in a single pass:
 *
 *   sky quad (world-tracked pad, tower, clouds, trail, Earth)  → renderOrder −100
 *   vehicle meshes (lit, filmic tone-mapped)                    → opaque
 *   smoke / steam billboards                                    → 5
 *   vapor cone, plumes, glows, payload network                  → 10–20
 *   foreground quad (near clouds, air-speed streaks, flashes)   → 100
 *
 * `frame(p, time, dt)` is a pure-ish director: every transform and uniform
 * is derived from scroll progress `p`, plus wall-clock time for flicker,
 * drift and twinkle so the world stays alive when the scroll rests.
 */
import * as THREE from 'three'
import { createVehicle, DIM } from './rocket.js'
import {
  FULLSCREEN_VERT,
  SKY_FRAG,
  FG_FRAG,
  PLUME_VERT,
  PLUME_FRAG,
  GLOW_FRAG,
  VAPOR_FRAG,
  SMOKE_VERT,
  SMOKE_FRAG,
} from './shaders.js'
import { BEATS, missionTime, altitudeAt, skyPhaseAt, pitchAt } from './profile.js'
import { clamp, lerp, seededRandom } from '../../lib/dom.js'

const FOV = 20
const TAN = Math.tan(THREE.MathUtils.degToRad(FOV / 2))

const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}
/** 0 → 1 → 0 window with smooth edges. */
const window4 = (x, a, b, c, d) => smooth(a, b, x) * (1 - smooth(c, d, x))
const easeOut = (t) => 1 - Math.pow(1 - clamp(t), 3)
const smax = (a, b, k) => {
  const h = clamp(0.5 + (0.5 * (b - a)) / k)
  return lerp(a, b, h) + k * h * (1 - h)
}

/**
 * Framing per aspect. NDC anchors: x/y in −1…1 of the half-frame.
 *   pad*   — on the pad, tower beside the vehicle
 *   fly*   — first-stage flight
 *   s2*    — second stage, tighter
 *   orb*   — orbit, payload deploy above Earth's limb
 */
const LAYOUTS = {
  wide: {
    padHv: 20.5, padAx: 0.3, padAy: 0.34, padGround: -0.6, horizon: -0.36, horizonFly: -0.68,
    flyHv: 25, flyAx: 0.24, flyAy: 0.16,
    s2Hv: 14, s2Ax: 0.22, s2Ay: 0.1,
    orbHv: 15, orbAx: 0.2, orbAy: 0.16,
    earthR: 2.6, earthTop: -0.5, sunA: 0.3,
  },
  tall: {
    padHv: 31, padAx: -0.22, padAy: -0.1, padGround: -0.64, horizon: -0.44, horizonFly: -0.62,
    flyHv: 27, flyAx: 0, flyAy: -0.08,
    s2Hv: 17, s2Ax: 0, s2Ay: -0.12,
    orbHv: 19, orbAx: 0, orbAy: -0.02,
    earthR: 1.5, earthTop: -0.46, sunA: 0.2,
  },
}

/** Tier-scaled particle budgets. */
const BUDGET = {
  high: { trench: 110, column: 48, vent: 18, puffs: 30 },
  medium: { trench: 72, column: 34, vent: 12, puffs: 22 },
  low: { trench: 40, column: 20, vent: 8, puffs: 14 },
}

function fullscreenQuad(material, renderOrder) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material)
  mesh.frustumCulled = false
  mesh.renderOrder = renderOrder
  return mesh
}

/** Plane hanging below its origin (top edge at y = 0), for plumes and cones. */
function hangingQuad(material, renderOrder) {
  const geo = new THREE.PlaneGeometry(1, 1)
  geo.translate(0, -0.5, 0)
  const mesh = new THREE.Mesh(geo, material)
  mesh.frustumCulled = false
  mesh.renderOrder = renderOrder
  return mesh
}

function glowSprite(color, renderOrder) {
  const material = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(...color) }, uAlpha: { value: 0 } },
    vertexShader: PLUME_VERT,
    fragmentShader: GLOW_FRAG,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    transparent: true,
  })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material)
  mesh.frustumCulled = false
  mesh.renderOrder = renderOrder
  return mesh
}

/** Instanced billboard puffs (smoke, steam, separation gas). */
function puffSystem(count, uniforms, renderOrder) {
  const base = new THREE.PlaneGeometry(1, 1)
  const geo = new THREE.InstancedBufferGeometry()
  geo.index = base.index
  geo.setAttribute('position', base.attributes.position)
  geo.setAttribute('uv', base.attributes.uv)
  const pos = new Float32Array(count * 3)
  const data = new Float32Array(count * 4)
  const posAttr = new THREE.InstancedBufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage)
  const dataAttr = new THREE.InstancedBufferAttribute(data, 4).setUsage(THREE.DynamicDrawUsage)
  geo.setAttribute('iPos', posAttr)
  geo.setAttribute('iData', dataAttr)
  geo.instanceCount = count
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: SMOKE_VERT,
    fragmentShader: SMOKE_FRAG,
    transparent: true,
    depthWrite: false,
    defines: uniforms.__defines,
  })
  const mesh = new THREE.Mesh(geo, material)
  mesh.frustumCulled = false
  mesh.renderOrder = renderOrder
  return {
    mesh,
    pos,
    data,
    commit() {
      posAttr.needsUpdate = true
      dataAttr.needsUpdate = true
    },
  }
}

/** Rocket altitude in scene units (1 unit ≈ 6 m) at mission time t. */
const rocketYAt = (t) => (t <= 0 ? 0 : (altitudeAt(t) * 1000) / 6)

export function createAscentScene(canvas, { tier = 'high', dpr = 1 } = {}) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: tier !== 'low',
    alpha: false,
    stencil: false,
    powerPreference: 'high-performance',
  })
  const pixelRatio = Math.min(dpr, { high: 1.6, medium: 1.3, low: 1 }[tier] ?? 1.3)
  let renderScale = 1
  renderer.setPixelRatio(pixelRatio)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05
  renderer.setClearColor(0x000000, 1)

  const defines = { FBM_OCT: { high: 5, medium: 4, low: 3 }[tier] ?? 4 }
  const budget = BUDGET[tier] ?? BUDGET.medium

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(FOV, 1, 1, 600)
  camera.position.set(0, 6, 60)

  // --- background + foreground quads ---------------------------------------
  const skyU = {
    uRes: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uPxScale: { value: pixelRatio },
    uCam: { value: new THREE.Vector2() },
    uViewH: { value: 20 },
    uSky: { value: 0 },
    uStars: { value: 0 },
    uGround: { value: 1 },
    uHorizon: { value: -0.36 },
    uSunX: { value: 1.2 },
    uFire: { value: 0 },
    uFirePos: { value: new THREE.Vector2() },
    uFlood: { value: 1 },
    uArm: { value: 0 },
    uUmb: { value: 0 },
    uCloudY: { value: new THREE.Vector2(3, 3) },
    uCloudAmt: { value: 0 },
    uFlow: { value: 0 },
    uTrailA: { value: new THREE.Vector2() },
    uTrailDir: { value: new THREE.Vector2(0, -1) },
    uTrailLen: { value: 0 },
    uTrailAmt: { value: 0 },
    uTrailLit: { value: 0 },
    uEarth: { value: 0 },
    uEarthTop: { value: -2 },
    uEarthR: { value: 3 },
    uNight: { value: 0 },
    uSun: { value: 0 },
    uDawn: { value: 0 },
    uSunA: { value: 0.4 },
    uTowerX: { value: 1.22 },
  }
  const sky = fullscreenQuad(
    new THREE.ShaderMaterial({
      uniforms: skyU,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: SKY_FRAG,
      depthTest: false,
      depthWrite: false,
      defines,
    }),
    -100,
  )
  scene.add(sky)

  const fgU = {
    uRes: skyU.uRes,
    uTime: skyU.uTime,
    uCloudY: { value: 3 },
    uCloudAmt: { value: 0 },
    uFlow: skyU.uFlow,
    uFlash: { value: 0 },
    uFlashCol: { value: new THREE.Color(1, 0.8, 0.6) },
    uClear: { value: new THREE.Vector4(0, -0.42, -0.08, 1) },
    uFirePos: { value: new THREE.Vector2() },
    uFire: { value: 0 },
    uRing: { value: new THREE.Vector3(0, 0.02, 0) }, // radius, width, intensity (aspect-scaled screen units)
  }
  const fg = fullscreenQuad(
    new THREE.ShaderMaterial({
      uniforms: fgU,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: FG_FRAG,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      defines,
    }),
    100,
  )
  scene.add(fg)

  // --- lights ------------------------------------------------------------------
  const hemi = new THREE.HemisphereLight('#6f93c4', '#0a0d14', 0.6)
  const sun = new THREE.DirectionalLight('#fff1e0', 1)
  sun.position.set(6, 2.5, 3)
  const flood = new THREE.DirectionalLight('#dce8ff', 1.4)
  flood.position.set(-4, -1.2, 6)
  const fire = new THREE.PointLight('#ff7a30', 0, 0, 1.4)
  scene.add(hemi, sun, flood, fire)

  // --- vehicle -----------------------------------------------------------------
  const v = createVehicle({ tier })
  const pivot = new THREE.Group()
  pivot.add(v.vehicle)
  scene.add(pivot)

  const plumeMat = (seed) =>
    new THREE.ShaderMaterial({
      uniforms: {
        uTime: skyU.uTime,
        uPower: { value: 0 },
        uVac: { value: 0 },
        uDiamonds: { value: 1 },
        uNozzle: { value: 0.4 },
        uSize: { value: new THREE.Vector2(5, 12) },
        uSeed: { value: seed },
        uCool: { value: 0 },
        uShell: { value: 0 },
        uClip: { value: 1000 },
      },
      vertexShader: PLUME_VERT,
      fragmentShader: PLUME_FRAG,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      transparent: true,
      defines,
    })

  const plume1 = hangingQuad(plumeMat(1.7), 12)
  plume1.position.set(0, DIM.nozzle1Exit + 0.06, 0.6)
  v.stage1.add(plume1)
  const plume2 = hangingQuad(plumeMat(5.3), 12)
  plume2.position.set(0, DIM.nozzle2Exit + 0.04, 0.6)
  plume2.material.uniforms.uNozzle.value = DIM.nozzle2R
  plume2.material.uniforms.uVac.value = 1
  plume2.material.uniforms.uCool.value = 1
  plume2.material.uniforms.uDiamonds.value = 0
  v.stage2.add(plume2)

  const glow1 = glowSprite([1, 0.5, 0.2], 13)
  glow1.position.set(0, DIM.nozzle1Exit - 0.3, 0.7)
  v.stage1.add(glow1)
  const glow2 = glowSprite([1, 0.62, 0.35], 13)
  glow2.position.set(0, DIM.nozzle2Exit - 0.2, 0.7)
  v.stage2.add(glow2)
  const payloadGlow = glowSprite([0.35, 0.7, 1], 14)
  v.stage2.add(payloadGlow)

  const vaporU = { uTime: skyU.uTime, uAmt: { value: 0 }, uSize: { value: new THREE.Vector2(3.6, 1.7) } }
  const vapor = hangingQuad(
    new THREE.ShaderMaterial({
      uniforms: vaporU,
      vertexShader: PLUME_VERT,
      fragmentShader: VAPOR_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      defines,
    }),
    11,
  )
  vapor.scale.set(3.6, 1.7, 1)
  vapor.position.set(0, DIM.shoulder - 0.05, 0.7)
  v.stage2.add(vapor)

  // --- smoke, steam & separation gas -------------------------------------------
  const smokeU = {
    uTime: skyU.uTime,
    uLit: { value: new THREE.Color(0.84, 0.88, 0.94) },
    uShade: { value: new THREE.Color(0.2, 0.25, 0.34) },
    uHeat: { value: new THREE.Color(1.0, 0.45, 0.16) },
    uLightDir: { value: new THREE.Vector2(0.7, 0.55) },
    __defines: defines,
  }
  const smokeCount = budget.trench + budget.column + budget.vent
  const smoke = puffSystem(smokeCount, smokeU, 5)
  scene.add(smoke.mesh)

  const rand = seededRandom(7331)
  const particles = []
  for (let i = 0; i < budget.trench; i++) {
    const r = rand()
    particles.push({
      kind: 0,
      tb: -2.9 + 12.5 * Math.pow(r, 1.7),
      dir: i % 2 ? 1 : -1,
      v0: 4.2 + 6 * rand(),
      tau: 1.1 + 1.6 * rand(),
      rise: 0.18 + 0.45 * rand(),
      x0: (i % 2 ? 1 : -1) * (0.5 + 0.4 * rand()),
      y0: -0.5 + 0.25 * rand(),
      z: -2 + 4.2 * rand(),
      s0: 0.8 + 1.1 * rand(),
      growth: 0.9 + 1.5 * rand(),
      seed: rand(),
    })
  }
  for (let i = 0; i < budget.column; i++) {
    particles.push({
      kind: 1,
      tb: 0.15 + 13 * Math.pow(rand(), 1.25),
      dir: rand() < 0.5 ? -1 : 1,
      spread: 0.25 + 0.5 * rand(),
      z: -0.8 + 1.6 * rand(),
      s0: 0.7 + 0.7 * rand(),
      growth: 0.6 + 1.0 * rand(),
      seed: rand(),
    })
  }
  for (let i = 0; i < budget.vent; i++) {
    particles.push({
      kind: 2,
      side: i % 3 === 0 ? -1 : 1,
      y0: 4.6 + 1.1 * rand(),
      phase: rand() * 5,
      seed: rand(),
      z: 0.2 + 0.4 * rand(),
    })
  }

  // Separation gas ring + fairing pyro puffs live in the vehicle frame.
  const puffU = {
    uTime: skyU.uTime,
    uLit: { value: new THREE.Color(0.95, 0.96, 1.0) },
    uShade: { value: new THREE.Color(0.35, 0.42, 0.55) },
    uHeat: { value: new THREE.Color(0, 0, 0) },
    uLightDir: { value: new THREE.Vector2(0.9, 0.3) },
    __defines: defines,
  }
  const puffs = puffSystem(budget.puffs, puffU, 6)
  v.vehicle.add(puffs.mesh)
  const puffSeeds = Array.from({ length: budget.puffs }, () => ({ a: rand() * Math.PI * 2, s: rand(), r: rand() }))

  // --- framing -------------------------------------------------------------------
  let layout = LAYOUTS.wide
  let aspect = 1
  let width = 1
  let height = 1
  let copyShift = 0

  /** `copyInset`: px the copy column sits right of the HUD gutter (centred content grid on very wide screens). */
  function resize(w, h, copyInset = copyShift) {
    width = Math.max(1, w)
    height = Math.max(1, h)
    copyShift = copyInset
    aspect = width / height
    layout = aspect >= 0.9 ? LAYOUTS.wide : LAYOUTS.tall
    // copy sits left on wide screens, on top on tall ones: keep the near clouds off it
    const shift = (2 * copyShift) / width
    if (layout === LAYOUTS.wide) fgU.uClear.value.set(0, -0.42 + shift, -0.08 + shift, 1)
    else fgU.uClear.value.set(1, 0.2, 0.45, 0)
    renderer.setPixelRatio(pixelRatio * renderScale)
    renderer.setSize(width, height, false)
    camera.aspect = aspect
    camera.updateProjectionMatrix()
    const size = renderer.getDrawingBufferSize(new THREE.Vector2())
    skyU.uRes.value.copy(size)
    skyU.uPxScale.value = pixelRatio * renderScale
  }

  // --- per-frame state -------------------------------------------------------------
  let disposed = false
  let idleFlow = 0
  let breath = 0
  // Wall-clock "kicks": a flash, shock ring and camera jolt that play once
  // when an ignition beat is crossed going forward, however fast the scroll.
  let lastP = -1
  let kick1At = -1e3
  let kick2At = -1e3
  const tmpV3 = new THREE.Vector3()
  const nozzle1World = new THREE.Vector3()
  const n1q = new THREE.Vector2()
  const fq = new THREE.Vector2()
  /** World point (rocket plane) → aspect-scaled screen space used by the quads. */
  const toQ = (world, camX, camY, hv, out) => out.set((world.x - camX) / (hv / 2), (world.y - camY) / (hv / 2))

  function frame(p, time, dt) {
    const L = layout
    if (lastP >= 0 && p > lastP && p - lastP < 0.15) {
      if (lastP < BEATS.ignition && p >= BEATS.ignition) kick1At = time
      if (lastP < BEATS.ses && p >= BEATS.ses) kick2At = time
    }
    lastP = p
    const k1Age = time - kick1At
    const k2Age = time - kick2At
    const kick1 = p >= BEATS.ignition && p < BEATS.liftoff + 0.03 && k1Age >= 0 ? Math.exp(-k1Age / 0.45) : 0
    const kick2 = p >= BEATS.ses && p < BEATS.ses + 0.08 && k2Age >= 0 ? Math.exp(-k2Age / 0.32) : 0
    const T = missionTime(p)
    const altKm = T > 0 ? altitudeAt(T) : 0
    const rocketY = rocketYAt(T)
    const skyPhase = p >= BEATS.orbit ? Math.max(skyPhaseAt(altKm), 0.97) : skyPhaseAt(altKm)

    // ---- engines -------------------------------------------------------------------
    let power1 = 0
    if (p >= BEATS.ignition && p < BEATS.meco + 0.008) {
      power1 = 0.55 * smooth(BEATS.ignition, BEATS.ignition + 0.006, p) + 0.45 * smooth(BEATS.ignition + 0.004, BEATS.liftoff, p)
      power1 *= 1 - 0.14 * window4(p, BEATS.maxq - 0.045, BEATS.maxq - 0.02, BEATS.maxq + 0.02, BEATS.maxq + 0.045) // throttle bucket
      const cut = smooth(BEATS.meco, BEATS.meco + 0.007, p)
      power1 *= 1 - cut
      if (cut > 0 && cut < 1) power1 *= 0.7 + 0.3 * Math.sin(time * 60)
    }
    let power2 = 0
    if (p >= BEATS.ses) {
      power2 = smooth(BEATS.ses, BEATS.ses + 0.006, p) * (1 - smooth(BEATS.seco, BEATS.seco + 0.006, p))
    }
    const ignite2 = p >= BEATS.ses ? Math.exp(-(p - BEATS.ses) / 0.006) * (p < BEATS.ses + 0.04 ? 1 : 0) : 0
    const ignite1 = p >= BEATS.ignition ? Math.exp(-(p - BEATS.ignition) / 0.006) * (p < BEATS.ignition + 0.04 ? 1 : 0) : 0

    // ---- separation choreography ------------------------------------------------------
    const sepT = clamp((p - BEATS.sep) / 0.12)
    const fairT = clamp((p - BEATS.fairing) / 0.065)
    const deployT = smooth(BEATS.orbit - 0.005, 0.99, p)

    // ---- vehicle pose ------------------------------------------------------------------
    const tilt = pitchAt(p)
    // payload rides forward off the spent upper stage once in orbit
    const payloadY = DIM.payloadY + 3.6 * Math.pow(deployT, 1.3)
    const focusLocal = lerp(
      lerp(5.1, 8.25, smooth(BEATS.sep, BEATS.ses + 0.03, p)),
      payloadY,
      smooth(BEATS.seco + 0.02, BEATS.orbit + 0.04, p),
    )
    pivot.rotation.z = -tilt
    v.vehicle.position.set(0, -focusLocal, 0)

    // stage 1: springs clear along the axis, then drops back, tumbles end over
    // end and dwindles into the distance (instead of sliding under the HUD)
    if (sepT > 0) {
      const fall = Math.pow(sepT, 1.45)
      const push = easeOut(sepT * 5)
      // (vehicle frame: +x drift cancels the pitch-over so it drops down-right on screen)
      v.stage1.position.set(11 * fall, -0.5 * push - 15 * fall, -30 * fall)
      v.stage1.rotation.set(1.2 * fall, 0.4 * fall, -2.6 * fall)
      v.stage1.visible = sepT < 1
    } else {
      v.stage1.position.set(0, 0, 0)
      v.stage1.rotation.set(0, 0, 0)
      v.stage1.visible = true
    }

    // fairing clamshell
    const f = easeOut(fairT)
    const fd = fairT * fairT
    v.hingeR.rotation.set(0.6 * fd, 0, -1.1 * f - 1.4 * fd)
    v.hingeL.rotation.set(-0.5 * fd, 0, 1.1 * f + 1.2 * fd)
    v.hingeR.position.set(DIM.R + 3.2 * fd, DIM.stage2Top - 3.6 * fd, 0.6 * fd)
    v.hingeL.position.set(-DIM.R - 3.0 * fd, DIM.stage2Top - 3.9 * fd, -0.6 * fd)
    v.hingeR.visible = v.hingeL.visible = fairT < 1

    // payload: revealed by the fairing, released and unfolded in orbit
    const pu = v.payload.uniforms
    v.payload.group.visible = fairT > 0
    pu.uTime.value = time
    pu.uAlpha.value = smooth(0, 0.35, fairT)
    pu.uUnfold.value = deployT
    pu.uPx.value = (3.2 + 2.5 * deployT) * pixelRatio * renderScale * (height / 900) ** 0.5
    v.payload.group.position.set(0, payloadY, 0)
    v.payload.group.rotation.set(0.35 + time * 0.03, time * 0.12, -tilt * 0.5)
    // orbit traces bloom around the payload as it unfolds
    v.payload.rings.position.set(0, payloadY, 0)
    v.payload.rings.rotation.y = time * 0.05
    v.payload.rings.scale.setScalar(0.9 + 0.3 * deployT)
    v.payload.setRings(smooth(0.25, 0.85, deployT) * 0.9)
    // the spent upper stage drifts off with a lazy tumble
    const drift = Math.pow(deployT, 1.6)
    v.hull.rotation.set(0.35 * drift, 0, 0.18 * drift)
    v.hull.position.set(-0.9 * drift, DIM.hullY - 2.4 * drift, -6 * drift)
    payloadGlow.visible = v.payload.group.visible
    payloadGlow.position.set(0, payloadY, 0.8)
    payloadGlow.scale.setScalar(1.6 + 4.5 * deployT)
    payloadGlow.material.uniforms.uAlpha.value = (0.3 + 0.5 * deployT) * pu.uAlpha.value

    // ---- plumes ----------------------------------------------------------------------
    const u1 = plume1.material.uniforms
    const vac1 = smooth(8, 70, altKm)
    u1.uPower.value = power1
    u1.uVac.value = vac1 * 0.8
    u1.uDiamonds.value = 1 - smooth(4, 22, altKm)
    const len1 = lerp(10.5, 9, vac1) * (0.35 + 0.65 * power1)
    const wid1 = lerp(4.2, 9.5, vac1)
    u1.uSize.value.set(wid1, len1)
    plume1.scale.set(wid1, len1, 1)
    plume1.visible = power1 > 0.001
    // distance from the nozzle to the deck while the vehicle is still near the pad
    // (the trench floor sits at y ≈ −0.5; the vehicle is still vertical here)
    const nozzle1Y = rocketY + DIM.nozzle1Exit + 0.06
    u1.uClip.value = p < 0.2 ? Math.max(0.05, nozzle1Y + 0.5) : 1000

    const u2 = plume2.material.uniforms
    u2.uPower.value = power2
    u2.uShell.value = smooth(BEATS.ses + 0.01, BEATS.ses + 0.05, p) * (1 - smooth(BEATS.seco - 0.05, BEATS.seco, p))
    const len2 = 9.5 * (0.45 + 0.55 * power2)
    const wid2 = 10
    u2.uSize.value.set(wid2, len2)
    plume2.scale.set(wid2, len2, 1)
    plume2.visible = power2 > 0.001
    v.nozzle2Mat.emissiveIntensity = 1.6 * smooth(BEATS.ses, BEATS.ses + 0.05, p) * (1 - smooth(BEATS.seco, BEATS.seco + 0.05, p))

    const bloom1 = Math.max(ignite1, kick1)
    const bloom2 = Math.max(ignite2, kick2)
    glow1.scale.setScalar(5.5 + 3 * bloom1)
    glow1.material.uniforms.uAlpha.value = power1 * 0.55 + bloom1 * 0.8
    glow1.visible = glow1.material.uniforms.uAlpha.value > 0.002
    glow2.scale.setScalar(3.6 + 9 * bloom2)
    glow2.material.uniforms.uAlpha.value = power2 * 0.4 + bloom2 * 1.4
    glow2.visible = glow2.material.uniforms.uAlpha.value > 0.002

    vaporU.uAmt.value = window4(p, BEATS.maxq - 0.06, BEATS.maxq - 0.035, BEATS.maxq + 0.005, BEATS.maxq + 0.025) * (0.75 + 0.25 * Math.sin(time * 5.3))
    vapor.visible = vaporU.uAmt.value > 0.002

    // ---- camera ----------------------------------------------------------------------
    const flyT = smooth(BEATS.liftoff + 0.02, 0.18, p)
    const s2T = smooth(BEATS.sep + 0.01, BEATS.ses + 0.05, p)
    const orbT = smooth(BEATS.seco, 0.95, p)
    let hv = lerp(L.padHv, L.flyHv, flyT)
    hv = lerp(hv, L.s2Hv, s2T)
    hv = lerp(hv, L.orbHv, orbT)
    let ax = lerp(L.padAx, L.flyAx, flyT)
    ax = lerp(ax, L.s2Ax, s2T)
    ax = lerp(ax, L.orbAx, orbT)
    let ay = lerp(L.padAy, L.flyAy, flyT)
    ay = lerp(ay, L.s2Ay, s2T)
    ay = lerp(ay, L.orbAy, orbT)

    const focusY = rocketY + focusLocal
    pivot.position.set(0, focusY, 0)
    const padCamY = -0.55 - L.padGround * (L.padHv / 2)
    const followCamY = focusY - ay * (hv / 2)
    const camY0 = smax(padCamY, followCamY, 3)

    // subtle buffeting at liftoff and Max-Q (never under reduced motion — this scene isn't used then)
    const shakeAmp =
      0.05 * window4(p, BEATS.liftoff - 0.004, BEATS.liftoff + 0.004, 0.1, 0.13) +
      0.06 * window4(p, BEATS.maxq - 0.045, BEATS.maxq - 0.02, BEATS.maxq + 0.015, BEATS.maxq + 0.035) +
      0.05 * kick1 +
      0.07 * kick2
    const shakeX = shakeAmp * (Math.sin(time * 37.1) * 0.6 + Math.sin(time * 23.7 + 1.3) * 0.4)
    const shakeY = shakeAmp * (Math.sin(time * 31.3 + 0.7) * 0.6 + Math.sin(time * 19.1) * 0.4)

    const camX = -ax * (hv / 2) * aspect + shakeX
    const camY = camY0 + shakeY
    const dist = hv / (2 * TAN)
    camera.position.set(camX, camY, dist)
    camera.near = Math.max(0.5, dist - 40)
    camera.far = dist + 60
    camera.updateProjectionMatrix()

    // ---- world flow (sense of speed, alive at rest) -------------------------------------
    const speedFactor = 0.35 * smooth(0.1, 0.2, p) + 0.65 * smooth(0.2, 0.45, p) - 0.85 * smooth(0.6, 0.9, p)
    idleFlow += dt * Math.max(0.05, speedFactor) * 0.8
    const flow = p * 60 + idleFlow
    skyU.uFlow.value = flow
    skyU.uTime.value = time

    // ---- sky uniforms -----------------------------------------------------------------
    pivot.updateMatrixWorld(true)
    v.stage1.localToWorld(nozzle1World.set(0, DIM.nozzle1Exit, 0))
    toQ(nozzle1World, camX, camY, hv, n1q)

    skyU.uCam.value.set(camX, camY)
    skyU.uViewH.value = hv
    skyU.uSky.value = skyPhase
    skyU.uStars.value = smooth(0.28, 0.55, p)
    const horizon = L.horizon - ((camY - padCamY) * 0.28) / (hv / 2)
    skyU.uHorizon.value = horizon
    skyU.uGround.value = horizon > -1.3 ? 1 : 0
    skyU.uSunX.value = aspect * 0.85
    skyU.uFire.value = power1 * (1 - smooth(0.12, 0.17, p)) + ignite1 * 0.6
    skyU.uFirePos.value.set(nozzle1World.x, nozzle1World.y)
    skyU.uFlood.value = 1 - smooth(0.1, 0.16, p)
    skyU.uArm.value = smooth(0.006, 0.034, p)
    skyU.uUmb.value = smooth(BEATS.liftoff - 0.003, BEATS.liftoff + 0.008, p)

    // cloud decks drift down past the camera during the climb
    const cloudsOn = p > 0.12 && p < 0.29
    skyU.uCloudAmt.value = cloudsOn ? 1 : 0
    skyU.uCloudY.value.set(lerp(1.6, -1.7, smooth(0.13, 0.26, p)), lerp(2.2, -2.3, smooth(0.14, 0.27, p)))
    fgU.uCloudAmt.value = cloudsOn ? 0.92 : 0
    fgU.uCloudY.value = lerp(2.6, -2.8, smooth(0.155, 0.245, p))

    // exhaust trail behind stage 1
    const heading = [Math.sin(tilt), Math.cos(tilt)]
    skyU.uTrailA.value.set(n1q.x - heading[0] * 0.25, n1q.y - heading[1] * 0.25)
    skyU.uTrailDir.value.set(-heading[0], -heading[1])
    skyU.uTrailLen.value = Math.max(0, Math.min(6, (nozzle1World.y + 0.3) / (hv / 2) - 0.25))
    skyU.uTrailAmt.value = smooth(BEATS.liftoff + 0.006, 0.1, p) * (1 - smooth(BEATS.meco - 0.03, BEATS.meco + 0.01, p))
    skyU.uTrailLit.value = smooth(0.26, 0.38, p)

    // Earth's limb and sunrise
    // Earth arrives as a flat, hazy horizon just above the cloud deck and
    // curves into a planet by orbit (radius eases geometrically).
    skyU.uEarth.value = smooth(0.215, 0.26, p)
    skyU.uEarthR.value = Math.exp(lerp(Math.log(40), Math.log(L.earthR), smooth(0.24, 0.86, p)))
    skyU.uEarthTop.value = lerp(lerp(-1.3, L.horizonFly, smooth(0.215, 0.29, p)), L.earthTop, smooth(0.5, 0.86, p))
    skyU.uNight.value = smooth(0.36, 0.66, p)
    skyU.uSun.value = smooth(BEATS.orbit - 0.02, BEATS.orbit + 0.1, p)
    // the limb warms through the second-stage burn, anticipating sunrise
    skyU.uDawn.value = smooth(BEATS.fairing, BEATS.orbit, p)
    skyU.uSunA.value = L.sunA

    // ---- foreground -------------------------------------------------------------------
    const second = p >= BEATS.sep
    fgU.uFlash.value = second ? Math.max(ignite2 * 0.35, kick2 * 0.42) : Math.max(ignite1 * 0.12, kick1 * 0.2)
    // second-stage light is white-hot; first-stage ignition is warm
    fgU.uFlashCol.value.setRGB(1, second ? 0.92 : 0.72, second ? 0.85 : 0.5)
    const flashPos = second ? v.stage2.localToWorld(tmpV3.set(0, DIM.nozzle2Exit, 0)) : nozzle1World
    fgU.uFirePos.value.copy(toQ(flashPos, camX, camY, hv, fq))
    fgU.uFire.value = power1
    // a thin shock ring races out from the upper-stage nozzle at ignition
    const ringAge = second && kick2 > 0 ? k2Age : 9
    fgU.uRing.value.set(0.03 + 1.25 * easeOut(ringAge / 1.5), 0.01 + 0.04 * ringAge, Math.exp(-ringAge / 0.6) * (ringAge < 2.2 ? 1 : 0))
    fg.visible = cloudsOn || fgU.uFlash.value > 0.001 || fgU.uRing.value.z > 0.002

    // ---- lights ----------------------------------------------------------------------
    const spaceT = smooth(0.36, 0.62, p)
    hemi.intensity = lerp(lerp(0.55, 1.0, smooth(0.08, 0.2, p)), 0.12, spaceT)
    hemi.color.setRGB(lerp(0.42, 0.45, spaceT), lerp(0.57, 0.6, spaceT), lerp(0.77, 0.95, spaceT))
    sun.intensity = lerp(lerp(1.1, 2.0, smooth(0.08, 0.24, p)), 2.8, spaceT)
    const rimT = smooth(BEATS.liftoff, 0.2, p)
    sun.position.set(lerp(5, 6, rimT), lerp(1.2, 2.5, rimT), lerp(-3.5, 3, rimT))
    sun.color.setRGB(1, lerp(0.86, 0.97, spaceT), lerp(0.72, 0.94, spaceT))
    flood.intensity = 0.95 * (1 - smooth(0.1, 0.17, p)) + 0.12
    v.rim.color.value.setRGB(0.1, 0.32, 0.75).multiplyScalar(lerp(0.55, 0.8, smooth(0.1, 0.4, p)) * (1 - 0.4 * spaceT))
    const firePos = power2 > power1 ? v.stage2.localToWorld(tmpV3.set(0, DIM.nozzle2Exit - 0.4, 0.6)) : v.stage1.localToWorld(tmpV3.set(0, DIM.nozzle1Exit - 0.5, 0.8))
    fire.position.copy(firePos)
    fire.intensity = 22 * power1 + 6 * power2 + 30 * Math.max(bloom1, bloom2)
    // the small vacuum engine only lights its own nozzle, not the fairing interior
    fire.distance = power2 > power1 ? 3 : 0

    // ---- smoke & steam (world space) -----------------------------------------------------
    const groundSmoke = p < 0.2
    smoke.mesh.visible = groundSmoke
    if (groundSmoke) {
      if (p > BEATS.ignition && p < 0.16) breath = Math.min(breath + dt * 0.18, 5)
      const ventAmt = 1 - smooth(BEATS.ignition - 0.01, BEATS.liftoff, p)
      const fireAmt = power1 * (1 - smooth(0.12, 0.17, p))
      particles.forEach((pt, i) => {
        let x = 0
        let y = 0
        let z = pt.z
        let size = 0
        let alpha = 0
        let heat = 0
        if (pt.kind === 0 || pt.kind === 1) {
          const age = T - pt.tb + (T > pt.tb ? breath : 0)
          if (age > 0) {
            if (pt.kind === 0) {
              const k = 1 - Math.exp(-age / pt.tau)
              x = pt.x0 + pt.dir * pt.v0 * pt.tau * k
              y = pt.y0 + 0.6 * k + pt.rise * Math.pow(age, 0.85)
              size = pt.s0 + pt.growth * Math.sqrt(age)
              alpha = smooth(0, 0.4, age) * (1 - smooth(22, 40, age)) * 0.82
            } else {
              const ny = rocketYAt(pt.tb) + DIM.nozzle1Exit - 0.4
              x = pt.dir * pt.spread * Math.sqrt(age) * 0.9
              y = ny + 0.12 * age - 0.25 * Math.min(age, 2)
              size = pt.s0 + pt.growth * Math.sqrt(age)
              alpha = smooth(0, 0.6, age) * (1 - smooth(18, 34, age)) * 0.6
            }
            const dx = x - nozzle1World.x
            const dy = y - nozzle1World.y
            heat = fireAmt * Math.exp(-Math.sqrt(dx * dx + dy * dy) / 2.6) * 1.3
          }
        } else {
          // cryogenic venting before ignition: cold vapor curling down the tank
          const period = 5
          const age = (time + pt.phase) % period
          x = pt.side * (0.44 + 0.22 * age)
          y = pt.y0 - 0.32 * age
          size = 0.18 + 0.32 * age
          alpha = 0.32 * Math.sin((Math.PI * age) / period) * ventAmt
        }
        smoke.pos[i * 3] = x
        smoke.pos[i * 3 + 1] = y
        smoke.pos[i * 3 + 2] = z
        smoke.data[i * 4] = size
        smoke.data[i * 4 + 1] = alpha
        smoke.data[i * 4 + 2] = pt.seed
        smoke.data[i * 4 + 3] = heat
      })
      smoke.commit()
      smokeU.uLit.value.setRGB(0.8 + 0.08 * fireAmt, 0.85, 0.92)
    }

    // ---- separation gas ring (vehicle frame) ------------------------------------------
    const puffAge = (p - BEATS.sep) * 70
    puffs.mesh.visible = puffAge > 0 && puffAge < 3
    if (puffs.mesh.visible) {
      puffSeeds.forEach((s, i) => {
        const age = puffAge * (0.7 + 0.5 * s.r)
        const rad = 0.45 + 1.1 * Math.sqrt(age) * (0.6 + 0.6 * s.s)
        puffs.pos[i * 3] = Math.cos(s.a) * rad
        puffs.pos[i * 3 + 1] = DIM.interTop - 0.4 * age - 0.1 + v.stage1.position.y * 0.15
        puffs.pos[i * 3 + 2] = Math.sin(s.a) * rad
        puffs.data[i * 4] = 0.35 + 0.9 * age
        puffs.data[i * 4 + 1] = 0.3 * smooth(0, 0.12, age) * (1 - smooth(0.5, 2.2, age))
        puffs.data[i * 4 + 2] = s.s
        puffs.data[i * 4 + 3] = 0
      })
      puffs.commit()
    }

    renderer.render(scene, camera)
  }

  return {
    renderer,
    resize,
    frame,
    /** Adaptive resolution: 1 = full tier pixel ratio. */
    setScale(scale) {
      if (Math.abs(scale - renderScale) < 0.01) return
      renderScale = scale
      resize(width, height)
    },
    /** Compile shaders off the critical path (parallel compile where supported). */
    warm() {
      if (renderer.extensions.has('KHR_parallel_shader_compile')) return renderer.compileAsync(scene, camera).catch(() => {})
      // No parallel compile: do it when the main thread is idle instead.
      return new Promise((resolve) => {
        const idle = window.requestIdleCallback || ((cb) => setTimeout(cb, 200))
        idle(() => {
          // (the context may have been lost, and the scene disposed, in the meantime)
          if (!disposed) renderer.compile(scene, camera)
          resolve()
        })
      })
    },
    dispose() {
      disposed = true
      v.dispose()
      scene.traverse((obj) => {
        obj.geometry?.dispose?.()
        if (obj.material && !obj.material.isMeshStandardMaterial) obj.material.dispose?.()
      })
      renderer.dispose()
    },
  }
}
