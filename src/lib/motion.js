/**
 * Motion foundation: GSAP + ScrollTrigger driven by Lenis smooth scrolling.
 * Import `gsap` / `ScrollTrigger` from here (not from 'gsap' directly) so every
 * section shares the same registered instance.
 */
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import Lenis from 'lenis'
import { reducedMotion } from './quality.js'
import { booted } from './bus.js'

gsap.registerPlugin(ScrollTrigger)
// Mobile address-bar show/hide would otherwise re-measure every pinned section.
ScrollTrigger.config({ ignoreMobileResize: true })

/** Shared Lenis instance (null under reduced motion — native scrolling then). */
export let lenis = null

let initialised = false

export function initMotion() {
  if (initialised) return
  initialised = true

  // ScrollTrigger captured the restoration mode when it registered and puts it
  // back after every refresh; the reading position below owns scroll restoring.
  ScrollTrigger.clearScrollMemory('manual')

  if (!reducedMotion) {
    lenis = new Lenis({ lerp: 0.09, smoothWheel: true, wheelMultiplier: 0.9 })
    lenis.on('scroll', ScrollTrigger.update)
    gsap.ticker.add((time) => lenis.raf(time * 1000))
    gsap.ticker.lagSmoothing(0)
  }

  initAnchorLinks()
  initReadingPosition()

  // Fonts and late images change layout — recompute trigger positions, then put
  // a deep-linked / reloaded visitor back where they asked to be.
  const fontsReady = document.fonts?.ready ?? Promise.resolve()
  fontsReady.then(() => {
    ScrollTrigger.refresh()
    startupStep('fonts')
  })
  if (document.readyState === 'complete') startupStep('load')
  else {
    window.addEventListener(
      'load',
      () => {
        ScrollTrigger.refresh()
        startupStep('load')
      },
      { once: true },
    )
  }

  // Handle for tooling (screenshots / debugging). `ready`: every section has initialised.
  window.__sxsi = { gsap, ScrollTrigger, get lenis() { return lenis }, get ready() { return sectionsReady } }
}

/** Smoothly scrolls to an element, selector or y position. */
export function scrollToTarget(target, { offset = 0, immediate = false, duration } = {}) {
  const el = typeof target === 'string' ? document.querySelector(target) : target
  if (el == null) return
  // Somebody is deliberately moving the page: drop any pending restore.
  cancelRestore()
  move(el, { offset, immediate, duration })
}

function move(el, { offset = 0, immediate = false, duration } = {}) {
  if (lenis) {
    lenis.scrollTo(el, { offset, immediate, duration, force: true })
  } else if (typeof el === 'number') {
    window.scrollTo({ top: el + offset, behavior: immediate || reducedMotion ? 'auto' : 'smooth' })
  } else {
    const top = el.getBoundingClientRect().top + window.scrollY + offset
    window.scrollTo({ top, behavior: immediate || reducedMotion ? 'auto' : 'smooth' })
  }
}

/**
 * ScrollTrigger.sort() (page order, so each trigger includes the spacing of the
 * pins above it), with one addition: among triggers on the same element the pin
 * goes first, as its siblings measure against it (e.g. `end: () => pin.end`).
 * That keeps the order identical whether a pin was built at load or rebuilt by a
 * breakpoint flip (which appends it to the end of the list). Other ties keep
 * their creation order, exactly as ScrollTrigger.sort() does.
 */
export function sortTriggers() {
  const scroll = window.scrollY
  const keys = new Map()
  for (const st of ScrollTrigger.getAll()) {
    const y = st.vars.containerAnimation ? 1e6 : st.trigger ? scroll + st.trigger.getBoundingClientRect().top : st.start + window.innerHeight
    keys.set(st, y - (st.vars.refreshPriority || 0) * 1e6)
  }
  ScrollTrigger.sort((a, b) => keys.get(a) - keys.get(b) || (a.trigger === b.trigger ? Boolean(b.pin) - Boolean(a.pin) : 0))
}

/** Pause / resume page scrolling (e.g. while a modal or boot overlay is open). */
export function lockScroll(locked) {
  if (lenis) locked ? lenis.stop() : lenis.start()
  document.documentElement.classList.toggle('is-scroll-locked', locked)
}

/**
 * Page y at which an anchor jump to `el` should land: its top (or, for a pinned
 * section, its pin start — the element itself is offset while pinned) less the
 * nav offset that `scroll-padding-top` gives native anchors.
 */
export function anchorY(el) {
  const pin = ScrollTrigger.getAll().find((st) => st.pin === el)
  const top = pin ? pin.start : outerBox(el).getBoundingClientRect().top + window.scrollY
  const padding = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0
  const margin = parseFloat(getComputedStyle(el).scrollMarginTop) || 0
  return top - padding - margin
}

function initAnchorLinks() {
  document.addEventListener('click', (event) => {
    const link = event.target.closest?.('a[href^="#"]')
    if (!link || event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey) return
    const id = link.getAttribute('href').slice(1)
    if (!id) return
    const el = document.getElementById(id)
    if (!el) return
    event.preventDefault()
    // Remember where we left from, so Back returns there (scroll restoration is manual).
    rememberInHistory()
    scrollToTarget(anchorY(el))
    history.pushState(null, '', `#${id}`)
    // Move focus for keyboard / screen-reader users without a second jump.
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1')
    el.focus({ preventScroll: true })
  })
}

