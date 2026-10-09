/**
 * Boot sequence — a ≤ 2.4 s flight-computer boot: log lines type in, the
 * progress hairline fills, T−3 · 2 · 1, IGNITION, then the cover separates
 * like a payload fairing to reveal the hero.
 *
 * Contract: markBooted() is called exactly once on every path (normal end,
 * skip, error, not-run). Runs once per session; skipped instantly with
 * ?noboot or under reduced motion (decided before first paint in boot.html).
 * Any key / click / tap skips. The overlay is removed from the DOM after.
 */
import { gsap, lockScroll } from '../../lib/motion.js'
import { markBooted, emit } from '../../lib/bus.js'
import { reducedMotion, isTouch } from '../../lib/quality.js'
import { $ } from '../../lib/dom.js'
import { logoSvg } from '../nav/logo.js'
import { formatUtc } from '../nav/clock.js'

const SESSION_KEY = 'sxsi:booted'
const LATE_MS = 4500 // scripts this late (slow network): don't add a show on top of the wait

const LOG = [
  { label: 'SXSI FLIGHT COMPUTER v1.0', head: true },
  { label: 'GUIDANCE', status: 'OK' },
  { label: 'NEURAL CORE', status: 'NOMINAL' },
  { label: 'TELEMETRY', status: 'LINKED' },
  { label: 'RANGE', status: 'GO FOR LAUNCH' },
]
const COLUMN = 18 // label + dot leader width

export function init() {
  const root = $('.s-boot[data-boot-cover]')
  const html = document.documentElement
  let handedOver = false
  let finished = false

  // Give the page back: scrolling on, hero intro may start. Exactly once.
  const handOver = () => {
    if (handedOver) return
    handedOver = true
    lockScroll(false)
    markBooted()
  }

  // Tear down: overlay gone from the DOM, and (if not already) hand over.
  const finish = () => {
    if (finished) return
    finished = true
    html.dataset.boot = 'done'
    root?.remove()
    handOver()
  }

  // `?boot` replays the sequence on demand (QA, sharing the launch moment).
  const params = new URLSearchParams(location.search)
  const forced = params.has('boot')
  const shouldRun =
    root &&
    html.dataset.boot === 'run' &&
    !reducedMotion &&
    !params.has('noboot') &&
    (forced || performance.now() < LATE_MS)

  if (!shouldRun) {
    finish()
    return
  }

  try {
    sessionStorage.setItem(SESSION_KEY, '1')
  } catch {
    /* no session storage: it simply plays again next time */
  }

  try {
    run(root, { handOver, finish })
  } catch (error) {
    console.error('[sxsi] boot sequence failed', error)
    finish()
  }
}

/** 72 hairline ticks around the dial (every 6th longer). */
function dialTicks() {
  let out = ''
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * Math.PI * 2
    const r0 = i % 6 === 0 ? 84 : 87.5
    const c = Math.cos(a)
    const s = Math.sin(a)
    out += `<line x1="${(100 + c * r0).toFixed(2)}" y1="${(100 + s * r0).toFixed(2)}" x2="${(100 + c * 90).toFixed(2)}" y2="${(100 + s * 90).toFixed(2)}" />`
  }
  return out
}

/* --------------------------------------------------------------------------
 * Build + play
 * ------------------------------------------------------------------------ */
