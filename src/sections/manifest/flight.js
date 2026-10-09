/**
 * FLIGHT MODE — the desktop manifest as one continuous ascent.
 *
 * The frame pins and the track slides left while a trajectory draws itself
 * from the launch pad through every mission patch and out past the top of
 * the frame. The drawing tip ("the vehicle") stays at a fixed point on screen
 * so the camera appears to follow it, trailing a short exhaust-hot segment
 * that cools into the blue line. The planet limb sinks away as the sun rises
 * over it, two star layers parallax, and a HUD reports (simulated) altitude,
 * velocity and downrange.
 *
 * Everything is driven from scroll position through two ScrollTriggers:
 *   pin   — pins the frame for exactly the track's overflow distance;
 *   fly   — from just before the pin until its end; maps scroll → tip.
 * All layout reads happen on refresh (never in the scroll path).
 */
import { ScrollTrigger, scrollToTarget } from '../../lib/motion.js'
import { byTier } from '../../lib/quality.js'
import { $, $$, clamp, lerp, formatNumber } from '../../lib/dom.js'
import { paintStars } from './stars.js'

const SVG_NS = 'http://www.w3.org/2000/svg'
const TIP = 0.62 // tip position across the viewport while pinned
const KARMAN = 0.41 // Kármán line, as a fraction of frame height
const LUT_SIZE = 700
const TRAIL = 230 // length (px) of the exhaust-hot segment behind the vehicle

