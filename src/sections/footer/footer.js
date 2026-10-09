/**
 * Footer — config-driven contact/social links, live telemetry, the year,
 * "Return to orbit", and the monumental wordmark: as the page comes to rest
 * the letters rise from behind a lit horizon, atmospheric glow swells behind
 * them and a glint crosses their faces. On desktop the low sun on that
 * horizon follows the pointer and lights the letters from below.
 */
import { gsap, ScrollTrigger, scrollToTarget } from '../../lib/motion.js'
import { emit } from '../../lib/bus.js'
import { reducedMotion } from '../../lib/quality.js'
import { $, $$, clamp } from '../../lib/dom.js'
import { CONTACT_EMAIL, COORDINATES, SOCIAL } from '../../config.js'
import { bindClock } from '../nav/clock.js'

const SOCIAL_LABELS = { x: 'X', linkedin: 'LinkedIn', github: 'GitHub', youtube: 'YouTube', instagram: 'Instagram' }

export function init() {
  const root = $('[data-footer]')
  if (!root) return

  hydrate(root)
  bindClock([$('[data-footer-utc]', root)])
  initReturn(root)
  initMark(root)
}

/* --------------------------------------------------------------------------
 * Copy from config (the static HTML carries the same defaults)
 * ------------------------------------------------------------------------ */
function hydrate(root) {
  const year = $('[data-footer-year]', root)
  if (year) year.textContent = String(new Date().getFullYear())

  const coords = $('[data-footer-coords]', root)
  if (coords && COORDINATES?.label) coords.textContent = COORDINATES.label.replace(/\s{2,}/g, ' ')

  const mail = $('[data-footer-mail]', root)
  if (mail && CONTACT_EMAIL) {
    mail.href = `mailto:${CONTACT_EMAIL}`
    mail.textContent = CONTACT_EMAIL
  }

  // Social profiles: only the ones configured.
  const list = $('[data-footer-contact]', root)
  if (!list || !SOCIAL) return
  for (const [key, url] of Object.entries(SOCIAL)) {
    if (!url || !/^https?:\/\//i.test(url)) continue
    const li = document.createElement('li')
    const a = document.createElement('a')
    a.className = 's-footer__link'
    a.href = url
    a.rel = 'me noopener'
    a.target = '_blank'
    a.textContent = SOCIAL_LABELS[key] || key
    a.setAttribute('aria-label', `${a.textContent} (opens in a new tab)`)
    li.append(a)
    list.append(li)
  }
}

/* --------------------------------------------------------------------------
 * Return to orbit: a long, eased flight back to the hero
 * ------------------------------------------------------------------------ */
function initReturn(root) {
  const link = $('[data-footer-return]', root)
  const hero = document.getElementById('hero')
  if (!link || !hero) return
  link.addEventListener('click', (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey) return
    event.preventDefault()
    emit('sound:cue', { type: 'whoosh' })
    scrollToTarget(hero, { duration: reducedMotion ? 0 : 2.4, immediate: reducedMotion })
    if (!hero.hasAttribute('tabindex')) hero.setAttribute('tabindex', '-1')
    hero.focus({ preventScroll: true })
  })
}

/* --------------------------------------------------------------------------
 * The wordmark: light layers, scrubbed reveal, pointer-tracked sun
 * ------------------------------------------------------------------------ */
const VIEW_W = 211.2 // wordmark viewBox width

/** Clones each letter's fill path into a "light" layer (lit from the horizon
 *  sun) and a "glint" layer (the sweep on arrival). Decorative, JS only. */
function buildLayers(root) {
  const letters = $$('[data-footer-letter]', root)
  const lights = []
  for (const letter of letters) {
    const base = letter.querySelector('path')
    if (!base) continue
    const light = base.cloneNode()
    light.setAttribute('fill', 'url(#s-footer-light)')
    const glint = base.cloneNode()
    glint.setAttribute('fill', 'url(#s-footer-glint)')
    letter.append(light, glint)
    lights.push(light)
  }
  return { letters, lights }
}

function initMark(root) {
  const mark = $('[data-footer-mark]', root)
  const svg = mark && $('svg', mark)
  if (!mark || !svg) return
  const { letters, lights } = buildLayers(root)
  if (reducedMotion) return // the static, fully lit composition is the finished state

  const glow = $('[data-footer-glow]', mark)
  const horizon = $('[data-footer-horizon]', mark)
  const sun = $('[data-footer-sun]', mark)
  const glint = $('[data-footer-glint]', root)
  const light = $('[data-footer-light]', root)

  // ---- Sun position: shared by CSS (glow / horizon) and the SVG light ------
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)').matches
  const sunPos = { x: 0.5 }
  let markLeft = 0
  let markWidth = 1
  let svgLeft = 0
  let svgWidth = 1
  const measure = () => {
    const m = mark.getBoundingClientRect()
    const s = svg.getBoundingClientRect()
    markLeft = m.left
    markWidth = m.width || 1
    svgLeft = s.left - m.left
    svgWidth = s.width || 1
  }
  measure()
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(measure).observe(mark)
  const applySun = () => {
    mark.style.setProperty('--s-footer-sx', sunPos.x.toFixed(4))
    light?.setAttribute('cx', (((sunPos.x * markWidth - svgLeft) / svgWidth) * VIEW_W).toFixed(2))
  }

  // ---- Reveal, scrubbed over the last stretch of the page --------------------
  // The horizon draws out, the sun ignites, the letters rise from behind it
  // one after another, then a glint crosses their faces.
  const tl = gsap.timeline({
    defaults: { ease: 'none' },
    scrollTrigger: {
      trigger: mark,
      start: 'top bottom',
      // Finish exactly as the page comes to rest. (No invalidateOnRefresh:
      // nothing here depends on layout, and invalidating would drop the
      // from-state of letters whose stagger hasn't started yet.)
      end: () => ScrollTrigger.maxScroll(window),
      scrub: 0.6,
    },
  })
  tl.fromTo(horizon, { scaleX: 0 }, { scaleX: 1, duration: 0.5, ease: 'power2.out' }, 0)
    .fromTo(sun, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.3, ease: 'power1.out' }, 0.12)
    .fromTo(glow, { autoAlpha: 0, scaleY: 0.45 }, { autoAlpha: 1, scaleY: 1, duration: 0.7, ease: 'power2.out' }, 0.1)
    .fromTo(letters, { y: 46 }, { y: 0, duration: 0.6, ease: 'power3.out', stagger: 0.08 }, 0.05)
    .fromTo(lights, { opacity: 0 }, { opacity: 1, duration: 0.5, ease: 'power1.inOut' }, 0.3)
    .fromTo(glint, { attr: { x1: -90, x2: -30 } }, { attr: { x1: 240, x2: 300 }, duration: 0.45, ease: 'power1.inOut' }, 0.55)

  if (!finePointer) {
    // Touch: the sun drifts up the horizon toward centre as the page settles.
    tl.fromTo(sunPos, { x: 0.3 }, { x: 0.5, duration: 0.9, ease: 'power2.out', onUpdate: applySun }, 0)
    return
  }

  // ---- Pointer: the sun follows the cursor along the horizon -----------------
  const follow = gsap.quickTo(sunPos, 'x', { duration: 1.6, ease: 'power3.out', onUpdate: applySun })
  root.addEventListener('pointermove', (event) => {
    if (event.pointerType !== 'mouse') return
    follow(clamp((event.clientX - markLeft) / markWidth, 0.04, 0.96))
  })
  root.addEventListener('pointerleave', () => follow(0.5))
}