function build(root) {
  const lines = LOG.map(({ label, status, head }) => {
    const leader = status ? ` ${'.'.repeat(Math.max(3, COLUMN - label.length))} ` : ''
    return { text: label + leader, status: status || '', head }
  })

  // Keep the CSS standby (if it painted) on top so it can cross-fade away.
  const standby = root.querySelector('.s-boot__standby')
  root.innerHTML = `
    <div class="s-boot__panel s-boot__panel--top"><span class="s-boot__edge"></span></div>
    <div class="s-boot__panel s-boot__panel--bottom"><span class="s-boot__edge"></span></div>
    <div class="s-boot__flash"></div>
    <div class="s-boot__ui">
      <span class="s-boot__corner s-boot__corner--tl"></span>
      <span class="s-boot__corner s-boot__corner--tr"></span>
      <span class="s-boot__corner s-boot__corner--bl"></span>
      <span class="s-boot__corner s-boot__corner--br"></span>
      <div class="s-boot__top">
        ${logoSvg('s-boot__logo')}
        <span class="s-boot__utc">UTC<b>${formatUtc()}</b></span>
      </div>
      <div class="s-boot__center">
        <div class="s-boot__count">
          <p class="s-boot__kicker">Launch sequence</p>
          <div class="s-boot__dial">
            <svg class="s-boot__ring" viewBox="0 0 200 200" aria-hidden="true">
              <g class="s-boot__ring-ticks">${dialTicks()}</g>
              <circle class="s-boot__ring-track" cx="100" cy="100" r="96" />
              <circle class="s-boot__ring-fill" cx="100" cy="100" r="96" pathLength="1" />
            </svg>
            <div class="s-boot__digits">
              <span class="s-boot__t">T−</span>
              <span class="s-boot__mask"><span class="s-boot__digit">3</span></span>
            </div>
          </div>
        </div>
        <p class="s-boot__ignition">Ignition</p>
      </div>
      <div class="s-boot__bottom">
        <ol class="s-boot__log">
          ${lines.map((l) => `<li class="${l.head ? 'is-head' : ''}"><span class="s-boot__label"></span><span class="s-boot__status"></span></li>`).join('')}
        </ol>
        <p class="s-boot__meter">Boot <span class="s-boot__pct">000%</span></p>
      </div>
      <div class="s-boot__bar"><span></span></div>
      <p class="s-boot__skip">${isTouch ? 'Tap' : 'Press any key'} to skip</p>
    </div>
    <div class="s-boot__seam"></div>`
  root.classList.add('is-built')
  if (standby) root.append(standby)

  const q = (sel) => root.querySelector(sel)
  return {
    standby,
    edges: [...root.querySelectorAll('.s-boot__edge')],
    lines,
    items: [...root.querySelectorAll('.s-boot__log li')],
    panels: [q('.s-boot__panel--top'), q('.s-boot__panel--bottom')],
    ui: q('.s-boot__ui'),
    corners: [...root.querySelectorAll('.s-boot__corner')],
    top: q('.s-boot__top'),
    kicker: q('.s-boot__kicker'),
    ring: q('.s-boot__ring'),
    ringFill: q('.s-boot__ring-fill'),
    digits: q('.s-boot__digits'),
    digit: q('.s-boot__digit'),
    ignition: q('.s-boot__ignition'),
    flash: q('.s-boot__flash'),
    seam: q('.s-boot__seam'),
    bar: q('.s-boot__bar span'),
    pct: q('.s-boot__pct'),
    meter: q('.s-boot__meter'),
    skip: q('.s-boot__skip'),
  }
}