const svgEl = (tag, attrs = {}) => {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  return el
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

/**
 * @param {HTMLElement} root  the #manifest section
 * @param {Array} missions    parsed missions ({ el, number, name, status, … })
 * @param {{ onReach?: (mission, index) => void }} hooks
 * @returns {() => void} cleanup
 */
export function createFlight(root, missions, { onReach } = {}) {
  const frame = $('[data-manifest-frame]', root)
  const track = $('[data-manifest-track]', root)
  const svg = $('[data-manifest-path]', root)
  const starsEl = $('[data-manifest-stars]', root)
  const planet = $('[data-manifest-planet]', root)
  const padEl = $('.s-manifest__pad', root)
  const altEl = $('[data-hud-alt]', root)
  const drEl = $('[data-hud-dr]', root)
  const velEl = $('[data-hud-vel]', root)
  const sun = $('[data-manifest-sun]', root)
  const karmanLabel = $('.s-manifest__karman-label', root)
  const index = $('[data-manifest-index]', root)
  const beyond = $('[data-manifest-beyond]', root)

  root.classList.add('is-flight')
  root.style.setProperty('--karman', `${KARMAN * 100}%`)
  missions.forEach((m, i) => {
    const u = missions.length > 1 ? i / (missions.length - 1) : 0
    // Gravity-turn feel: climb steeply early, flatten toward orbit.
    m.el.style.setProperty('--t', (1 - (1 - u) ** 1.5).toFixed(4))
  })

  // ---- Trajectory SVG ---------------------------------------------------------
  svg.replaceChildren()
  const defs = svgEl('defs')
  defs.innerHTML = `
    <linearGradient id="manifest-line-grad" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="1000" y2="0">
      <stop offset="0" stop-color="#1f6bff"/>
      <stop offset=".35" stop-color="#6fc3ff"/>
      <stop offset="1" stop-color="#f4f6fb"/>
    </linearGradient>
    <linearGradient id="manifest-plume-grad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#ff6b2c" stop-opacity="0"/>
      <stop offset=".65" stop-color="#ff6b2c" stop-opacity=".85"/>
      <stop offset="1" stop-color="#ffb46b"/>
    </linearGradient>
    <radialGradient id="manifest-head-grad">
      <stop offset="0" stop-color="#c7ecff" stop-opacity=".9"/>
      <stop offset="1" stop-color="#6fc3ff" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="manifest-core-grad">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset=".35" stop-color="#ffe2c4" stop-opacity=".9"/>
      <stop offset="1" stop-color="#ffb46b" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="manifest-flare-grad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#c7ecff" stop-opacity="0"/>
      <stop offset=".5" stop-color="#ffffff" stop-opacity=".85"/>
      <stop offset="1" stop-color="#c7ecff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="manifest-hot-grad" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ff6b2c" stop-opacity="0"/>
      <stop offset=".45" stop-color="#ff6b2c" stop-opacity=".75"/>
      <stop offset=".82" stop-color="#ffb46b"/>
      <stop offset="1" stop-color="#ffffff"/>
    </linearGradient>`
  const ghost = svgEl('path', { class: 's-manifest__line-ghost' })
  const glow = svgEl('path', { class: 's-manifest__line-glow' })
  const line = svgEl('path', { class: 's-manifest__line' })
  // Exhaust-hot segment: a dash exactly TRAIL long that ends at the vehicle,
  // stroked with a gradient re-aimed from its tail to the vehicle each frame.
  const hotGlow = svgEl('path', { class: 's-manifest__line-hot-glow' })
  const hot = svgEl('path', { class: 's-manifest__line-hot' })
  const hotGrad = $('#manifest-hot-grad', defs)
  const ticks = svgEl('g', { class: 's-manifest__line-ticks' })
  // The vehicle: position group (halo + an anamorphic flare that stays level,
  // like a tracking camera's lens) and a rotating group for the plume.
  const head = svgEl('g', { class: 's-manifest__head' })
  head.innerHTML = `
    <circle r="30" fill="url(#manifest-head-grad)" opacity=".5"/>
    <ellipse class="s-manifest__head-flare" rx="64" ry="1.1" fill="url(#manifest-flare-grad)"/>
    <ellipse rx="11" ry=".6" fill="#ffffff" opacity=".6" transform="rotate(90)"/>
    <g class="s-manifest__head-rot">
      <path class="s-manifest__head-plume" d="M2 0 L -46 -3.4 Q -53 0 -46 3.4 Z" fill="url(#manifest-plume-grad)"/>
      <circle r="9" fill="url(#manifest-core-grad)"/>
    </g>
    <circle r="3.2" fill="#ffffff"/>`
  const headRot = $('.s-manifest__head-rot', head)
  svg.append(defs, ghost, glow, line, hotGlow, hot, ticks, head)

  // ---- Ghost numerals: huge outlined mission numbers on a deeper parallax plane
  const GHOST = 0.16
  const ghosts = document.createElement('div')
  ghosts.className = 's-manifest__ghosts'
  ghosts.setAttribute('aria-hidden', 'true')
  ghosts.innerHTML = missions.map((m) => `<span class="s-manifest__ghost" data-status="${esc(m.status)}">${esc(m.number)}</span>`).join('')
  track.before(ghosts)
  const ghostEls = Array.from(ghosts.children)

  // ---- Index (jump-to-mission) ------------------------------------------------
  index.hidden = false
  index.innerHTML = `
    <ol class="s-manifest__index-list" role="list">
      ${missions
        .map(
          (m, i) => `
        <li><button type="button" class="s-manifest__index-btn" data-index="${i}" data-status="${esc(m.status)}">
          <span class="s-manifest__index-num">${esc(m.number)}</span>
          <span class="s-manifest__index-name">${esc(m.name)}</span>
        </button></li>`,
        )
        .join('')}
    </ol>
    <span class="s-manifest__index-rail" aria-hidden="true"><span class="s-manifest__index-fill"></span></span>`
  const indexBtns = $$('.s-manifest__index-btn', index)
  const indexFill = $('.s-manifest__index-fill', index)

  // ---- Layout state (filled on refresh) ---------------------------------------
  const S = {
    vw: 1,
    vh: 1,
    trackW: 1,
    distance: 0,
    padX: 0,
    padY: 0,
    tip0: 0,
    total: 1,
    lut: new Float32Array(0), // [len, x, y] * LUT_SIZE
    stations: [], // { cx, cy, left, r, card: { x0, x1, y0, y1 } }
    label: { x0: 0, x1: 0, y0: 0, y1: 0 }, // Kármán label box (frame coords)
    alt: { a: 1, b: 7 },
  }

  function measure() {
    S.vw = frame.clientWidth
    S.vh = frame.clientHeight
    S.trackW = track.offsetWidth
    S.distance = Math.max(0, S.trackW - S.vw)
    S.padX = padEl.offsetLeft
    S.padY = padEl.offsetTop
    S.tip0 = S.vw * TIP
    S.stations = missions.map((m) => {
      const slot = $('.s-manifest__patch-slot', m.el)
      const card = $('.s-manifest__card', m.el)
      const cx = m.el.offsetLeft
      const cy = m.el.offsetTop
      const r = slot.offsetWidth / 2
      return {
        cx,
        cy,
        r,
        left: cx - r,
        card: { x0: cx + card.offsetLeft, x1: cx + card.offsetLeft + card.offsetWidth, y0: cy + card.offsetTop, y1: cy + card.offsetTop + card.offsetHeight },
      }
    })
    // The Kármán label lives in the fixed HUD; stations slide past it.
    const lineY = KARMAN * S.vh
    S.label = {
      x0: karmanLabel.offsetLeft - 16,
      x1: karmanLabel.offsetLeft + karmanLabel.offsetWidth + 16,
      y0: lineY - karmanLabel.offsetHeight - 14,
      y1: lineY + 4,
    }
    buildPath()
    buildStars()
    // Each ghost lines up with its patch when that station is under the tip.
    S.stations.forEach((st, i) => {
      ghostEls[i].style.left = `${(st.left + GHOST * (st.cx - S.tip0)).toFixed(1)}px`
    })
    // Altitude model (illustrative): exponential in height above the pad,
    // calibrated so the Kármán line on screen reads 100 km.
    const uK = (S.padY - KARMAN * S.vh) / S.padY
    S.alt.a = 100 / (Math.exp(S.alt.b * uK) - 1)
    return S
  }

  /** Smooth path: vertical lift-off from the pad, then a monotone cubic through each patch. */
  function buildPath() {
    const pts = S.stations.map((s) => [s.cx, s.cy])
    const last = pts[pts.length - 1]
    const exit = [S.trackW - S.vw * 0.06, -S.vh * 0.12]
    pts.push(exit)

    // Fritsch–Carlson slopes (y as a function of x) — no overshoot between patches.
    const n = pts.length
    const d = []
    for (let i = 0; i < n - 1; i++) d.push((pts[i + 1][1] - pts[i][1]) / (pts[i + 1][0] - pts[i][0]))
    const m = pts.map((_, i) => (i === 0 ? d[0] : i === n - 1 ? d[n - 2] : d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2))
    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) continue
      const a = m[i] / d[i]
      const b = m[i + 1] / d[i]
      const h = a * a + b * b
      if (h > 9) {
        const t = 3 / Math.sqrt(h)
        m[i] = t * a * d[i]
        m[i + 1] = t * b * d[i]
      }
    }

    // Lift-off: straight up from the pad, bending into the first patch's slope.
    const [x1, y1] = pts[0]
    const dx0 = x1 - S.padX
    let dPath = `M${S.padX} ${S.padY} C ${S.padX} ${S.padY - (S.padY - y1) * 0.62} ${x1 - dx0 * 0.5} ${y1 - m[0] * dx0 * 0.5} ${x1} ${y1}`
    for (let i = 0; i < n - 1; i++) {
      const [xa, ya] = pts[i]
      const [xb, yb] = pts[i + 1]
      const h = (xb - xa) / 3
      dPath += ` C ${xa + h} ${ya + m[i] * h} ${xb - h} ${yb - m[i + 1] * h} ${xb} ${yb}`
    }

    svg.setAttribute('viewBox', `0 0 ${S.trackW} ${S.vh}`)
    svg.setAttribute('width', S.trackW)
    svg.setAttribute('height', S.vh)
    const grad = $('#manifest-line-grad', svg)
    grad.setAttribute('x1', S.padX)
    grad.setAttribute('x2', last[0] + S.vw * 0.2)
    for (const p of [ghost, glow, line, hot, hotGlow]) p.setAttribute('d', dPath)

    S.total = line.getTotalLength()
    for (const p of [glow, line]) {
      p.style.strokeDasharray = `${S.total} ${S.total}`
      p.style.strokeDashoffset = S.total
    }
    for (const p of [hot, hotGlow]) p.style.strokeDasharray = `${TRAIL} ${S.total + TRAIL}`

    // Lookup table: uniform in length, used for len→point and x→len.
    S.lut = new Float32Array(LUT_SIZE * 3)
    for (let i = 0; i < LUT_SIZE; i++) {
      const len = (i / (LUT_SIZE - 1)) * S.total
      const p = line.getPointAtLength(len)
      S.lut[i * 3] = len
      S.lut[i * 3 + 1] = p.x
      S.lut[i * 3 + 2] = p.y
    }

    // Downrange ticks every ~180px along the flown path.
    ticks.replaceChildren()
    for (let len = 120; len < S.total - 60; len += 180) {
      const a = pointAt(len)
      const b = pointAt(len + 2)
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]) + Math.PI / 2
      const k = 5
      ticks.append(
        svgEl('line', {
          x1: a[0] - Math.cos(ang) * k,
          y1: a[1] - Math.sin(ang) * k,
          x2: a[0] + Math.cos(ang) * k,
          y2: a[1] + Math.sin(ang) * k,
          'data-len': len,
        }),
      )
    }
    S.tickEls = Array.from(ticks.children).map((el) => ({ el, len: Number(el.dataset.len), on: false }))
  }

  function pointAt(len) {
    const t = clamp(len / S.total) * (LUT_SIZE - 1)
    const i = Math.min(LUT_SIZE - 2, Math.floor(t))
    const k = t - i
    const L = S.lut
    return [lerp(L[i * 3 + 1], L[i * 3 + 4], k), lerp(L[i * 3 + 2], L[i * 3 + 5], k)]
  }

  /** Path length at which the curve reaches track x (curve is monotone in x). */
  function lenAtX(x) {
    const L = S.lut
    let lo = 0
    let hi = LUT_SIZE - 1
    if (x <= L[1]) return 0
    if (x >= L[hi * 3 + 1]) return S.total
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (L[mid * 3 + 1] < x) lo = mid
      else hi = mid
    }
    const xa = L[lo * 3 + 1]
    const xb = L[hi * 3 + 1]
    return lerp(L[lo * 3], L[hi * 3], xb > xa ? (x - xa) / (xb - xa) : 0)
  }

  /** Two parallax star layers (painted once per refresh, then only translated). */
  function buildStars() {
    const layers = [
      { factor: 0.12, count: byTier({ high: 360, medium: 260, low: 160 }), size: 1, alpha: [0.25, 0.7], seed: 0x5a51 },
      { factor: 0.32, count: byTier({ high: 90, medium: 70, low: 40 }), size: 1.6, alpha: [0.5, 1], seed: 0x5a52 },
    ]
    starsEl.replaceChildren()
    S.starLayers = layers.map((layer) => {
      const width = S.vw + S.distance * layer.factor + 40
      const count = Math.round(layer.count * (width / 1440))
      const el = paintStars(starsEl, { ...layer, width, height: S.vh, count })
      return { el, factor: layer.factor }
    })
  }

  // ---- Per-frame render (pure writes) -------------------------------------------
  let last = { trackX: -1, len: -1, cur: -2, alt: '', vel: '', dr: '', underway: null, outro: null, space: null, engaged: null, label: null }
  const reached = missions.map(() => false)
  const shown = missions.map(() => false)

  function render(self) {
    const y = self.scroll()
    const pinStart = pin.start
    const pinEnd = pin.end
    let trackX = 0
    let len = 0
    let approach = 1
    if (y < pinStart) {
      approach = clamp((y - self.start) / Math.max(1, pinStart - self.start))
      len = easeInOut(clamp((approach - 0.45) / 0.55)) * lenAtX(S.tip0)
    } else {
      trackX = clamp((y - pinStart) / Math.max(1, pinEnd - pinStart)) * S.distance
      len = lenAtX(S.tip0 + trackX)
    }

    // The HUD comes online as the frame settles into its pin, not while it is
    // still scrolling in under the previous section.
    const engaged = y >= pinStart - S.vh * 0.2
    if (engaged !== last.engaged) root.classList.toggle('is-engaged', (last.engaged = engaged))

    if (trackX !== last.trackX) {
      track.style.transform = `translate3d(${-trackX}px,0,0)`
      for (const layer of S.starLayers) layer.el.style.transform = `translate3d(${-trackX * layer.factor}px,0,0)`
      ghosts.style.transform = `translate3d(${(-trackX * (1 + GHOST)).toFixed(1)}px,0,0)`
      const p = S.distance ? trackX / S.distance : 0
      beyond.style.opacity = (p * p).toFixed(3)
      // The planet falls away once the pad has scrolled off.
      const sink = clamp((trackX - S.padX * 0.6) / (S.vw * 1.4))
      planet.style.transform = `translate3d(0,${(sink * 34).toFixed(2)}vh,0)`
      planet.style.opacity = (1 - sink * 0.75).toFixed(3)
      // Orbital sunrise: the sun clears the limb as the vehicle climbs.
      const rise = clamp((trackX - S.vw * 0.04) / (S.vw * 0.5))
      sun.style.opacity = (rise * rise * (3 - 2 * rise)).toFixed(3)
      // Hide the Kármán label while a patch or card slides across it.
      const L = S.label
      const covered = S.stations.some(
        (st) =>
          (st.cx - st.r - trackX < L.x1 && st.cx + st.r - trackX > L.x0 && st.cy - st.r < L.y1 && st.cy + st.r > L.y0) ||
          (st.card.x0 - trackX < L.x1 && st.card.x1 - trackX > L.x0 && st.card.y0 < L.y1 && st.card.y1 > L.y0),
      )
      if (covered !== last.label) karmanLabel.classList.toggle('is-covered', (last.label = covered))
      const underway = trackX > S.vw * 0.3
      if (underway !== last.underway) root.classList.toggle('is-underway', (last.underway = underway))
      const outro = trackX > S.distance - S.vw * 0.45
      if (outro !== last.outro) root.classList.toggle('is-outro', (last.outro = outro))
      last.trackX = trackX
    }

    if (len !== last.len) {
      const off = S.total - len
      line.style.strokeDashoffset = off
      glow.style.strokeDashoffset = off
      const [hx, hy] = pointAt(len)
      const [bx, by] = pointAt(Math.max(0, len - 6))
      const ang = len > 6 ? Math.atan2(hy - by, hx - bx) : -Math.PI / 2
      head.setAttribute('transform', `translate(${hx.toFixed(1)} ${hy.toFixed(1)})`)
      headRot.setAttribute('transform', `rotate(${((ang * 180) / Math.PI).toFixed(1)})`)
      head.style.opacity = len > 1 ? 1 : 0

      // Exhaust-hot trail: dash ends at the vehicle; gradient runs tail → head.
      const [tx, ty] = pointAt(Math.max(0, len - TRAIL))
      const hotOff = (TRAIL - len).toFixed(1)
      hot.style.strokeDashoffset = hotOff
      hotGlow.style.strokeDashoffset = hotOff
      hotGrad.setAttribute('x1', tx.toFixed(1))
      hotGrad.setAttribute('y1', ty.toFixed(1))
      hotGrad.setAttribute('x2', hx.toFixed(1))
      hotGrad.setAttribute('y2', hy.toFixed(1))
      const hotOn = len > 2 ? '' : '0'
      hot.style.opacity = hotOn
      hotGlow.style.opacity = hotOn

      for (const t of S.tickEls) {
        const on = t.len <= len
        if (on !== t.on) t.el.classList.toggle('is-on', (t.on = on))
      }

      // HUD telemetry (simulated, illustrative scale)
      const u = clamp((S.padY - hy) / S.padY, 0, 1.3)
      const altKm = len > 1 ? S.alt.a * (Math.exp(S.alt.b * u) - 1) : 0
      const alt = altKm > 9999 ? formatNumber(altKm, 0) : formatNumber(altKm, 1)
      const dr = formatNumber(Math.max(0, (hx - S.padX) * 0.75), 0)
      // Velocity (illustrative): climbs toward orbital speed, then past it.
      const fl = len / S.total
      const vel = formatNumber(len > 1 ? 7.8 * (1 - Math.exp(-2.4 * fl ** 1.3)) + 3.4 * fl ** 4 : 0, 2)
      if (alt !== last.alt) altEl.textContent = last.alt = alt
      if (vel !== last.vel) velEl.textContent = last.vel = vel
      if (dr !== last.dr) drEl.textContent = last.dr = dr
      const space = len > 1 && hy < KARMAN * S.vh
      if (space !== last.space) root.classList.toggle('is-space', (last.space = space))

      // Stations: assemble ahead of the tip, light up as it passes through.
      let cur = -1
      S.stations.forEach((s, i) => {
        const inView = approach > 0.4 && hx >= s.left - S.vw * 0.2
        if (inView && !shown[i]) {
          shown[i] = true
          missions[i].el.classList.add('is-in')
        }
        const isReached = len > 1 && hx >= s.cx - 2
        if (isReached !== reached[i]) {
          reached[i] = isReached
          missions[i].el.classList.toggle('is-reached', isReached)
          if (isReached) onReach?.(missions[i], i)
        }
        if (isReached) cur = i
      })
      if (cur !== last.cur) {
        indexBtns.forEach((btn, i) => {
          btn.classList.toggle('is-past', i < cur)
          if (i === cur) btn.setAttribute('aria-current', 'step')
          else btn.removeAttribute('aria-current')
        })
        ghostEls.forEach((el, i) => el.classList.toggle('is-current', i === cur))
        last.cur = cur
      }
      const n = S.stations.length
      const fillT = n > 1 ? clamp((hx - S.stations[0].cx) / (S.stations[n - 1].cx - S.stations[0].cx)) : 1
      indexFill.style.transform = `scaleX(${fillT.toFixed(4)})`
      last.len = len
    }
  }

  // ---- ScrollTriggers ---------------------------------------------------------------
  const pin = ScrollTrigger.create({
    trigger: frame,
    start: 'top top',
    end: () => `+=${measure().distance}`,
    pin: true,
    anticipatePin: 1,
    invalidateOnRefresh: true,
  })

  const fly = ScrollTrigger.create({
    trigger: frame,
    start: 'top 45%',
    end: () => pin.end,
    invalidateOnRefresh: true,
    onUpdate: render,
    onRefresh: (self) => {
      last = { ...last, trackX: -1, len: -1, cur: -2, label: null }
      render(self)
    },
  })

  /** Scroll position at which track-x `x` sits under the tip. */
  const scrollForX = (x) => pin.start + clamp((x - S.tip0) / Math.max(1, S.distance)) * (pin.end - pin.start)

  const onIndexClick = (event) => {
    const btn = event.target.closest('.s-manifest__index-btn')
    if (!btn) return
    const s = S.stations[Number(btn.dataset.index)]
    if (s) scrollToTarget(scrollForX(s.cx + 4))
  }
  index.addEventListener('click', onIndexClick)

  // Keyboard focus inside the sliding track: bring the focused item under the camera.
  const onFocusIn = (event) => {
    const target = event.target
    if (!(target instanceof Element)) return
    const tr = track.getBoundingClientRect()
    const r = target.getBoundingClientRect()
    const x = r.left - tr.left + r.width / 2
    if (r.left >= 0 && r.right <= S.vw) return
    scrollToTarget(scrollForX(x + (S.tip0 - S.vw / 2)))
  }
  track.addEventListener('focusin', onFocusIn)

  return () => {
    pin.kill(true)
    fly.kill()
    index.removeEventListener('click', onIndexClick)
    track.removeEventListener('focusin', onFocusIn)
    index.hidden = true
    index.replaceChildren()
    svg.replaceChildren()
    starsEl.replaceChildren()
    ghosts.remove()
    beyond.style.opacity = ''
    track.style.transform = ''
    planet.style.transform = ''
    planet.style.opacity = ''
    sun.style.opacity = ''
    karmanLabel.classList.remove('is-covered')
    root.classList.remove('is-flight', 'is-underway', 'is-outro', 'is-space', 'is-engaged')
    missions.forEach((m) => {
      m.el.style.removeProperty('--t')
      m.el.classList.remove('is-reached')
    })
  }
}