/* ==========================================================================
   Reading position
   The page grows by thousands of px after load (pins add their spacing) and a
   breakpoint flip tears pins down and rebuilds them. Browsers and ScrollTrigger
   keep the scroll *pixel*, which then belongs to another section. So we keep a
   reading position instead — the section under the viewport centre and how far
   through it — and put the page back on it (or on a #deep-link) once a refresh
   has settled the layout.
   ========================================================================== */
const POSITION_KEY = 'sxsi:position'
const RESIZE_HOLD = 600 // ms the position is held after a resize (the jump to 0 can't overwrite it)
const RESIZE_WAIT = 3000 // ...extended until a refresh has happened, but never longer than this
const SETTLE_GRACE = 3000 // ms a deep link / reload target is still held after start-up
const SECTIONS = 'main > section[id], main > .pin-spacer > section[id], body > footer'
const SCROLL_KEYS = /^(Arrow(Up|Down|Left|Right)|Page(Up|Down)|Home|End|Tab| |Spacebar)$/

let position = null // { id, f } — kept current while the visitor scrolls
let target = null // { y(): number | null, position? } — where the page must be once layout settles
let holdUntil = 0
let holdTimer = 0
let releaseTimer = 0
let resizeId = 0
let refreshedId = 0
let geometry = null
let startupSteps = null // start-up refreshes still to come; null once settled
let lastSize = { w: 0, h: 0 }
let sectionsReady = false

/** A pinned section's own box is offset while pinned; its spacer is not. */
const outerBox = (el) => (el.parentElement?.classList.contains('pin-spacer') ? el.parentElement : el)

function sections() {
  if (geometry) return geometry
  const y = window.scrollY
  geometry = [...document.querySelectorAll(SECTIONS)].map((el) => {
    const box = outerBox(el).getBoundingClientRect()
    return { id: el.id || el.localName, top: box.top + y, height: box.height }
  })
  return geometry
}

function readPosition() {
  const list = sections()
  if (!list.length) return null
  const ref = window.scrollY + window.innerHeight / 2
  const s = list.find((item) => ref < item.top + item.height) ?? list[list.length - 1]
  return { id: s.id, f: (ref - s.top) / Math.max(1, s.height) }
}

function positionY({ id, f }) {
  geometry = null
  const s = sections().find((item) => item.id === id)
  return s ? s.top + f * s.height - window.innerHeight / 2 : null
}

function hashTarget() {
  let id = ''
  try {
    id = decodeURIComponent(location.hash.slice(1))
  } catch {
    return null
  }
  const el = id && document.getElementById(id)
  return el ? { y: () => anchorY(el) } : null
}

function positionTarget(saved) {
  return saved && typeof saved.id === 'string' && Number.isFinite(saved.f)
    ? { position: { id: saved.id, f: saved.f }, y: () => positionY(saved) }
    : null
}

/** Jumps (no animation) to `y` — Lenis' limit is re-measured first: refreshes just changed the page height. */
function jumpTo(y) {
  if (y == null || !Number.isFinite(y)) return
  const max = ScrollTrigger.maxScroll(window)
  const top = Math.max(0, Math.min(y, max))
  if (Math.abs(window.scrollY - top) <= 1) return
  lenis?.resize()
  move(top, { immediate: true })
}

function restore({ early = false } = {}) {
  if (!target || startupSteps?.has('boot')) return // the boot overlay hasn't handed over yet
  if (!early && startupSteps?.has('sections')) return // pins still being built
  jumpTo(target.y())
}

function cancelRestore() {
  target = null
  holdUntil = 0
  startupSteps = null
  clearTimeout(releaseTimer)
}

/** End of the start-up grace period: from here on the reading position follows the visitor. */
function release() {
  if (target && !target.resize) target = null
  if (!target && performance.now() >= holdUntil) position = readPosition()
}

/** Called once per start-up milestone (sections, boot, fonts, load); restores after each. */
function startupStep(name) {
  if (!startupSteps) return
  startupSteps.delete(name)
  restore()
  if (startupSteps.size) return
  startupSteps = null
  // Lazy content can still shift the layout just after start-up: keep the target a moment longer.
  releaseTimer = setTimeout(release, SETTLE_GRACE)
}

/**
 * Call after each section's init: the sections above a deep-linked / reloaded
 * position (initialised in page order) have built their pins, so it can already
 * be brought into view while the rest initialise — on a slow device that is
 * seconds sooner. settleScroll() then lands it exactly.
 */
export function restoreScroll() {
  restore({ early: true })
}

/**
 * Call after the start-up ScrollTrigger.refresh(): lands a deep link / reload on
 * its section (after the boot overlay hands over, if it is playing).
 */
export function settleScroll() {
  sectionsReady = true
  startupStep('sections')
}