function run(root, { handOver, finish }) {
  const el = build(root)
  lockScroll(true)

  let tl = null

  // ---- Skip: any key, click or tap -----------------------------------------
  const events = ['keydown', 'pointerdown']
  const skip = () => {
    detach()
    tl?.kill()
    handOver()
    gsap.to(root, { autoAlpha: 0, duration: 0.35, ease: 'power2.out', onComplete: finish })
  }
  const detach = () => events.forEach((type) => window.removeEventListener(type, skip, true))
  events.forEach((type) => window.addEventListener(type, skip, true))

  // ---- Typing ----------------------------------------------------------------
  const typeLine = (i) => {
    const li = el.items[i]
    const { text, status } = el.lines[i]
    const label = li.firstElementChild
    const state = { n: 0 }
    return gsap.to(state, {
      n: text.length,
      duration: 0.17,
      ease: 'none',
      onUpdate: () => {
        const n = Math.round(state.n)
        const done = n >= text.length
        label.textContent = text.slice(0, n)
        li.lastElementChild.textContent = done ? status : ''
        li.classList.toggle('is-typing', n > 0 && !done)
      },
    })
  }

  const meter = { p: 0 }
  const setDigit = (n) => () => {
    el.digit.textContent = String(n)
    emit('sound:cue', { type: 'blip' })
  }

  // ---- Timeline (2.4 s) --------------------------------------------------------
  // `id` lets tooling find it (gsap.getById('sxsi-boot')) to freeze frames.
  tl = gsap.timeline({ id: 'sxsi-boot', defaults: { ease: 'expo.out' }, onComplete: () => (detach(), finish()) })

  if (el.standby) tl.to(el.standby, { autoAlpha: 0, scale: 0.96, duration: 0.3, ease: 'power2.out' }, 0)
  tl.from(el.corners, { autoAlpha: 0, scale: 0.4, duration: 0.5, stagger: 0.03 }, 0)
    .from([el.top, el.meter, el.skip], { autoAlpha: 0, y: 6, duration: 0.5, stagger: 0.05 }, 0.02)
    .from(el.ring, { autoAlpha: 0, scale: 0.86, rotation: -40, duration: 0.9 }, 0.02)
    .to(
      meter,
      {
        p: 100,
        duration: 0.8,
        ease: 'power2.inOut',
        onUpdate: () => {
          const k = meter.p / 100
          el.pct.textContent = `${String(Math.round(meter.p)).padStart(3, '0')}%`
          el.bar.style.transform = `scaleX(${k})`
          el.ringFill.style.strokeDashoffset = String(1 - k)
        },
      },
      0.04,
    )

  el.lines.forEach((_, i) => tl.add(typeLine(i), 0.04 + i * 0.14))

  // Countdown: T−3 · 2 · 1 — each beat holds ~0.28 s
  const beat = (n, at, last = false) => {
    tl.call(setDigit(n), null, at).fromTo(el.digit, { yPercent: 105 }, { yPercent: 0, duration: 0.26, immediateRender: false }, at)
    if (!last) tl.to(el.digit, { yPercent: -105, duration: 0.1, ease: 'power2.in' }, at + 0.18)
  }
  tl.from(el.kicker, { autoAlpha: 0, y: 6, duration: 0.4 }, 0.72)
    .from(el.digits, { autoAlpha: 0, duration: 0.2, ease: 'power1.out' }, 0.78)
  beat(3, 0.8)
  beat(2, 1.08)
  beat(1, 1.36, true)

  // Ignition: the dial bursts outward like a shockwave, the word ignites
  tl.to([el.kicker, el.digits], { autoAlpha: 0, scale: 0.94, duration: 0.1, ease: 'power2.in' }, 1.6)
    .to(el.ring, { scale: 2.6, autoAlpha: 0, duration: 0.7, ease: 'expo.out' }, 1.66)
    .to(el.ringFill, { stroke: '#ffb46b', duration: 0.1 }, 1.62)
    .call(() => emit('sound:cue', { type: 'ignition' }), null, 1.66)
    .fromTo(el.ignition, { autoAlpha: 0, letterSpacing: '0.6em', scale: 0.96 }, { autoAlpha: 1, letterSpacing: '0.16em', scale: 1, duration: 0.6 }, 1.66)
    .to(el.flash, { autoAlpha: 1, duration: 0.16, ease: 'power2.out' }, 1.66)
    .to(el.flash, { autoAlpha: 0.45, duration: 0.3, ease: 'power2.inOut' }, 1.82)

    // Fairing separation
    .to(el.seam, { autoAlpha: 1, scaleX: 1, duration: 0.2, ease: 'expo.out' }, 1.96)
    .to(el.ui, { autoAlpha: 0, duration: 0.16, ease: 'power1.in' }, 1.98)
    .to(el.flash, { autoAlpha: 0, duration: 0.25, ease: 'power1.in' }, 2.02)
    .call(handOver, null, 2.04) // the hero starts rising while the fairing clears
    .to(el.panels[0], { yPercent: -101, duration: 0.36, ease: 'expo.inOut' }, 2.04)
    .to(el.panels[1], { yPercent: 101, duration: 0.36, ease: 'expo.inOut' }, 2.04)
    // the halves' inner edges catch the light as they part
    .fromTo(el.edges, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.08, ease: 'power1.out' }, 2.02)
    .to(el.edges, { autoAlpha: 0, duration: 0.24, ease: 'power1.in' }, 2.16)
    .to(el.seam, { autoAlpha: 0, scaleY: 6, duration: 0.3, ease: 'power2.out' }, 2.1)
}
