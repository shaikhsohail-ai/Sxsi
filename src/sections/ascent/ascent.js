/**
 * ASCENT — the signature scroll experience.
 *
 * A pinned, scroll-scrubbed launch from pad to orbit. Scroll progress drives
 * a WebGL scene (scene.js), a mission-control HUD and six event cards, each
 * mapping a flight event to a stage of building intelligence.
 *
 * Progressive enhancement: the static partial is a complete stacked timeline
 * with an elevation drawing. Flight mode is only switched on when motion is
 * allowed and WebGL is available; should the scene fail or its context be lost
 * later, the flight carries on over a static CSS rendition (`.is-still`).
 */
import { gsap, ScrollTrigger } from '../../lib/motion.js'
import { SplitText } from 'gsap/SplitText'
import { reducedMotion, hasWebGL, tier, dpr } from '../../lib/quality.js'
import { createRenderLoop, observeVisibility } from '../../lib/visibility.js'
import { emit } from '../../lib/bus.js'
import { $, $$, clamp, formatNumber } from '../../lib/dom.js'
import { BEATS, EVENTS, telemetry, formatClock, missionTime, pitchAt, smooth } from './profile.js'

gsap.registerPlugin(SplitText)

/** Scroll length of the pinned flight, in viewport heights. */
const LENGTH = { desktop: 4.75, mobile: 3.5 }
/** Phones get the shorter flight (matches the CSS phone breakpoint). */
const MOBILE_QUERY = '(max-width: 720px)'

/** Sound cues fired when a beat is crossed going forward. */
const CUES = [
  ['ignition', 'ignition'],
  ['liftoff', 'whoosh'],
  ['maxq', 'blip'],
  ['meco', 'blip'],
  ['sep', 'whoosh'],
  ['ses', 'ignition'],
  ['fairing', 'blip'],
  ['seco', 'blip'],
  ['orbit', 'confirm'],
]

/**
 * Mission-control log above the event rail: [beat, call, tone]. The latest
 * beat crossed is shown, stamped with its mission time.
 */
const CALLOUTS = [
  [null, 'Terminal count · vehicle is go'],
  ['ignition', 'Ignition sequence start', 'ignite'],
  ['liftoff', 'Liftoff', 'ignite'],
  ['maxq', 'Max-Q · peak aerodynamic pressure'],
  ['meco', 'MECO · main engine cutoff'],
  ['sep', 'Stage separation confirmed'],
  ['ses', 'Stage 2 ignition', 'ignite'],
  ['fairing', 'Fairing separation confirmed'],
  ['seco', 'SECO · second engine cutoff'],
  ['orbit', 'Orbit insertion · nominal'],
].map(([beat, text, tone = '']) => {
  const clock = formatClock(missionTime(beat ? BEATS[beat] : 0))
  return { at: beat ? BEATS[beat] : -Infinity, text, tone, stamp: `T${clock.sign} ${clock.digits}` }
})

/** Flight phase shown top-right: [until progress, label]. */
const PHASES = [
  [BEATS.ignition, 'Terminal count'],
  [BEATS.liftoff, 'Ignition · hold-down'],
  [BEATS.meco, 'Powered ascent · S1'],
  [BEATS.sep, 'MECO · coast'],
  [BEATS.ses, 'Stage separation'],
  [BEATS.seco, 'Powered ascent · S2'],
  [BEATS.orbit, 'SECO · coast'],
  [Infinity, 'Orbit · nominal'],
]

