/**
 * THE FLEET — SXSI's family of intelligence "vehicles", shown as holograms on
 * a projector pad with aerospace spec sheets and a relative-scale selector.
 *
 * One markup, three behaviours:
 *   - no JS: every vehicle is a stacked, readable article;
 *   - pinned (wide screens, motion allowed): the stage pins and scrolling
 *     advances the vehicles; the selector scrolls to a vehicle;
 *   - tabs (narrow screens, reduced motion): the selector switches vehicles
 *     directly, and the hologram can be swiped on touch.
 * The selector is always a real ARIA tablist (←/→, Home/End). With a mouse or
 * pen, the hologram can be dragged to turn it (with inertia).
 *
 * The WebGL scene (scene.js) is lazy-loaded and only reads `view`; every tween
 * lives here so choreography, scroll and reduced motion stay in one place.
 */
import { gsap, ScrollTrigger, scrollToTarget } from '../../lib/motion.js'
import { SplitText } from 'gsap/SplitText'
import { booted, emit } from '../../lib/bus.js'
import { hasWebGL, isTouch, reducedMotion } from '../../lib/quality.js'
import { observeVisibility } from '../../lib/visibility.js'
import { $, $$, clamp, pad } from '../../lib/dom.js'

gsap.registerPlugin(SplitText)

const PIN_QUERY = '(min-width: 1024px) and (min-height: 620px)'
const SCROLL_PER_VEHICLE = 0.8 // viewport heights of scroll per vehicle while pinned
const GLYPHS = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789/#+-'

