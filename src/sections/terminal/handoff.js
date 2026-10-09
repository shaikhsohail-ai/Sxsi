/**
 * Launch hand-off: after T−0 the page flies back up to the Ascent section's
 * launch pad and — autopilot — scrolls through its pinned flight to orbit.
 * Any wheel, touch, key or pointer input hands control straight back.
 *
 * Why not `scrollToTarget('#ascent')`: once the visitor is below a pinned
 * section, GSAP has offset the pinned element to the end of its pin span, so
 * measuring the element lands on the *end* of the flight (orbit already
 * reached). The pin's ScrollTrigger knows where the flight really starts.
 */
import { lenis, ScrollTrigger, scrollToTarget } from '../../lib/motion.js'
import { on } from '../../lib/bus.js'

// Leg 1 — the long fly-back up the page: accelerate hard, settle on the pad.
const expoInOut = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? 2 ** (20 * t - 10) / 2 : (2 - 2 ** (-20 * t + 10)) / 2)
// Leg 2 — the ascent: heavy, slow liftoff, hard acceleration, gentle orbit insertion.
const ascentEase = (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2)

const INTERRUPTS = ['wheel', 'touchstart', 'keydown', 'pointerdown']

/** Where `section`'s pinned flight starts / ends in page px (null when it isn't pinned). */
function span(section) {
  const pin = ScrollTrigger.getAll().find((trigger) => trigger.pin === section)
  return pin ? { start: pin.start, end: pin.end } : null
}

/**
 * Plans the hand-off to section `id`. Returns null if the section is missing,
 * otherwise `{ autopilot, go() }` — `autopilot` tells the console whether it
 * will fly the ascent or simply land on it.
 */
export function planHandoff(id = 'ascent', { reducedMotion = false } = {}) {
  const section = document.getElementById(id)
  if (!section) return null
  const flight = span(section)
  const autopilot = Boolean(flight && lenis && !reducedMotion && flight.end - flight.start > 200)

  return {
    autopilot,
    go() {
      if (!flight) return scrollToTarget(section, { immediate: reducedMotion, duration: reducedMotion ? 0 : 2.6 })
      if (!autopilot) return scrollToTarget(flight.start, { immediate: true })
      fly(flight)
    },
  }
}

function fly({ start, end }) {
  let holdTimer = 0
  let cancelled = false
  const offMenu = on('menu:state', (state) => state?.open && cancel())

  function cleanup() {
    clearTimeout(holdTimer)
    offMenu()
    for (const type of INTERRUPTS) window.removeEventListener(type, cancel, true)
  }
  function cancel() {
    if (cancelled) return
    cancelled = true
    cleanup()
    lenis?.reset?.() // stop the programmatic scroll exactly where it is
  }

  // Listen from the next frame so the click that triggered the launch can't cancel it.
  requestAnimationFrame(() => {
    if (cancelled) return
    for (const type of INTERRUPTS) window.addEventListener(type, cancel, { capture: true, passive: true })
  })

  const distance = Math.abs(window.scrollY - start)
  lenis.scrollTo(start, {
    duration: Math.min(3, Math.max(1.4, distance / 6500)),
    easing: expoInOut,
    force: true,
    onComplete: () => {
      if (cancelled) return
      // A beat on the pad before the climb.
      holdTimer = setTimeout(() => {
        if (cancelled) return
        const length = end - start
        lenis.scrollTo(end - 2, {
          duration: Math.min(12, Math.max(7, length / 430)),
          easing: ascentEase,
          force: true,
          onComplete: () => {
            if (!cancelled) cleanup()
          },
        })
      }, 1100)
    },
  })
}