export function init() {
  const section = $('#ascent')
  if (!section) return
  if (reducedMotion || !hasWebGL()) {
    section.classList.add('is-static')
    return
  }

  const stage = $('.s-ascent__stage', section)
  const canvas = $('.s-ascent__canvas', section)
  const events = $('.s-ascent__events', section)
  const hudTop = $('.s-ascent__hud-top', section)
  section.classList.add('is-flight')

  // ---- pin + scrub -----------------------------------------------------------------
  // One pin for every width: only its length follows the phone breakpoint, and
  // `invalidateOnRefresh` re-measures it on resize. (A per-breakpoint pin would be
  // torn down and rebuilt on every phone rotation, at the end of ScrollTrigger's order.)
  let target = 0
  let progress = 0
  const mobile = window.matchMedia(MOBILE_QUERY)
  const pin = ScrollTrigger.create({
    trigger: section,
    start: 'top top',
    end: () => `+=${Math.round(window.innerHeight * (mobile.matches ? LENGTH.mobile : LENGTH.desktop))}`,
    pin: true,
    pinSpacing: true,
    anticipatePin: 1,
    invalidateOnRefresh: true,
    onUpdate: (self) => {
      target = self.progress
    },
    onRefresh: (self) => {
      target = self.progress
    },
  })

  // ---- HUD -------------------------------------------------------------------------
  const hud = createHud(section)
  const story = createStory(section)

  // ---- scene (deferred) --------------------------------------------------------------
  // The WebGL scene is heavy to stand up — a full-viewport context, large rocket
  // textures, a shader warm-up — so only its module is fetched now. The context is
  // created as the visitor approaches, and never ahead of the hero's first frame.
  let scene = null
  let still = null
  const sceneModule = import('./scene.js')
  sceneModule.catch(() => {}) // reported when the scene is needed
  const stopApproach = whenApproaching(section, () => {
    sceneModule
      .then(({ createAscentScene }) => {
        if (still) return
        scene = createAscentScene(canvas, { tier, dpr })
        canvas.addEventListener('webglcontextlost', onContextLost, { once: true })
        resizeScene()
        // Paint the current moment of the flight once the shaders are ready, so the
        // stage is never blank when it scrolls in (the render loop takes over from there).
        Promise.resolve(scene.warm()).then(() => {
          if (!scene || loop.running) return
          progress = target
          scene.frame(clamp(progress), performance.now() / 1000, 0)
        })
      })
      .catch((error) => {
        console.error('[sxsi] ascent scene unavailable', error)
        fallBackToStatic()
      })
  })

  function onContextLost(event) {
    event.preventDefault()
    fallBackToStatic()
  }

  // ---- resize ------------------------------------------------------------------------
  function resizeScene() {
    if (!scene) return
    // On very wide screens the copy sits on the centred content grid rather than the
    // HUD's viewport gutter: the scene keeps its cloud-free zone under the copy.
    const inset = events && hudTop ? events.getBoundingClientRect().left - hudTop.getBoundingClientRect().left : 0
    scene.resize(section.clientWidth, section.clientHeight, Math.max(0, inset))
  }
  const ro = new ResizeObserver(resizeScene)
  ro.observe(section)

  // ---- adaptive resolution -----------------------------------------------------------------
  // Trade pixels for frames to hold ~60fps. Skipped under automation so visual QA is stable.
  const adaptive = !navigator.webdriver
  let ema = 1 / 60
  let lastTime = 0
  let windowEnd = 0
  let scale = 1
  let calm = 0
  function adapt(time, dt) {
    if (!adaptive || !scene) return
    // A gap means the loop just (re)started: give shaders and caches a grace period.
    if (time - lastTime > 0.5) {
      windowEnd = time + 2
      ema = 1 / 60
    }
    lastTime = time
    ema += (dt - ema) * 0.08
    if (time < windowEnd) return
    windowEnd = time + 1.2
    if (ema > 1 / 48 && scale > 0.6) {
      scale = Math.max(0.6, scale * 0.85)
      calm = 0
      scene.setScale(scale)
    } else if (ema < 1 / 57 && scale < 1) {
      if (++calm >= 3) {
        scale = Math.min(1, scale * 1.12)
        calm = 0
        scene.setScale(scale)
      }
    } else {
      calm = 0
    }
  }

  // ---- render loop ---------------------------------------------------------------------
  let lastCueP = 0
  let lastExit = ''
  const loop = createRenderLoop(section, (time, dt) => {
    // Once the pin releases, the stage's bottom edge dissolves into the page as it scrolls away.
    const exit = clamp((window.scrollY - pin.end) / (window.innerHeight * 0.15)).toFixed(3)
    if (exit !== lastExit) {
      stage.style.setProperty('--ascent-exit', exit)
      lastExit = exit
    }

    // Exponential follow on top of Lenis: weighty, never laggy. Large jumps
    // (first frame after a mid-section reload, deep links) snap instead of replaying.
    const k = 1 - Math.exp(-dt * 9)
    progress += (target - progress) * k
    if (Math.abs(target - progress) < 0.00002 || Math.abs(target - progress) > 0.3) progress = target
    const p = clamp(progress)

    const tm = telemetry(p)
    hud.update(tm)
    story.update(p, tm)
    fireCues(lastCueP, p)
    lastCueP = p

    if (scene) {
      scene.frame(p, time, dt)
      adapt(time, dt)
    } else if (still) {
      still.update(p, tm)
    }
  })

  // Forward crossings only, and never a burst of cues when scrolling fast.
  let lastCueAt = 0
  function fireCues(from, to) {
    if (to <= from || to - from > 0.15) return
    const now = performance.now()
    for (const [beat, type] of CUES) {
      if (from < BEATS[beat] && to >= BEATS[beat] && now - lastCueAt > 350) {
        emit('sound:cue', { type })
        lastCueAt = now
      }
    }
  }

  /**
   * The scene failed to load, or its WebGL context was lost: swap the canvas for the
   * static rendition (a CSS sky and the vehicle drawing), as the hero, fleet and join
   * skies do. The flight itself carries on — pin, HUD, cards and cues — so the
   * visitor stays exactly where they were.
   */
  function fallBackToStatic() {
    if (still) return
    stopApproach()
    ro.disconnect()
    canvas.removeEventListener('webglcontextlost', onContextLost)
    try {
      scene?.dispose()
    } catch {
      /* the context is already gone */
    }
    scene = null
    still = createStill(stage, canvas)
    section.classList.add('is-still')
    still.update(clamp(progress), telemetry(clamp(progress)))
  }
}