export function init() {
  const root = document.getElementById('fleet')
  const stage = root && $('[data-fleet-stage]', root)
  if (!stage) return

  const tablist = $('[data-fleet-tabs]', root)
  const tabs = $$('[data-fleet-tab]', root)
  const panels = $$('[data-fleet-panel]', root)
  const viz = $('[data-fleet-viz]', root)
  const rail = $('[data-fleet-rail]', root)
  const count = panels.length

  // Read by the WebGL scene every frame. from/to: vehicle indices (-1 = dust on
  // the pad), mix: rebuild progress, heat: classified glow, boost: spin impulse,
  // px/py: pointer parallax, yaw: extra turn from dragging.
  const view = { from: -1, to: 0, mix: 0, heat: 0, boost: 0, px: 0, py: 0, yaw: 0 }
  const ui = {
    count: $('[data-fleet-count]', root),
    frameNum: $('[data-fleet-frame-num]', root),
    rot: $('[data-fleet-rot]', root),
    cue: $('[data-fleet-cue]', root),
  }

  let active = 0
  let mode = 'tabs'
  let pin = null
  let pending = null // vehicle we are scrolling toward after a tab press
  let pendingTimer = 0
  let scene = null

  root.classList.add('is-enhanced')
  stage.dataset.active = '0'
  upgradeToTablist(tablist, tabs, panels)
  const fx = createPanelFx(panels)
  const morph = createMorph(view, () => scene)

  /* ---- Selection ----------------------------------------------------------- */
  function select(index) {
    index = clamp(index, 0, count - 1)
    if (index === active) return
    const prev = active
    active = index
    tabs.forEach((tab, i) => {
      tab.setAttribute('aria-selected', String(i === index))
      tab.tabIndex = i === index ? 0 : -1
    })
    stage.dataset.active = String(index)
    if (ui.count) ui.count.textContent = pad(index + 1)
    if (ui.frameNum) ui.frameNum.textContent = pad(index + 1)
    if (mode !== 'pinned') setRail((index + 1) / count)
    fx.show(index, prev, index > prev ? 1 : -1)
    morph.to(index)
    emit('sound:cue', { type: 'whoosh' })
  }

  function go(index) {
    if (mode === 'pinned' && pin) {
      pending = index
      clearTimeout(pendingTimer)
      pendingTimer = setTimeout(() => (pending = null), 2200)
      select(index)
      scrollToTarget(pin.start + (pin.end - pin.start) * ((index + 0.5) / count), { duration: 1.2 })
    } else {
      select(index)
    }
  }

  const setRail = (p) => {
    if (rail) rail.style.transform = `scaleX(${p.toFixed(4)})`
  }
  setRail(1 / count)

  tablist.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-fleet-tab]')
    if (tab) go(Number(tab.dataset.fleetTab))
  })
  tablist.addEventListener('keydown', (event) => {
    const current = tabs.indexOf(document.activeElement)
    if (current < 0) return
    const next = { ArrowRight: current + 1, ArrowLeft: current - 1, Home: 0, End: count - 1 }[event.key]
    if (next === undefined) return
    event.preventDefault()
    const index = (next + count) % count
    tabs[index].focus({ preventScroll: true })
    go(index)
  })

  /* ---- Pinned scroll sequence (wide screens, motion allowed) ---------------- */
  if (!reducedMotion) {
    const mm = gsap.matchMedia()
    mm.add(PIN_QUERY, () => {
      mode = 'pinned'
      root.classList.add('is-pinned')
      setRail(1 / count / 4)
      pin = ScrollTrigger.create({
        trigger: stage,
        start: 'top top',
        end: () => `+=${Math.round(window.innerHeight * (SCROLL_PER_VEHICLE * (count - 1) + 0.5))}`,
        pin: true,
        pinSpacing: true,
        anticipatePin: 1,
        invalidateOnRefresh: true,
        onUpdate: (self) => {
          setRail(Math.max(self.progress, 1 / count / 4)) // scrubbed with the pin
          ui.cue?.classList.toggle('is-gone', self.progress > 0.04)
          view.boost = Math.min(3, Math.max(view.boost, Math.abs(self.getVelocity()) / 1600))
          const index = Math.min(count - 1, Math.floor(self.progress * count))
          if (pending !== null) {
            if (index !== pending) return
            pending = null
          }
          select(index)
        },
      })
      return () => {
        mode = 'tabs'
        pin = null
        root.classList.remove('is-pinned')
        setRail((active + 1) / count)
      }
    })
  }

  /* ---- Hologram ------------------------------------------------------------ */
  initPointer(stage, view)
  initSwipe(viz, () => mode === 'tabs', (step) => select(active + step))
  // Reduced motion has no render loop: draw a frame per drag step instead.
  let redraw = 0
  initDrag(viz, view, () => Boolean(scene), () => {
    if (!reducedMotion || redraw) return
    redraw = requestAnimationFrame(() => {
      redraw = 0
      scene?.render()
    })
  })

  const fallback = () => {
    scene = null
    root.classList.remove('is-webgl')
    root.classList.add('is-fallback')
  }
  const forceStatic = new URLSearchParams(location.search).get('fleet') === 'static'
  if (forceStatic || !hasWebGL()) fallback()
  else {
    // Building the vehicles + compiling shaders is a one-off ~50ms task: do it
    // when the page is idle after boot, or as the visitor approaches.
    const sceneModule = import('./scene.js')
    whenNeeded(stage, () => sceneModule)
      .then(({ createFleetScene }) => {
        let lastRotAt = 0
        scene = createFleetScene({
          canvas: $('[data-fleet-canvas]', root),
          viz,
          anchor: $('[data-fleet-anchor]', root),
          view,
          animate: !reducedMotion,
          onLost: fallback,
          // HUD readout, throttled to ~8 Hz (it's a label, not an animation)
          onFrame: (rotation) => {
            const now = performance.now()
            if (!ui.rot || now - lastRotAt < 120) return
            lastRotAt = now
            ui.rot.textContent = (rotation < 0 ? rotation + 360 : rotation).toFixed(1).padStart(5, '0')
          },
        })
        root.classList.add('is-webgl')
      })
      .catch((error) => {
        console.error('[sxsi] fleet hologram unavailable', error)
        fallback()
      })
  }

  /* ---- Entrances ------------------------------------------------------------- */
  if (reducedMotion) {
    morph.settle(active)
  } else {
    // The projector "prints" the first vehicle out of the dust on the pad.
    // Fires once the hologram's focus is on screen, so the build is seen.
    ScrollTrigger.create({ trigger: stage, start: 'top 42%', once: true, onEnter: () => morph.start() })
    revealHead(root)
  }
}

