/**
 * Hero WebGL scene: Earth from low orbit at orbital sunrise.
 *
 * Draw order (no depth buffer needed):
 *   1. full-screen ray-traced pass — sky, planet, atmosphere limb, sun, lens
 *   2. stars (additive points, occluded analytically by the planet)
 *   3. neural filaments (additive lines with travelling pulses)
 *   4. neural nodes (additive points)
 *
 * The scene reads a plain `state` object that hero.js animates with GSAP
 * (intro + scroll), so choreography lives in one place and the render loop
 * only ever reads numbers.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  LineSegments,
  Matrix3,
  Matrix4,
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three'
import { createRenderLoop, observeVisibility } from '../../lib/visibility.js'
import { byTier, dpr, isTouch, reducedMotion, tier } from '../../lib/quality.js'
import { clamp, lerp, seededRandom } from '../../lib/dom.js'
import * as GLSL from './shaders.js'
import { buildNetwork, createKeep } from './network.js'

const DEG = Math.PI / 180
const SUN_R = 7 // sun disc radius, CSS px

const smooth = (t) => t * t * (3 - 2 * t)
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

/**
 * Composition per aspect ratio. Desktop: a wide, gently curving limb low in
 * frame. Phone portrait: higher orbit (more curvature), limb lower and larger.
 */
export function framing(aspect) {
  const k = smooth(clamp((aspect - 0.5) / (1.65 - 0.5)))
  return {
    alt: lerp(0.4, 0.082, k),
    fov: lerp(60, 34, k),
    horizonY: lerp(-0.3, -0.42, k), // NDC y of the horizon at frame centre
    roll: lerp(-3, -5, k) * DEG,
    sunX: lerp(0.26, 0.4, k), // NDC x of the sun
  }
}

/** Positions `camera` for a framing + motion offsets. Returns derived values. */
function poseCamera(camera, f, { rise = 0, push = 0, yaw = 0, pitch = 0, roll = 0 } = {}) {
  const alt = f.alt * (1 + 0.16 * rise) * (1 - 0.06 * push)
  const delta = Math.acos(1 / (1 + alt)) // horizon depression
  const tanHalf = Math.tan((f.fov * DEG) / 2)
  const basePitch = -delta - Math.atan(f.horizonY * tanHalf)
  camera.position.set(0, 1 + alt, 0)
  camera.rotation.set(
    basePitch + rise * 2.4 * DEG - push * 1.6 * DEG + pitch,
    yaw,
    f.roll * (1 - 0.4 * rise) + roll,
    'YXZ',
  )
  camera.updateMatrixWorld()
  return { alt, delta, tanHalf }
}

const sunDirection = (az, el, out) =>
  out.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el))