function rememberInHistory() {
  const now = readPosition()
  if (!now) return
  try {
    history.replaceState({ ...(history.state || {}), sxsiPosition: now }, '')
  } catch {
    /* state too large / blocked: Back simply keeps the position */
  }
}

function save() {
  if (!target && performance.now() >= holdUntil) position = readPosition()
  const now = target ? target.position : position
  try {
    if (now) sessionStorage.setItem(POSITION_KEY, JSON.stringify({ path: location.pathname, ...now }))
    else sessionStorage.removeItem(POSITION_KEY)
  } catch {
    /* no session storage: a reload starts at the top */
  }
}

function readSaved() {
  const type = performance.getEntriesByType?.('navigation')?.[0]?.type
  if (type !== 'reload' && type !== 'back_forward') return null
  try {
    const saved = JSON.parse(sessionStorage.getItem(POSITION_KEY) || 'null')
    return saved?.path === location.pathname ? saved : null
  } catch {
    return null
  }
}

function initReadingPosition() {
  // Reload / Back: the section the visitor was reading. Fresh visit: the #deep-link.
  target = positionTarget(readSaved()) || hashTarget()
  startupSteps = new Set(['sections', 'boot', 'fonts', 'load'])
  booted.then(() => startupStep('boot'))
  lastSize = { w: window.innerWidth, h: window.innerHeight }

  const track = () => {
    if (!target && !startupSteps && performance.now() >= holdUntil) position = readPosition()
  }
  if (lenis) lenis.on('scroll', track)
  else window.addEventListener('scroll', track, { passive: true })

  // Layout changed: re-measure lazily (and keep a deep link / reload on its section).
  const invalidate = () => (geometry = null)
  let relayout = 0
  if (typeof ResizeObserver === 'function') {
    const main = document.querySelector('main')
    const ro = new ResizeObserver(() => {
      invalidate()
      if (!target || target.resize || relayout) return
      relayout = requestAnimationFrame(() => {
        relayout = 0
        restore()
      })
    })
    if (main) ro.observe(main)
  }

  ScrollTrigger.addEventListener('refresh', () => {
    invalidate()
    refreshedId = resizeId
    if (target) restore()
  })

  // ---- Resize / rotation: hold the position, put it back after the refresh ----
  const endHold = () => {
    // No refresh since the last resize yet (a busy main thread delays it): keep holding.
    if (refreshedId !== resizeId && performance.now() < holdUntil + RESIZE_WAIT - RESIZE_HOLD) {
      holdTimer = setTimeout(endHold, 150)
      return
    }
    holdUntil = 0
    if (target?.resize) target = null
    if (!target && !startupSteps) position = readPosition()
  }
  window.addEventListener('resize', () => {
    invalidate()
    const w = window.innerWidth
    const h = window.innerHeight
    // Touch, same width: an address bar showing/hiding (ScrollTrigger ignores those too) or
    // a keyboard opening, which the browser scrolls for itself. Neither is a reflow to restore.
    const active = document.activeElement
    const typing = active?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active?.tagName)
    const minor = ScrollTrigger.isTouch === 1 && w === lastSize.w && (typing || Math.abs(h - lastSize.h) < h * 0.25)
    lastSize = { w, h }
    if (minor) return
    resizeId++
    holdUntil = performance.now() + RESIZE_HOLD
    if (!target && position) {
      const held = position
      target = { resize: true, position: held, y: () => positionY(held) }
    }
    clearTimeout(holdTimer)
    holdTimer = setTimeout(endHold, RESIZE_HOLD)
  })

  // ---- The visitor takes over: never yank them back afterwards ----
  const takeOver = () => {
    if (!target && !startupSteps && !holdUntil) return
    // The boot overlay's own "any key / tap to skip" is not scrolling.
    const root = document.documentElement
    if (root.dataset.boot === 'run' && root.dataset.booted !== 'true') return
    cancelRestore()
    clearTimeout(holdTimer)
    position = readPosition()
  }
  const opts = { capture: true, passive: true }
  window.addEventListener('wheel', takeOver, opts)
  window.addEventListener('touchmove', takeOver, opts)
  // Keys that scroll or move focus — or typing into a field, which scrolls it into
  // view. Not reload (F5 / ⌘R): the position is saved for the reload instead.
  window.addEventListener('keydown', (event) => {
    const editing = event.target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName)
    if (SCROLL_KEYS.test(event.key) || (editing && !event.metaKey && !event.ctrlKey)) takeOver()
  }, opts)
  // Scrollbar drag / middle-button autoscroll.
  window.addEventListener('pointerdown', (event) => {
    if (event.target === document.documentElement || event.button === 1) takeOver()
  }, opts)

  // ---- Back / Forward between in-page entries (scroll restoration is manual) ----
  window.addEventListener('popstate', (event) => {
    const saved = positionTarget(event.state?.sxsiPosition) || hashTarget()
    if (!saved) return
    cancelRestore()
    jumpTo(saved.y())
  })

  // ---- Reload: remember the reading position for this tab ----
  window.addEventListener('pagehide', save)
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && save())
}

export { gsap, ScrollTrigger }