/* --------------------------------------------------------------------------
 * Accessibility: upgrade the static line-up to a tablist
 * ------------------------------------------------------------------------ */
function upgradeToTablist(tablist, tabs, panels) {
  tablist.setAttribute('role', 'tablist')
  tablist.setAttribute('aria-label', 'Fleet vehicles')
  tabs.forEach((tab, i) => {
    tab.setAttribute('role', 'tab')
    tab.setAttribute('aria-selected', String(i === 0))
    tab.tabIndex = i === 0 ? 0 : -1
  })
  panels.forEach((panel, i) => {
    panel.setAttribute('role', 'tabpanel')
    panel.setAttribute('aria-labelledby', tabs[i].id)
    panel.tabIndex = 0
    panel.classList.toggle('is-active', i === 0)
    panel.inert = i !== 0
  })
}

/* --------------------------------------------------------------------------
 * Hologram rebuilds (scene state). A rebuild already in flight is hurried
 * along rather than interrupted, then the latest request plays.
 * ------------------------------------------------------------------------ */
function createMorph(view, getScene) {
  let started = false
  let tween = null
  let queued = null

  const heat = (index) => gsap.to(view, { heat: index === 3 ? 1 : 0, duration: 1.8, ease: 'power2.inOut', overwrite: 'auto' })

  const run = (duration) => {
    heat(view.to)
    tween = gsap.to(view, {
      mix: 1,
      duration,
      ease: 'power1.inOut',
      onComplete: () => {
        tween = null
        view.from = view.to
        if (queued !== null && queued !== view.to) {
          view.to = queued
          view.mix = 0
          queued = null
          run(1.7)
        }
        queued = null
      },
    })
  }

  return {
    /** First appearance: dust on the pad → the selected vehicle. */
    start() {
      if (started) return
      started = true
      view.from = -1
      view.mix = 0
      run(2.8)
    },
    to(index) {
      if (!started) {
        view.to = index
        return
      }
      if (reducedMotion) return this.settle(index)
      if (tween) {
        queued = index === view.to ? null : index
        tween.timeScale(2.6)
        return
      }
      if (index === view.to) return
      view.from = view.to
      view.to = index
      view.mix = 0
      run(2.1)
    },
    /** Jump straight to a finished vehicle (reduced motion). */
    settle(index) {
      started = true
      Object.assign(view, { from: index, to: index, mix: 1, heat: index === 3 ? 1 : 0 })
      getScene()?.render()
    },
  }
}

/* --------------------------------------------------------------------------
 * Panel transitions: masked name, staggered copy, decoding spec values
 * ------------------------------------------------------------------------ */