/**
 * Calls `run` once `el` is within ~1.5 viewports — and, while the hero is on
 * screen, not before it has painted its first frame. Returns a cancel function.
 */
function whenApproaching(el, run) {
  let near = false
  let cancelled = false
  let stop = null
  const go = () => {
    if (near) return
    near = true
    stop?.()
    heroSettled().then(() => {
      const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1))
      if (!cancelled) idle(() => cancelled || run(), { timeout: 300 })
    })
  }
  stop = observeVisibility(el, (visible) => visible && go(), { rootMargin: '150% 0px' })
  if (near) stop()
  return () => {
    cancelled = true
    stop?.()
  }
}

/** Resolves once the hero has a first frame (WebGL or its fallback), or is off screen. */
function heroSettled() {
  const hero = document.getElementById('hero')
  const painted = () => !hero || hero.classList.contains('is-webgl') || hero.classList.contains('is-fallback')
  if (painted()) return Promise.resolve()
  return new Promise((resolve) => {
    let stop = null
    const mo = new MutationObserver(() => painted() && settle())
    const timer = setTimeout(() => settle(), 4000) // never wait on a stalled hero
    function settle() {
      mo.disconnect()
      stop?.()
      clearTimeout(timer)
      resolve()
    }
    mo.observe(hero, { attributes: true, attributeFilter: ['class'] })
    stop = observeVisibility(hero, (visible) => !visible && settle())
  })
}

/* ---------------------------------------------------------------------------------- */

/**
 * Static rendition of the flight, for when WebGL is lost: the sky darkens with
 * altitude, the ground drops away, Earth's limb rises to meet the sunrise, and
 * the elevation drawing pitches over, sheds its first stage and burns — all
 * driven by the same telemetry as the HUD, through a handful of CSS variables.
 */
function createStill(stage, canvas) {
  const root = document.createElement('div')
  root.className = 's-ascent__still'
  root.setAttribute('aria-hidden', 'true')
  root.innerHTML =
    '<div class="s-ascent__still-stars"></div><div class="s-ascent__still-earth"></div>' +
    '<div class="s-ascent__still-sun"></div><div class="s-ascent__still-ground"></div>'
  canvas.after(root)

  const last = new Map()
  const set = (name, value) => {
    const v = value.toFixed(3)
    if (last.get(name) === v) return
    last.set(name, v)
    stage.style.setProperty(name, v)
  }
  let shed = null
  return {
    update(p, tm) {
      set('--ascent-sky', tm.sky)
      set('--ascent-climb', smooth(BEATS.liftoff, 0.16, p))
      set('--ascent-limb', smooth(0.2, 0.86, p))
      set('--ascent-sun', smooth(BEATS.orbit - 0.04, BEATS.orbit + 0.1, p))
      set('--ascent-pitch', pitchAt(p))
      set('--ascent-burn', clamp(tm.throttle / 100))
      if (shed !== p >= BEATS.sep) {
        shed = p >= BEATS.sep
        stage.classList.toggle('is-shed', shed)
      }
    },
  }
}

