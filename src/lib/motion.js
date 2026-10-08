/**
 * Motion foundation: GSAP + ScrollTrigger driven by Lenis smooth scrolling.
 * Import `gsap` / `ScrollTrigger` from here (not from 'gsap' directly) so every
 * section shares the same registered instance.
 */
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import Lenis from 'lenis'
import { reducedMotion } from './quality.js'

gsap.registerPlugin(ScrollTrigger)

/** Shared Lenis instance (null under reduced motion — native scrolling then). */
export let lenis = null

let initialised = false

export function initMotion() {
  if (initialised) return
  initialised = true

  if (!reducedMotion) {
    lenis = new Lenis({ lerp: 0.09, smoothWheel: true, wheelMultiplier: 0.9 })
    lenis.on('scroll', ScrollTrigger.update)
    gsap.ticker.add((time) => lenis.raf(time * 1000))
    gsap.ticker.lagSmoothing(0)
  }

  initAnchorLinks()

  // Fonts and late images change layout — recompute trigger positions.
  document.fonts?.ready.then(() => ScrollTrigger.refresh())
  window.addEventListener('load', () => ScrollTrigger.refresh(), { once: true })

  // Handle for tooling (screenshots / debugging).
  window.__sxsi = { gsap, ScrollTrigger, get lenis() { return lenis } }
}

/** Smoothly scrolls to an element, selector or y position. */
export function scrollToTarget(target, { offset = 0, immediate = false, duration } = {}) {
  const el = typeof target === 'string' ? document.querySelector(target) : target
  if (el == null) return
  if (lenis) {
    lenis.scrollTo(el, { offset, immediate, duration, force: true })
  } else if (typeof el === 'number') {
    window.scrollTo({ top: el + offset, behavior: immediate || reducedMotion ? 'auto' : 'smooth' })
  } else {
    const top = el.getBoundingClientRect().top + window.scrollY + offset
    window.scrollTo({ top, behavior: immediate || reducedMotion ? 'auto' : 'smooth' })
  }
}

/** Pause / resume page scrolling (e.g. while a modal or boot overlay is open). */
export function lockScroll(locked) {
  if (lenis) locked ? lenis.stop() : lenis.start()
  document.documentElement.classList.toggle('is-scroll-locked', locked)
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
    scrollToTarget(el)
    history.pushState(null, '', `#${id}`)
    // Move focus for keyboard / screen-reader users without a second jump.
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1')
    el.focus({ preventScroll: true })
  })
}

export { gsap, ScrollTrigger }