function createPanelFx(panels) {
  const parts = panels.map((panel) => {
    // Scrambled values render into an aria-hidden twin; the real text stays put.
    const values = $$('.s-fleet__spec-row dd', panel)
      .filter((dd) => !dd.querySelector('.s-fleet__bar, .status'))
      .map((dd) => {
        const text = dd.textContent.trim()
        dd.textContent = ''
        const real = Object.assign(document.createElement('span'), { className: 'sr-only', textContent: text })
        const shown = Object.assign(document.createElement('span'), { textContent: text })
        shown.setAttribute('aria-hidden', 'true')
        dd.append(real, shown)
        return { el: shown, text }
      })

    const name = $('[data-fleet-part="name"]', panel)
    const split = reducedMotion ? null : SplitText.create(name, { type: 'chars', mask: 'chars', charsClass: 's-fleet__char' })

    return {
      panel,
      index: $('[data-fleet-part="index"]', panel),
      chars: split ? split.chars : [],
      fades: $$('[data-fleet-part="fade"]', panel),
      rows: [$('.s-fleet__spec-title', panel), ...$$('.s-fleet__spec-row', panel)],
      bars: $$('.s-fleet__bar', panel),
      values,
      tl: null,
    }
  })

  const decode = ({ el, text }, delay) => {
    gsap.killTweensOf(el)
    const progress = { p: 0 }
    gsap.to(progress, {
      p: 1,
      duration: 0.75,
      delay,
      ease: 'power1.in',
      onUpdate: () => {
        const n = Math.floor(progress.p * text.length)
        let out = text.slice(0, n)
        for (let i = n; i < text.length; i++) out += text[i] === ' ' ? ' ' : GLYPHS[(Math.random() * GLYPHS.length) | 0]
        el.textContent = out
      },
      onComplete: () => (el.textContent = text),
      onInterrupt: () => (el.textContent = text),
    })
  }

  /** Adds a tween to `tl` unless there is nothing to animate (avoids GSAP warnings). */
  const step = (tl, method, targets, ...args) => {
    const list = [].concat(targets).filter(Boolean)
    if (list.length) tl[method](list, ...args)
  }

  const elementsOf = (p) => [p.index, ...p.chars, ...p.fades, ...p.rows, ...p.bars].filter(Boolean)

  return {
    show(next, prev, dir) {
      const n = parts[next]
      const p = parts[prev]

      p.panel.classList.remove('is-active')
      p.panel.inert = true
      n.panel.classList.add('is-active')
      n.panel.classList.remove('is-leaving')
      n.panel.inert = false
      if (reducedMotion) return

      // Outgoing: lift away.
      p.tl?.kill()
      p.panel.classList.add('is-leaving')
      p.tl = gsap.timeline({
        onComplete: () => {
          p.panel.classList.remove('is-leaving')
          gsap.set(elementsOf(p), { clearProps: 'opacity,transform' })
        },
      })
      step(p.tl, 'to', p.chars, { yPercent: -110 * dir, duration: 0.5, ease: 'power3.in', stagger: 0.02 }, 0)
      step(p.tl, 'to', [...p.fades, ...p.rows], { opacity: 0, y: -14 * dir, duration: 0.38, ease: 'power2.in', stagger: 0.015 }, 0)
      step(p.tl, 'to', p.index, { opacity: 0, yPercent: -10 * dir, duration: 0.5, ease: 'power2.in' }, 0)

      // Incoming: type rises through its mask, values decode, redactions slam shut.
      n.tl?.kill()
      n.values.forEach((v) => gsap.killTweensOf(v.el))
      n.tl = gsap.timeline({ delay: 0.24 })
      step(n.tl, 'fromTo', n.index, { opacity: 0, yPercent: 12 * dir }, { opacity: 1, yPercent: 0, duration: 1.8, ease: 'expo.out' }, 0)
      step(n.tl, 'fromTo', n.chars, { yPercent: 110 * dir }, { yPercent: 0, duration: 1.25, ease: 'expo.out', stagger: 0.05 }, 0.04)
      step(n.tl, 'fromTo', n.fades, { opacity: 0, y: 18 * dir }, { opacity: 1, y: 0, duration: 1.2, ease: 'expo.out', stagger: 0.08 }, 0.16)
      step(n.tl, 'fromTo', n.rows, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.9, ease: 'expo.out', stagger: 0.045 }, 0.3)
      step(n.tl, 'fromTo', n.bars, { scaleX: 0 }, { scaleX: 1, duration: 0.7, ease: 'expo.inOut', stagger: 0.07 }, 0.62)
      n.tl.add(() => n.values.forEach((v, i) => decode(v, i * 0.06)), 0.34)
    },
  }
}

/* --------------------------------------------------------------------------
 * Head reveal
 * ------------------------------------------------------------------------ */