function createHud(section) {
  const root = $('.s-ascent__hud', section)
  const get = (name) => $(`[data-hud="${name}"]`, root)
  const el = {
    phase: get('phase'),
    clockLabel: get('clock-label'),
    clockSign: get('clock-sign'),
    clock: get('clock'),
    alt: get('alt'),
    vel: get('vel'),
    stage: get('stage'),
    throttle: get('throttle'),
    rail: get('rail'),
    tape: get('tape'),
    tapeFill: get('tape-fill'),
    tapeAlt: get('tape-alt'),
  }
  const bars = $$('[data-hud="throttle-bar"] i', root)
  const nodes = $$('.s-ascent__rail-nodes li', root)
  const layers = $$('.s-ascent__layers li', root)
  const cueCount = $('.s-ascent__cue-count', section)
  const callout = createCallout(get('callout'), get('callout-time'), get('callout-text'))

  // Only touch the DOM when a value actually changes.
  const cache = new Map()
  const text = (node, value) => {
    if (!node || cache.get(node) === value) return
    cache.set(node, value)
    node.textContent = value
  }
  const attr = (node, key, value) => {
    if (node.dataset[key] !== value) node.dataset[key] = value
  }
  const style = (node, prop, value) => {
    if (!node) return
    const key = node.dataset.hud + prop
    if (cache.get(key) === value) return
    cache.set(key, value)
    node.style[prop] = value
  }

  // Rail positions: events are evenly spaced; progress interpolates between them.
  const eventPs = EVENTS.map((e) => BEATS[e.beat])
  const railAt = (p) => {
    if (p <= eventPs[0]) return 0
    for (let i = 0; i < eventPs.length - 1; i++) {
      if (p < eventPs[i + 1]) return (i + (p - eventPs[i]) / (eventPs[i + 1] - eventPs[i])) / (eventPs.length - 1)
    }
    return 1
  }

  let lastEvent = -2
  let lastLayer = -1
  let lastBars = -1

  return {
    update(tm) {
      const { p } = tm
      const clock = formatClock(tm.t)
      const counting = p < BEATS.liftoff
      text(el.clockSign, `T${clock.sign}`)
      text(el.clock, clock.digits)
      text(el.clockLabel, counting ? (p < BEATS.ignition ? 'Count' : 'Ignition') : 'Mission time')
      text(cueCount, `T${clock.sign}${clock.digits}`)
      attr(root, 'count', String(counting))

      const phase = PHASES.find(([until]) => p < until)
      text(el.phase, phase[1])
      attr(root, 'burn', String(tm.throttle > 1))

      text(el.alt, formatNumber(tm.alt, 1))
      text(el.vel, formatNumber(tm.vel, 0))
      text(el.stage, String(tm.stage))
      text(el.throttle, String(Math.round(tm.throttle)))
      text(el.tapeAlt, formatNumber(tm.alt, 1))

      const lit = Math.round(tm.throttle / 10)
      if (lit !== lastBars) {
        bars.forEach((bar, i) => bar.classList.toggle('is-on', i < lit))
        lastBars = lit
      }

      style(el.rail, 'transform', `scaleX(${railAt(p).toFixed(4)})`)
      style(el.tape, 'transform', `translateY(${((1 - tm.tape) * 100).toFixed(2)}%)`)
      style(el.tapeFill, 'transform', `scaleY(${tm.tape.toFixed(4)})`)

      if (tm.event !== lastEvent) {
        nodes.forEach((node, i) => {
          node.classList.toggle('is-past', i < tm.event)
          node.classList.toggle('is-active', i === tm.event)
        })
        lastEvent = tm.event
      }
      callout.update(p)

      if (tm.layer !== lastLayer) {
        layers.forEach((li) => li.classList.toggle('is-active', Number(li.dataset.layer) === tm.layer))
        lastLayer = tm.layer
      }
    },
  }
}

/* ---------------------------------------------------------------------------------- */

const GLYPHS = 'ABCDEFGHJKLMNPRSTUVXYZ0123456789<>/+=#'

/**
 * The callout types itself in behind a short scrambled leading edge, stays
 * bright for a few seconds, then settles back into the HUD.
 */
