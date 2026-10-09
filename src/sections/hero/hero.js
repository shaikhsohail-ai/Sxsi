/**
 * Hero — Earth from low orbit at orbital sunrise; the night side glows with a
 * neural network of city lights. Owns the countdown, the (simulated) HUD
 * telemetry, the boot-intro choreography and the scroll-driven sunrise.
 *
 * The WebGL scene (scene.js) is loaded lazily and only *reads* `state`; every
 * tween lives here so intro, scroll and reduced-motion stay in one place.
 */
import { gsap } from '../../lib/motion.js'
import { booted, emit } from '../../lib/bus.js'
import { hasWebGL, reducedMotion } from '../../lib/quality.js'
import { observeVisibility } from '../../lib/visibility.js'
import { $, $$, pad } from '../../lib/dom.js'
import { NEXT_MISSION } from '../../config.js'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const ROLL_FRAMES = [
  { transform: 'translate3d(0, -0.3em, 0)', opacity: 0.2 },
  { transform: 'none', opacity: 1 },
]
const ROLL_TIMING = { duration: 340, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }

export function init() {
  const root = document.getElementById('hero')
  if (!root) return

  // Values the WebGL scene reads every frame.
  const state = { progress: 0, light: 0, reveal: 0, flare: 0, net: 0, push: 1 }

  root.classList.add('is-armed')
  initCountdown(root)
  initTelemetry(root)

  if (reducedMotion) {
    // A still, fully-lit frame: sun just touching the limb, network awake.
    Object.assign(state, { progress: 0.2, light: 1, reveal: 1, flare: 1, net: 1, push: 0 })
  } else {
    hideForIntro(root)
    initScroll(root, state)
    booted.then(() => playIntro(root, state))
  }

  startScene(root, state)
}

/* --------------------------------------------------------------------------
 * Scene (lazy)
 * ------------------------------------------------------------------------ */
function startScene(root, state) {
  const canvas = $('[data-hero-canvas]', root)
  const forceStatic = new URLSearchParams(location.search).get('hero') === 'static'
  const fallback = () => {
    root.classList.remove('is-webgl')
    root.classList.add('is-fallback')
  }
  if (!canvas || forceStatic || !hasWebGL()) return fallback()

  const reticle = trackSun(root)
  import('./scene.js')
    .then(({ createHeroScene }) => {
      createHeroScene({ root, canvas, state, onFrame: reticle, onReady: () => root.classList.add('is-webgl') })
      root.addEventListener('hero:webgl-lost', fallback, { once: true })
    })
    .catch((error) => {
      console.error('[sxsi] hero scene unavailable, using static rendition', error)
      fallback()
    })
}