export function createHeroScene({ root, canvas, state, onReady, onFrame }) {
  const renderer = new WebGLRenderer({
    canvas,
    // MSAA only where pixels are big (DPR ≈ 1): it smooths the 1px filaments
    // and costs nothing in the full-screen pass
    antialias: dpr < 1.5 && tier !== 'low',
    alpha: false,
    depth: false,
    stencil: false,
    powerPreference: 'high-performance',
    // A single still frame (reduced motion) must survive compositing
    preserveDrawingBuffer: reducedMotion,
  })
  renderer.setClearColor(0x000000, 1)
  renderer.autoClear = true

  const scene = new Scene()
  const camera = new PerspectiveCamera(36, 1, 0.0005, 1000)
  camera.rotation.order = 'YXZ'

  /* ---- quality ----------------------------------------------------------- */
  const maxPR = dpr
  const minPR = Math.min(1, dpr)
  // Pixel budget for the full-screen pass, so huge displays stay smooth
  const MAX_PIXELS = byTier({ high: 4.6e6, medium: 2.8e6, low: 1.6e6 })
  let pixelRatio = maxPR

  /* ---- 1. full-screen sky / planet pass ---------------------------------- */
  const skyUniforms = {
    uRes: { value: new Vector2(1, 1) },
    uPR: { value: 1 },
    uInvProj: { value: camera.projectionMatrixInverse },
    uCamWorld: { value: camera.matrixWorld },
    uCamPos: { value: camera.position },
    uSunDir: { value: new Vector3(0, 0, -1) },
    uSunPx: { value: new Vector2() },
    uLimbDir: { value: new Vector2(1, 0) },
    uSunVis: { value: 0 },
    uSunR: { value: SUN_R },
    uDh: { value: 0.4 },
    uPixAngle: { value: 0.0007 },
    uTime: { value: 0 },
    uLight: { value: 0 },
    uReveal: { value: 0 },
    uFlare: { value: 0 },
    uRise: { value: 0 },
    uCrest: { value: 0 },
    uCloudRot: { value: new Matrix3() },
    uGalN: { value: new Vector3(0, 0, 1) },
  }
  const sky = new Mesh(
    new PlaneGeometry(2, 2),
    new ShaderMaterial({
      vertexShader: GLSL.fullscreenVertex,
      fragmentShader: GLSL.skyFragment,
      uniforms: skyUniforms,
      defines: { CLOUD_OCTAVES: byTier({ high: 5, medium: 4, low: 3 }) },
      depthTest: false,
      depthWrite: false,
    }),
  )
  sky.frustumCulled = false
  sky.renderOrder = 0
  scene.add(sky)

  /* ---- 2. stars ------------------------------------------------------------ */
  const shared = {
    uTime: skyUniforms.uTime,
    uPR: skyUniforms.uPR,
    uLight: skyUniforms.uLight,
    uSunDir: skyUniforms.uSunDir,
    uDh: skyUniforms.uDh,
    uPixAngle: skyUniforms.uPixAngle,
  }
  const STAR_COUNT = byTier({ high: 7000, medium: 5000, low: 3000 })
  const starPoints = new Points(
    new BufferGeometry(),
    new ShaderMaterial({
      vertexShader: GLSL.starVertex,
      fragmentShader: GLSL.starFragment,
      uniforms: shared,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: AdditiveBlending,
    }),
  )
  starPoints.frustumCulled = false
  starPoints.renderOrder = 1
  scene.add(starPoints)

  /* ---- 3/4. neural network (rebuilt when the composition changes) --------- */
  const netUniforms = {
    ...shared,
    uNet: { value: 0 },
    uPxPerUnit: { value: 1000 },
    uNodeScale: { value: 1 },
    uFocus: { value: new Vector3(0, 0, 0) },
    uAspect: { value: 1 },
  }
  const linkMaterial = new ShaderMaterial({
    vertexShader: GLSL.linkVertex,
    fragmentShader: GLSL.linkFragment,
    uniforms: netUniforms,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: AdditiveBlending,
  })
  const nodeMaterial = new ShaderMaterial({
    vertexShader: GLSL.nodeVertex,
    fragmentShader: GLSL.nodeFragment,
    uniforms: netUniforms,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: AdditiveBlending,
  })
  let links = null
  let nodes = null
  let netFraming = null

  // Generation runs in a worker (≈100 ms of maths kept off the main thread);
  // synchronous fallback if workers are unavailable.
  let worker = null
  let requestId = 0
  try {
    worker = new Worker(new URL('./network.worker.js', import.meta.url), { type: 'module' })
    worker.onmessage = ({ data }) => data.id === requestId && applyNetwork(data.net)
    worker.onerror = () => {
      worker?.terminate()
      worker = null
      rebuildNetwork(netFraming)
    }
  } catch {
    worker = null
  }

  function rebuildNetwork(f) {
    netFraming = f
    // Every camera pose the visitor can reach: rest, full sunrise, drift extremes.
    const probe = new PerspectiveCamera(f.fov, camera.aspect, 0.0005, 10)
    probe.rotation.order = 'YXZ'
    const poses = []
    for (const rise of [0, 1]) {
      for (const yaw of [-1, 0, 1]) {
        poseCamera(probe, f, { rise, yaw: yaw * 4.2 * DEG, push: rise ? 0 : 1 })
        const m = new Matrix4().multiplyMatrices(probe.projectionMatrix, probe.matrixWorldInverse)
        poses.push({ m: Array.from(m.elements), pos: probe.position.toArray() })
      }
    }
    const job = {
      id: ++requestId,
      nodes: byTier({ high: 5200, medium: 4000, low: 3000 }),
      metros: byTier({ high: 64, medium: 52, low: 38 }),
      maxTheta: Math.acos(1 / (1 + f.alt * 1.16)) + 0.02,
      poses,
    }
    if (worker) worker.postMessage(job)
    else applyNetwork(buildNetwork({ ...job, keep: createKeep(poses) }))
  }

  function applyNetwork(net) {
    if (links) {
      scene.remove(links, nodes)
      links.geometry.dispose()
      nodes.geometry.dispose()
    }
    const lg = new BufferGeometry()
    lg.setAttribute('position', new BufferAttribute(net.links.position, 3))
    lg.setAttribute('aT', new BufferAttribute(net.links.t, 1))
    lg.setAttribute('aSeed', new BufferAttribute(net.links.seed, 1))
    lg.setAttribute('aKind', new BufferAttribute(net.links.kind, 1))
    lg.setAttribute('aDelay', new BufferAttribute(net.links.delay, 1))
    lg.setDrawRange(0, net.vertexCount)
    links = new LineSegments(lg, linkMaterial)
    links.frustumCulled = false
    links.renderOrder = 2

    const ng = new BufferGeometry()
    ng.setAttribute('position', new BufferAttribute(net.nodes.position, 3))
    ng.setAttribute('aSize', new BufferAttribute(net.nodes.size, 1))
    ng.setAttribute('aBright', new BufferAttribute(net.nodes.bright, 1))
    ng.setAttribute('aSeed', new BufferAttribute(net.nodes.seed, 1))
    ng.setAttribute('aDelay', new BufferAttribute(net.nodes.delay, 1))
    ng.setAttribute('aHalo', new BufferAttribute(net.nodes.halo, 1))
    nodes = new Points(ng, nodeMaterial)
    nodes.frustumCulled = false
    nodes.renderOrder = 3
    scene.add(links, nodes)
    if (staticFrame) redraw()
  }

  /* ---- sizing ---------------------------------------------------------------- */
  let cssW = 1
  let cssH = 1
  let f = framing(1.6)
  let sunAz = 20 * DEG

  function resize() {
    const rect = canvas.parentElement.getBoundingClientRect()
    cssW = Math.max(1, Math.round(rect.width))
    cssH = Math.max(1, Math.round(rect.height))
    pixelRatio = Math.min(pixelRatio, Math.max(0.75, Math.sqrt(MAX_PIXELS / (cssW * cssH))))
    renderer.setPixelRatio(pixelRatio)
    renderer.setSize(cssW, cssH, false)
    camera.aspect = cssW / cssH
    netUniforms.uAspect.value = camera.aspect
    f = framing(camera.aspect)
    camera.fov = f.fov
    camera.updateProjectionMatrix()

    // Solve the sun's azimuth so it sits at the framed screen x
    const probe = new Vector3()
    const solve = (az) => {
      const { delta } = poseCamera(camera, f)
      sunDirection(az, -delta, probe).add(camera.position).project(camera)
      return probe.x
    }
    let lo = -10 * DEG
    let hi = 80 * DEG
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2
      if (solve(mid) < f.sunX) lo = mid
      else hi = mid
    }
    sunAz = (lo + hi) / 2

    // Milky Way: a great circle projects to a straight line on screen, so lay
    // it as a diagonal rising from the right-hand limb toward the top of the
    // frame — a faint counterweight to the headline, clear of the type.
    poseCamera(camera, f)
    const portrait = camera.aspect < 1
    const g1 = new Vector3(1.02, portrait ? -0.12 : -0.2, 0.5).unproject(camera).sub(camera.position)
    const g2 = new Vector3(portrait ? 0.62 : 0.3, 1.04, 0.5).unproject(camera).sub(camera.position)
    const galN = new Vector3().crossVectors(g1, g2).normalize()
    if (!starPoints.geometry.attributes.position || galN.dot(skyUniforms.uGalN.value) < 0.9995) {
      skyUniforms.uGalN.value.copy(galN)
      starPoints.geometry.dispose()
      starPoints.geometry = buildStars(STAR_COUNT, galN)
    }

    skyUniforms.uRes.value.set(cssW * pixelRatio, cssH * pixelRatio)
    skyUniforms.uPR.value = pixelRatio

    // Re-populate the planet only when the composition really changes
    if (!netFraming || Math.abs(netFraming.alt - f.alt) > 0.012 || Math.abs(netFraming.fov - f.fov) > 2.5) {
      rebuildNetwork(f)
    }
    if (staticFrame) redraw()
  }

  // Still-frame mode: draw on the next frame (after layout settles)
  let redrawId = 0
  function redraw() {
    cancelAnimationFrame(redrawId)
    redrawId = requestAnimationFrame(() => draw(lastT, 0))
  }

  /* ---- per-frame --------------------------------------------------------------- */
  const pointer = { x: 0, y: 0, tx: 0, ty: 0, active: false }
  // Cursor attention for the network: follows the pointer quickly, fades in
  // and out softly (desktop pointers only)
  const focus = { x: 0, y: 0, k: 0 }
  const smoothState = { rise: state.progress, push: state.push }
  const tmp = new Vector3()
  const tmpA = new Vector3()
  const tmpB = new Vector3()
  const cloudAxis = new Vector3(0.18, 1, 0.12).normalize()
  const cloudMat4 = new Matrix4()
  let time = 0
  let lastT = 0

  function update(dt) {
    time += dt
    // Critically-damped follow so scroll scrub feels like a camera operator, not a slider
    const k = 1 - Math.exp(-dt * 5)
    smoothState.rise += (state.progress - smoothState.rise) * (dt ? k : 1)
    smoothState.push += (state.push - smoothState.push) * (dt ? k : 1)
    pointer.x += (pointer.tx - pointer.x) * (1 - Math.exp(-dt * 2.2))
    pointer.y += (pointer.ty - pointer.y) * (1 - Math.exp(-dt * 2.2))
    const follow = 1 - Math.exp(-dt * 10)
    focus.x += (pointer.tx - focus.x) * follow
    focus.y += (pointer.ty - focus.y) * follow
    focus.k += ((pointer.active ? 1 : 0) - focus.k) * (1 - Math.exp(-dt * 2.5))

    const rise = easeInOut(clamp(smoothState.rise))
    const drift = reducedMotion ? 0 : 1
    const yaw = (Math.sin(time * 0.045) * 1.6 + Math.sin(time * 0.017 + 1.3) * 1.1) * DEG * drift - pointer.x * 1.4 * DEG
    const pitch = Math.sin(time * 0.031 + 0.4) * 0.22 * DEG * drift - pointer.y * 0.7 * DEG
    const roll = Math.sin(time * 0.023) * 0.35 * DEG * drift

    const { alt, delta, tanHalf } = poseCamera(camera, f, { rise, push: smoothState.push, yaw, pitch, roll })
    const pixAngle = (2 * tanHalf) / cssH
    const dh = Math.sqrt((1 + alt) ** 2 - 1)

    // Sunrise: the sun climbs from just under the limb to a clean crest
    const sunOffPx = lerp(-11, 30, rise)
    const sunEl = -delta + sunOffPx * pixAngle
    sunDirection(sunAz, sunEl, skyUniforms.uSunDir.value)
    const sunVis = smooth(clamp((sunOffPx + SUN_R) / (2 * SUN_R)))
    // The diamond-ring instant: a brief bloom as the disc breaks the limb
    const crest = Math.exp(-(((sunOffPx + 1.5) / 4.5) ** 2))

    // Flare source: the sun, or the brightest point of the limb above it
    sunDirection(sunAz, Math.max(sunEl, -delta + 1.5 * pixAngle), tmp).add(camera.position).project(camera)
    skyUniforms.uSunPx.value.set((tmp.x * 0.5 + 0.5) * cssW * pixelRatio, (tmp.y * 0.5 + 0.5) * cssH * pixelRatio)
    // Limb tangent on screen, so glow and streak lie along the horizon
    sunDirection(sunAz - 2 * DEG, -delta, tmpA).add(camera.position).project(camera)
    sunDirection(sunAz + 2 * DEG, -delta, tmpB).add(camera.position).project(camera)
    skyUniforms.uLimbDir.value.set((tmpB.x - tmpA.x) * cssW, (tmpB.y - tmpA.y) * cssH).normalize()

    cloudMat4.makeRotationAxis(cloudAxis, time * 0.0042 + 0.6)
    skyUniforms.uCloudRot.value.setFromMatrix4(cloudMat4)

    skyUniforms.uTime.value = time
    skyUniforms.uDh.value = dh
    skyUniforms.uPixAngle.value = pixAngle
    skyUniforms.uSunVis.value = sunVis
    skyUniforms.uLight.value = state.light * (1 + 0.12 * rise)
    skyUniforms.uReveal.value = state.reveal
    // Atmospheric scintillation: the flare breathes by a few percent
    const shimmer = 1 + (Math.sin(time * 1.3) * 0.02 + Math.sin(time * 3.7 + 1.1) * 0.012) * drift
    skyUniforms.uFlare.value = state.flare * (1.1 + 0.9 * rise * rise) * shimmer
    skyUniforms.uRise.value = rise
    skyUniforms.uCrest.value = crest * state.light
    netUniforms.uNet.value = state.net
    // (NDC y is up; the pointer is in screen space, y down)
    netUniforms.uFocus.value.set(focus.x, -focus.y, focus.k * state.net * (1 - 0.85 * rise))
    netUniforms.uPxPerUnit.value = cssH / (2 * tanHalf)
    netUniforms.uNodeScale.value = Math.pow(f.alt / 0.082, 0.62)

    // HUD hook: where the sun is (CSS px) and how high above the limb (degrees)
    if (onFrame) {
      frameInfo.x = skyUniforms.uSunPx.value.x / pixelRatio
      frameInfo.y = cssH - skyUniforms.uSunPx.value.y / pixelRatio
      frameInfo.elevation = (sunOffPx * pixAngle) / DEG
      frameInfo.rise = rise
      onFrame(frameInfo)
    }
  }
  const frameInfo = { x: 0, y: 0, elevation: 0, rise: 0 }

  function draw(t, dt) {
    lastT = t
    update(dt)
    renderer.render(scene, camera)
  }

  /* ---- adaptive resolution: protect 60fps on weaker GPUs ------------------------ */
  let frames = 0
  let slow = 0
  function adapt(dt) {
    frames++
    if (frames < 90 || pixelRatio <= minPR) return
    slow = dt > 1 / 42 ? slow + 1 : Math.max(0, slow - 2)
    if (slow > 45) {
      pixelRatio = Math.max(minPR, pixelRatio - 0.25)
      slow = 0
      frames = 30
      resize()
    }
  }

  /* ---- wiring ------------------------------------------------------------------- */
  const staticFrame = reducedMotion
  let loop = null
  const ro = new ResizeObserver(() => resize())
  ro.observe(canvas.parentElement)
  resize()

  const onPointer = (event) => {
    if (event.pointerType === 'touch') return
    pointer.tx = (event.clientX / window.innerWidth) * 2 - 1
    pointer.ty = (event.clientY / window.innerHeight) * 2 - 1
    if (!pointer.active) {
      // Jump the attention spot to where the cursor entered (no sweep in)
      focus.x = pointer.tx
      focus.y = pointer.ty
      pointer.active = true
    }
  }
  const onPointerOut = (event) => {
    if (!event.relatedTarget) pointer.active = false
  }
  if (!isTouch && !reducedMotion) {
    window.addEventListener('pointermove', onPointer, { passive: true })
    document.addEventListener('pointerout', onPointerOut, { passive: true })
  }

  let readyFired = false
  const ready = () => {
    if (readyFired) return
    readyFired = true
    onReady?.()
  }

  let unobserve = null
  if (staticFrame) {
    draw(0, 0)
    redraw()
    unobserve = observeVisibility(root, (visible) => visible && redraw())
    ready()
  } else {
    loop = createRenderLoop(root, (t, dt) => {
      draw(t, dt)
      adapt(dt)
      ready()
    })
  }

  function destroy() {
    worker?.terminate()
    loop?.destroy()
    unobserve?.()
    cancelAnimationFrame(redrawId)
    ro.disconnect()
    window.removeEventListener('pointermove', onPointer)
    document.removeEventListener('pointerout', onPointerOut)
    scene.traverse((obj) => {
      obj.geometry?.dispose()
      obj.material?.dispose()
    })
    renderer.dispose()
  }

  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault()
    loop?.destroy()
    root.dispatchEvent(new CustomEvent('hero:webgl-lost'))
  })

  return {
    destroy,
    /** Re-render a still frame (reduced motion) after state changes. */
    render: () => redraw(),
  }
}