function createCallout(root, timeEl, textEl) {
  let index = -1
  let typing = null
  let settle = null
  const state = { t: 0 }

  function type(text, duration) {
    typing?.kill()
    const chars = [...text]
    state.t = 0
    textEl.textContent = ''
    typing = gsap.to(state, {
      t: 1,
      duration,
      ease: 'none',
      onUpdate: () => {
        const settled = Math.floor(state.t * chars.length)
        let out = chars.slice(0, settled).join('')
        for (let i = settled; i < Math.min(chars.length, settled + 3); i++) {
          out += chars[i] === ' ' ? ' ' : GLYPHS[(Math.random() * GLYPHS.length) | 0]
        }
        textEl.textContent = out
      },
      onComplete: () => {
        textEl.textContent = text
      },
    })
  }

  return {
    update(p) {
      let next = 0
      CALLOUTS.forEach((call, i) => {
        if (p >= call.at) next = i
      })
      if (next === index) return
      const first = index === -1
      index = next
      const call = CALLOUTS[next]
      timeEl.textContent = call.stamp
      root.dataset.tone = call.tone
      if (first && next === 0) {
        root.dataset.fresh = 'false'
        return
      }
      root.dataset.fresh = 'true'
      type(call.text, Math.min(0.9, 0.25 + call.text.length * 0.022))
      settle?.kill()
      settle = gsap.delayedCall(3.4, () => {
        root.dataset.fresh = 'false'
      })
    },
  }
}

/* ---------------------------------------------------------------------------------- */

/** Intro title card + one event card at a time, with masked character reveals. */
function createStory(section) {
  const intro = $('.s-ascent__intro', section)
  const entryHost = $('.s-ascent__shade', section)
  const cards = $$('.s-ascent__event', section).map((el) => {
    const headline = $('.s-ascent__headline', el)
    const original = headline.innerHTML
    // Flight sizes always fit on one line; soft hyphens would only confuse the split.
    headline.textContent = headline.textContent.replace(/\u00ad/g, '')
    // Words stay intact (no mid-word breaks); each character rises out of its own mask.
    const split = SplitText.create(headline, { type: 'words,chars', mask: 'chars', charsClass: 'ascent-char', wordsClass: 'ascent-word' })
    return {
      el,
      meta: $('.s-ascent__meta', el),
      chars: split.chars,
      rest: [$('.s-ascent__line', el), $('.s-ascent__body', el)].filter(Boolean),
      split,
      restore: () => {
        split.revert()
        headline.innerHTML = original
      },
    }
  })
  gsap.set(cards.map((c) => c.el), { opacity: 0 })

  let active = -2
  let introShown = true
  let lastEntry = ''

  function show(card, dir) {
    gsap.killTweensOf([card.el, card.meta, card.chars, card.rest])
    gsap.set(card.el, { opacity: 1, y: 0 })
    const tl = gsap.timeline()
    tl.fromTo(card.meta, { opacity: 0, x: -18 }, { opacity: 1, x: 0, duration: 0.9, ease: 'expo.out' }, 0)
    tl.fromTo(
      card.chars,
      { yPercent: 115 * dir },
      { yPercent: 0, duration: 1.1, ease: 'expo.out', stagger: { each: 0.028 } },
      0.06,
    )
    tl.fromTo(card.rest, { opacity: 0, y: 16 * dir }, { opacity: 1, y: 0, duration: 1, ease: 'expo.out', stagger: 0.09 }, 0.22)
  }

  function hide(card, dir) {
    gsap.killTweensOf([card.el, card.meta, card.chars, card.rest])
    gsap.to(card.el, {
      opacity: 0,
      y: -26 * dir,
      duration: 0.4,
      ease: 'power2.in',
      onComplete: () => gsap.set(card.el, { y: 0 }),
    })
  }

  function setIntro(visible) {
    if (visible === introShown) return
    introShown = visible
    gsap.killTweensOf(intro)
    gsap.to(intro, {
      opacity: visible ? 1 : 0,
      y: visible ? 0 : -30,
      duration: visible ? 0.9 : 0.5,
      ease: visible ? 'expo.out' : 'power2.in',
    })
  }

  return {
    update(p, tm) {
      setIntro(p < BEATS.ignition - 0.012)

      const entry = (1 - clamp(p / 0.05)).toFixed(3)
      if (entry !== lastEntry) {
        entryHost.style.setProperty('--ascent-entry', entry)
        lastEntry = entry
      }

      if (tm.event === active) return
      const dir = tm.event > active ? 1 : -1
      if (cards[active]) hide(cards[active], dir)
      if (cards[tm.event]) show(cards[tm.event], dir)
      active = tm.event
    },
    destroy() {
      cards.forEach((c) => c.restore())
      gsap.set([intro, ...cards.map((c) => c.el)], { clearProps: 'all' })
    },
  }
}