function revealHead(root) {
  const head = $('.s-fleet__head', root)
  const title = $('.s-fleet__title', root)
  const items = $$('[data-fleet-reveal]', root).filter((el) => el !== title)
  const split = SplitText.create(title, { type: 'chars', mask: 'chars', charsClass: 's-fleet__char' })
  gsap.set(split.chars, { yPercent: 110 })
  gsap.set(items, { opacity: 0, y: 24 })
  ScrollTrigger.create({
    trigger: head,
    start: 'top 80%',
    once: true,
    onEnter: () => {
      gsap.to(split.chars, { yPercent: 0, duration: 1.5, ease: 'expo.out', stagger: 0.04 })
      gsap.to(items, { opacity: 1, y: 0, duration: 1.4, ease: 'expo.out', stagger: 0.12, delay: 0.2 })
    },
  })
}

/* --------------------------------------------------------------------------
 * Scheduling: resolves with `load()` once the page is idle after boot, or as
 * soon as `el` comes within two viewports — whichever happens first.
 * ------------------------------------------------------------------------ */
function whenNeeded(el, load) {
  return new Promise((resolve) => {
    let done = false
    let stop = null
    const run = () => {
      if (done) return
      done = true
      stop?.()
      resolve(load())
    }
    stop = observeVisibility(el, (visible) => visible && run(), { rootMargin: '200% 0px' })
    if (done) stop()
    booted.then(() => {
      const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1200))
      setTimeout(() => idle(run, { timeout: 4000 }), 2500)
    })
  })
}

/* --------------------------------------------------------------------------
 * Pointer parallax (fine pointers) and swipe (touch, tabs mode)
 * ------------------------------------------------------------------------ */
function initPointer(stage, view) {
  if (isTouch || reducedMotion) return
  const toX = gsap.quickTo(view, 'px', { duration: 1.6, ease: 'power3.out' })
  const toY = gsap.quickTo(view, 'py', { duration: 1.6, ease: 'power3.out' })
  stage.addEventListener('pointermove', (event) => {
    toX((event.clientX / window.innerWidth) * 2 - 1)
    toY((event.clientY / window.innerHeight) * 2 - 1)
  })
  stage.addEventListener('pointerleave', () => {
    toX(0)
    toY(0)
  })
}

/** Mouse / pen: drag the hologram to turn it; it coasts to a stop on release. */
function initDrag(el, view, enabled, onMove) {
  if (!el) return
  const RAD_PER_PX = 0.0065
  let drag = null
  const end = (event) => {
    if (!drag) return
    if (el.hasPointerCapture?.(event.pointerId)) el.releasePointerCapture(event.pointerId)
    el.classList.remove('is-dragging')
    if (!reducedMotion && Math.abs(drag.v) > 0.05) {
      gsap.to(view, { yaw: view.yaw + clamp(drag.v, -7, 7) * 0.38, duration: 1.8, ease: 'power3.out', overwrite: 'auto' })
    }
    drag = null
  }
  el.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'touch' || event.button !== 0 || !enabled()) return
    gsap.killTweensOf(view, 'yaw')
    drag = { x: event.clientX, t: performance.now(), v: 0 }
    el.setPointerCapture?.(event.pointerId)
    el.classList.add('is-dragging')
    event.preventDefault()
  })
  el.addEventListener('pointermove', (event) => {
    if (!drag) return
    const now = performance.now()
    const delta = (event.clientX - drag.x) * RAD_PER_PX
    const instant = (delta / Math.max(8, now - drag.t)) * 1000 // rad/s
    drag.v += (instant - drag.v) * 0.45
    drag.x = event.clientX
    drag.t = now
    view.yaw += delta
    onMove()
  })
  el.addEventListener('pointerup', end)
  el.addEventListener('pointercancel', end)
}

function initSwipe(el, enabled, onStep) {
  if (!el) return
  let start = null
  el.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'touch' || !enabled()) return
    start = { x: event.clientX, y: event.clientY }
  })
  el.addEventListener('pointerup', (event) => {
    if (!start) return
    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    start = null
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.4) onStep(dx < 0 ? 1 : -1)
  })
  el.addEventListener('pointercancel', () => (start = null))
}