/** Star directions within the region the camera can ever look at. */
function buildStars(count, galN) {
  const rand = seededRandom(2027)
  const position = new Float32Array(count * 3)
  const mag = new Float32Array(count)
  const seed = new Float32Array(count)
  const color = new Float32Array(count * 3)
  const v = new Vector3()
  const AZ = 78 * DEG
  const EL_MIN = -46 * DEG
  const EL_MAX = 62 * DEG
  const sinMin = Math.sin(EL_MIN)
  const sinMax = Math.sin(EL_MAX)
  for (let i = 0; i < count; i++) {
    // Uniform on the sphere patch; half are re-sampled into the galactic
    // plane, so the Milky Way is built from real (crisp) stars, not just haze
    const inBand = i % 2 === 0
    let tries = 0
    do {
      const az = (rand() * 2 - 1) * AZ
      const el = Math.asin(lerp(sinMin, sinMax, rand()))
      sunDirection(az, el, v)
      tries++
    } while (inBand && Math.abs(v.dot(galN)) > 0.11 * rand() * rand() + 0.012 && tries < 48)
    position.set([v.x * 100, v.y * 100, v.z * 100], i * 3)
    // Many faint, few bright
    mag[i] = Math.pow(rand(), inBand ? 7 : 5.5)
    seed[i] = rand()
    const warm = rand()
    const c =
      warm < 0.15 ? [1.0, 0.82, 0.66] : warm < 0.4 ? [1.0, 0.95, 0.88] : warm < 0.85 ? [0.86, 0.92, 1.0] : [0.7, 0.82, 1.0]
    color.set(c, i * 3)
  }
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(position, 3))
  geo.setAttribute('aMag', new BufferAttribute(mag, 1))
  geo.setAttribute('aSeed', new BufferAttribute(seed, 1))
  geo.setAttribute('aColor', new BufferAttribute(color, 3))
  return geo
}