/** Returns a per-frame callback that pins the HUD reticle to the sun. */
function trackSun(root) {
  const el = $('[data-hero-reticle]', root)
  const value = $('[data-hero-sun-el]', root)
  if (!el) return null
  let lastText = ''
  let lastX = -1
  let lastY = -1
  return ({ x, y, elevation }) => {
    // Sub-pixel moves are invisible; skip the style write
    if (Math.abs(x - lastX) > 0.1 || Math.abs(y - lastY) > 0.1) {
      el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`
      lastX = x
      lastY = y
    }
    const text = `${elevation < 0 ? '−' : '+'}${Math.abs(elevation).toFixed(2)}°`
    if (text !== lastText && value) {
      value.textContent = text
      lastText = text
    }
  }
}

/* --------------------------------------------------------------------------
 * Intro choreography (after the boot sequence)
 * ------------------------------------------------------------------------ */
function hideForIntro(root) {
  gsap.set($$('[data-hero-line]', root), { yPercent: 108, y: 0 })
  gsap.set($$('[data-hero-reveal]', root), { opacity: 0, y: 18 })
  gsap.set($$('[data-hero-hud] > *, [data-hero-bottom] > *', root), { opacity: 0, y: 10 })
}

function playIntro(root, state) {
  const [eyebrow, sub, ctas] = $$('[data-hero-reveal]', root)
  const lines = $$('[data-hero-line]', root)
  const reticle = $('[data-hero-reticle]', root)
  const hud = $$('[data-hero-hud] > *', root)
  const bottom = $$('[data-hero-bottom] > *', root)

  gsap
    .timeline({ delay: 0.1 })
    // Light: the planet fades up from darkness while the limb ignites from the sun outward
    .to(state, { light: 1, duration: 3, ease: 'power2.inOut' }, 0)
    .to(state, { reveal: 1, duration: 3.4, ease: 'expo.out' }, 0.35)
    .to(state, { flare: 1.9, duration: 1.1, ease: 'power3.out' }, 0.5)
    .to(state, { flare: 1, duration: 2.8, ease: 'power2.inOut' }, 1.6)
    .to(state, { net: 1, duration: 4.2, ease: 'power1.inOut' }, 1.1)
    .to(state, { push: 0, duration: 6, ease: 'expo.out' }, 0)
    .call(() => emit('sound:cue', { type: 'whoosh' }), null, 0.5)
    // Type
    .to(eyebrow, { opacity: 1, y: 0, duration: 1.4, ease: 'expo.out' }, 1.0)
    .to(lines, { yPercent: 0, duration: 1.7, ease: 'expo.out', stagger: 0.15 }, 1.1)
    .to(sub, { opacity: 1, y: 0, duration: 1.4, ease: 'expo.out' }, 1.6)
    .to(ctas, { opacity: 1, y: 0, duration: 1.4, ease: 'expo.out' }, 1.75)
    .to([...hud, ...bottom], { opacity: 1, y: 0, duration: 1.2, ease: 'expo.out', stagger: 0.07 }, 2.0)
    .to(reticle, { opacity: 1, duration: 1.6, ease: 'power2.out' }, 2.4)
    .call(() => emit('sound:cue', { type: 'blip' }), null, 2.1)
}

/* --------------------------------------------------------------------------
 * Scroll: content lifts away, the camera tilts up and the sun crests the limb
 * ------------------------------------------------------------------------ */
function initScroll(root, state) {
  const lift = $('[data-hero-lift]', root)
  const depth = $$('[data-hero-depth]', root)
  const hud = $('[data-hero-hud]', root)
  const bottom = $('[data-hero-bottom]', root)
  const vh = () => window.innerHeight
  let crested = false

  gsap
    .timeline({
      defaults: { ease: 'none' },
      scrollTrigger: {
        trigger: root,
        start: 'top top',
        end: 'bottom bottom',
        scrub: true,
        invalidateOnRefresh: true,
        onUpdate: (self) => {
          // A cue the moment the sun breaks the horizon (forward only)
          if (!crested && self.progress > 0.38 && self.direction > 0) {
            crested = true
            emit('sound:cue', { type: 'whoosh' })
          } else if (crested && self.progress < 0.2) {
            crested = false
          }
        },
      },
    })
    .to(state, { progress: 1, duration: 1 }, 0)
    // The type peels away in depth layers (eyebrow fastest, CTAs slowest) and
    // has cleared the sky before the sun breaks the limb at ≈ 0.39
    .to(lift, { y: () => -vh() * 0.08, opacity: 0, duration: 0.34, ease: 'power1.in' }, 0)
    .to(depth, { y: (i, el) => -vh() * Number(el.dataset.heroDepth), duration: 0.34, ease: 'power1.in' }, 0)
    // Frame furniture clears first, so the rising type never crosses it
    .to([hud, bottom], { opacity: 0, duration: 0.12 }, 0)
    .to($('.s-hero__reticle-box', root), { scale: 0.6, duration: 0.5, ease: 'power2.inOut' }, 0.2)
    .to($('.s-hero__reticle-label', root), { opacity: 0, duration: 0.2 }, 0.62)
    .to($('.s-hero__reticle-box', root), { opacity: 0, duration: 0.2 }, 0.7)
    // Hand over to the next section: the foreground sinks into black so the
    // frame leaves with a seamless edge
    .to($('[data-hero-exit]', root), { opacity: 1, duration: 0.3, ease: 'power1.inOut' }, 0.7)
}

/* --------------------------------------------------------------------------
 * Next-launch countdown: T− DD:HH:MM:SS → T+ after launch
 * ------------------------------------------------------------------------ */
function initCountdown(root) {
  const { number, name, launchAt, pad: launchPad } = NEXT_MISSION
  const setText = (selector, text) => {
    const el = $(selector, root)
    if (el && text != null && el.textContent !== String(text)) el.textContent = text
  }
  setText('[data-hero-mission]', number)
  setText('[data-hero-mission-name]', name)
  setText('[data-hero-pad]', launchPad)

  const target = Date.parse(launchAt)
  const clock = $('[data-hero-clock]', root)
  if (!clock || !Number.isFinite(target)) {
    clock?.setAttribute('hidden', '')
    return
  }

  const date = new Date(target)
  const time = $('[data-hero-date]', root)
  if (time) {
    time.setAttribute('datetime', date.toISOString())
    time.textContent = `${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} · ${pad(
      date.getUTCHours(),
    )}:${pad(date.getUTCMinutes())} UTC`
  }

  const els = {
    d: $('[data-hero-d]', root),
    h: $('[data-hero-h]', root),
    m: $('[data-hero-m]', root),
    s: $('[data-hero-s]', root),
    sign: $('[data-hero-sign]', root),
    status: $('[data-hero-launch-status]', root),
  }
  const write = (el, text) => {
    if (el && el.textContent !== text) el.textContent = text
  }
  // Digits drop into place as they change, like a mechanical counter
  const canRoll = !reducedMotion && typeof clock.animate === 'function'
  const rolling = new Map() // one in-flight roll per digit group, never a pile-up
  const roll = (el, text) => {
    if (!el || el.textContent === text) return
    el.textContent = text
    if (!canRoll) return
    rolling.get(el)?.cancel()
    rolling.set(el, el.animate(ROLL_FRAMES, ROLL_TIMING))
  }

  let timer = 0
  let launched = null
  const tick = () => {
    const now = Date.now()
    const diff = target - now
    const abs = Math.abs(diff)
    const days = Math.floor(abs / 86_400_000)
    roll(els.d, days > 99 ? String(days) : pad(days))
    roll(els.h, pad((abs / 3_600_000) % 24))
    roll(els.m, pad((abs / 60_000) % 60))
    roll(els.s, pad((abs / 1000) % 60))

    const isLaunched = diff <= 0
    if (isLaunched !== launched) {
      launched = isLaunched
      write(els.sign, isLaunched ? 'T+' : 'T−')
      write(els.status, isLaunched ? 'Launched' : 'Next launch')
      // ignition orange while counting down, nominal green once flying
      els.status?.classList.toggle('status--live', !isLaunched)
      root.classList.toggle('is-launched', isLaunched)
    }
    timer = window.setTimeout(tick, 1000 - (now % 1000) + 10)
  }

  observeVisibility(root, (visible) => {
    if (visible && !timer) tick()
    else if (!visible && timer) {
      clearTimeout(timer)
      timer = 0
    }
  })
}

/* --------------------------------------------------------------------------
 * HUD telemetry (simulated ground track, altitude, velocity) + mission clock
 * ------------------------------------------------------------------------ */
function initTelemetry(root) {
  const els = {
    lat: $('[data-hero-lat]', root),
    lon: $('[data-hero-lon]', root),
    alt: $('[data-hero-alt]', root),
    vel: $('[data-hero-vel]', root),
    met: $('[data-hero-met]', root),
  }
  const start = performance.now()
  const write = (el, text) => {
    if (el && el.textContent !== text) el.textContent = text
  }

  const update = () => {
    const t = (performance.now() - start) / 1000
    // Brand fiction: a 51.6° orbit drifting east from the launch site
    const lat = 28.4858 + Math.sin(t * 0.0011) * 2.2
    let lon = -80.5444 + t * 0.0682
    lon = ((((lon + 180) % 360) + 360) % 360) - 180
    write(els.lat, `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}`)
    write(els.lon, `${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? 'E' : 'W'}`)
    write(els.alt, (408 + Math.sin(t * 0.21) * 0.35 + Math.sin(t * 0.047) * 0.6).toFixed(1))
    write(els.vel, (7.66 + Math.sin(t * 0.13) * 0.004).toFixed(3))
    const s = Math.floor(t)
    write(els.met, `T+ ${pad(s / 3600)}:${pad((s / 60) % 60)}:${pad(s % 60)}`)
  }

  let timer = 0
  const interval = reducedMotion ? 1000 : 250
  observeVisibility(root, (visible) => {
    if (visible && !timer) {
      update()
      timer = window.setInterval(update, interval)
    } else if (!visible && timer) {
      clearInterval(timer)
      timer = 0
    }
  })
}
