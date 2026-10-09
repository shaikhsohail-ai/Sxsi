/**
 * Site navigation — fixed header (transparent over the hero, blurred black
 * once scrolled; hides on scroll down, returns on scroll up), scramble-on-
 * hover links, a live UTC mission clock, the sound toggle, a top-edge scroll
 * progress "trajectory" and the full-screen menu with its system map.
 */
import { gsap, ScrollTrigger, lockScroll } from '../../lib/motion.js'
import { booted, emit } from '../../lib/bus.js'
import { reducedMotion } from '../../lib/quality.js'
import { $, $$, pad } from '../../lib/dom.js'
import { COORDINATES, CONTACT_EMAIL } from '../../config.js'
import { bindClock } from './clock.js'
import { createSound } from './sound.js'
import { initScramble } from './scramble.js'

const SECTION_IDS = ['mission', 'ascent', 'fleet', 'control', 'manifest', 'terminal', 'join']

export function init() {
  const header = $('[data-nav]')
  if (!header) return
  const menu = $('[data-nav-menu]')
  const state = { menuOpen: false, focusInside: false, hidden: false }

  bindClock([$('[data-nav-clock]', header), menu && $('[data-nav-menu-clock]', menu)])
  hydrateConfig(menu)
  initScroll(header, state)
  initScramble($$('[data-scramble]', header))
  initSound(header)
  const setCurrent = menu ? initMenu(header, menu, state) : () => {}
  initActiveSection(header, setCurrent)
  introAfterBoot(header)
}

/* --------------------------------------------------------------------------
 * Config-driven copy (static HTML carries the same defaults)
 * ------------------------------------------------------------------------ */
function hydrateConfig(menu) {
  if (!menu) return
  const coords = $('[data-nav-menu-coords]', menu)
  if (coords && COORDINATES?.label) coords.textContent = COORDINATES.label.replace(/\s{2,}/g, ' ')
  const mail = $('[data-nav-menu-mail]', menu)
  if (mail && CONTACT_EMAIL) {
    mail.href = `mailto:${CONTACT_EMAIL}`
    mail.textContent = CONTACT_EMAIL
  }
}

/* --------------------------------------------------------------------------
 * Scroll: backdrop, hide/reveal, progress hairline
 * ------------------------------------------------------------------------ */
function initScroll(header, state) {
  const bar = $('[data-nav-progress]')
  const setBar = bar ? gsap.quickSetter(bar, 'xPercent') : () => {}
  let lastY = 0
  let travel = 0 // distance travelled in the current direction
  let scrolled = null

  // Keyboard focus inside the header keeps it on screen (a mouse click on
  // e.g. the sound toggle shouldn't pin it).
  header.addEventListener('focusin', (event) => {
    if (!event.target.matches?.(':focus-visible')) return
    state.focusInside = true
    setHidden(false)
  })
  header.addEventListener('focusout', (event) => {
    if (!header.contains(event.relatedTarget)) state.focusInside = false
  })

  function setHidden(hidden) {
    if (hidden === state.hidden) return
    state.hidden = hidden
    header.classList.toggle('is-hidden', hidden)
  }

  // Transparent for the hero's whole cinematic runway; the blurred backdrop
  // arrives once the hero has gone (or after a few px on pages without one).
  const hero = document.getElementById('hero')
  const setScrolled = (value) => {
    if (value === scrolled) return
    scrolled = value
    header.classList.toggle('is-scrolled', value)
  }
  if (hero) {
    ScrollTrigger.create({
      trigger: hero,
      start: 'bottom top+=96',
      onEnter: () => setScrolled(true),
      onLeaveBack: () => setScrolled(false),
      onRefresh: (self) => setScrolled(self.scroll() > self.start),
    })
  }

  function apply(self) {
    const y = self.scroll()
    const dy = y - lastY
    lastY = y
    setBar((self.progress - 1) * 100)
    if (!hero) setScrolled(y > 8)

    if (dy !== 0 && Math.sign(dy) !== Math.sign(travel)) travel = 0
    travel += dy
    let hide = state.hidden
    if (y < 140) hide = false
    else if (travel > 28) hide = true
    else if (travel < -18) hide = false
    if (state.menuOpen || state.focusInside) hide = false
    setHidden(hide)
  }

  const st = ScrollTrigger.create({ start: 0, end: 'max', onUpdate: apply })
  // After a refresh (resize, late layout) just resync — a jump is not "scrolling down".
  ScrollTrigger.addEventListener('refresh', () => {
    lastY = st.scroll()
    travel = 0
    setBar((st.progress - 1) * 100)
  })
  setBar(-100)
  state.reveal = () => setHidden(false)
}

/* --------------------------------------------------------------------------
 * Sound toggle
 * ------------------------------------------------------------------------ */
function initSound(header) {
  const button = $('[data-nav-sound]', header)
  if (!button) return
  const label = $('[data-nav-sound-state]', button)
  const sound = createSound()

  if (!sound.state.supported) {
    button.hidden = true
    return
  }

  sound.subscribe(({ wanted, running }) => {
    button.setAttribute('aria-pressed', String(wanted))
    if (label) label.textContent = wanted ? 'On' : 'Off'
    button.classList.toggle('is-on', running)
    button.classList.toggle('is-armed', wanted && !running)
  })

  button.addEventListener('click', () => sound.toggle())
  if (sound.state.wanted) sound.armForGesture(button)
}

/* --------------------------------------------------------------------------
 * Active section → inline links + menu "current position"
 * ------------------------------------------------------------------------ */
function initActiveSection(header, setCurrent) {
  const sections = SECTION_IDS.map((id) => document.getElementById(id)).filter(Boolean)
  if (!sections.length || typeof IntersectionObserver === 'undefined') return
  const links = $$('[data-nav-link]', header)
  const inView = new Set()
  let current = null

  const update = () => {
    const active = sections.filter((s) => inView.has(s)).pop()?.id ?? null
    if (active === current) return
    current = active
    for (const link of links) link.classList.toggle('is-active', link.getAttribute('href') === `#${active}`)
    setCurrent(active ? SECTION_IDS.indexOf(active) : -1)
  }

  // A thin band across the middle of the viewport decides "where we are".
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) entry.isIntersecting ? inView.add(entry.target) : inView.delete(entry.target)
      update()
    },
    { rootMargin: '-48% 0px -51% 0px' },
  )
  sections.forEach((s) => io.observe(s))
}

/* --------------------------------------------------------------------------
 * Intro: chrome settles in as the boot overlay parts
 * ------------------------------------------------------------------------ */
function introAfterBoot(header) {
  const items = $$('[data-nav-intro]', header)
  const progress = $('.s-nav-progress')
  // CSS keeps these hidden until <html data-booted>; `booted` resolves in a
  // microtask right after, so the from-state lands before the next paint.
  booted.then(() => {
    if (reducedMotion) return
    gsap.fromTo(
      items,
      { autoAlpha: 0, y: -12 },
      { autoAlpha: 1, y: 0, duration: 1.3, ease: 'expo.out', stagger: 0.07, delay: 0.75, clearProps: 'all' },
    )
    if (progress) gsap.fromTo(progress, { autoAlpha: 0 }, { autoAlpha: 1, duration: 1, delay: 1.4, clearProps: 'all' })
  })
}

/* --------------------------------------------------------------------------
 * Full-screen menu
 * ------------------------------------------------------------------------ */
function initMenu(header, menu, state) {
  const toggle = $('[data-nav-toggle]', header)
  const toggleLabel = $('[data-nav-toggle-label]', header)
  const primary = $('[data-nav-primary]', header)
  const links = $$('[data-menu-link]', menu)
  const words = $$('.s-nav-menu__word-in', menu)
  const nums = $$('.s-nav-menu__num', menu)
  const readout = $('.s-nav-menu__readout', menu)
  const destKey = $('.s-nav-menu__readout-key', menu)
  const destNum = $('[data-menu-dest-num]', menu)
  const destName = $('[data-menu-dest-name]', menu)
  const telemetry = $$('.s-nav-menu__tm', menu)
  const rule = $('.s-nav-menu__rule', menu)
  const edge = $('[data-nav-menu-edge]', menu)
  const canvas = $('[data-nav-menu-sky]', menu)
  if (!toggle || !links.length) return () => {}

  const names = links.map((link) => $('.s-nav-menu__word-in', link)?.textContent.trim() ?? '')
  const descriptions = links.map((link) => $('.s-nav-menu__desc', link)?.textContent.trim() ?? '')
  let sky = null
  let skyPromise = null
  let current = -1
  let hovered = -1
  let inerted = []
  let returnFocus = true

  // ---- Destination readout ---------------------------------------------------
  function showDestination(index) {
    hovered = index
    const i = index >= 0 ? index : current
    const isDest = index >= 0
    if (destKey) destKey.textContent = isDest ? 'Destination' : i >= 0 ? 'Current position' : 'Standing by'
    if (destNum) destNum.textContent = i >= 0 ? pad(i + 1) : '00'
    if (destName) destName.textContent = i >= 0 ? `${names[i]} — ${descriptions[i]}` : 'Select a destination'
    readout?.classList.toggle('is-target', isDest)
    links.forEach((link, j) => link.classList.toggle('is-target', j === index))
    menu.classList.toggle('has-target', isDest)
    sky?.highlight(i)
  }

  links.forEach((link, index) => {
    link.addEventListener('pointerenter', (event) => {
      if (event.pointerType !== 'mouse') return
      showDestination(index)
      emit('sound:cue', { type: 'blip' })
    })
    link.addEventListener('pointerleave', () => hovered === index && showDestination(-1))
    link.addEventListener('focus', () => link.matches(':focus-visible') && showDestination(index))
    link.addEventListener('blur', () => hovered === index && showDestination(-1))
    // Close first (restores scrolling + un-inerts the page) so the global
    // anchor handler can then scroll to and focus the section.
    link.addEventListener('click', () => {
      returnFocus = false
      close()
    })
  })

  // On screen (open, or wiping closed): native scrolling stays still behind it.
  const setMenuShown = (shown) => {
    menu.hidden = !shown
    document.documentElement.classList.toggle('has-nav-menu', shown)
  }

  // ---- Timeline --------------------------------------------------------------
  const tl = gsap.timeline({
    paused: true,
    defaults: { ease: 'expo.out' },
    onReverseComplete: () => {
      setMenuShown(false)
      header.classList.remove('is-menu-layer')
      gsap.set(menu, { clearProps: 'clipPath' })
    },
  })
  tl.fromTo(menu, { clipPath: 'inset(0% 0% 100% 0%)' }, { clipPath: 'inset(0% 0% 0% 0%)', duration: 0.9, ease: 'expo.inOut' }, 0)
    .fromTo(edge, { y: 0, autoAlpha: 1 }, { y: () => window.innerHeight, duration: 0.9, ease: 'expo.inOut' }, 0)
    .to(edge, { autoAlpha: 0, duration: 0.3, ease: 'power1.out' }, 0.7)
    .fromTo(canvas, { autoAlpha: 0, scale: 1.08 }, { autoAlpha: 1, scale: 1, duration: 1.8 }, 0.25)
    .fromTo(words, { yPercent: 112 }, { yPercent: 0, duration: 1.15, stagger: 0.055 }, 0.32)
    .fromTo(nums, { autoAlpha: 0, x: -8 }, { autoAlpha: 1, x: 0, duration: 0.9, stagger: 0.055 }, 0.5)
    .fromTo(rule, { scaleX: 0 }, { scaleX: 1, duration: 1.3, ease: 'expo.inOut' }, 0.45)
    .fromTo([readout, ...telemetry].filter(Boolean), { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: 1, stagger: 0.06 }, 0.7)

  // ---- Open / close ----------------------------------------------------------
  function setBackgroundInert(value) {
    if (value) {
      inerted = [...document.body.children].filter(
        (el) => el !== header && el !== menu && !el.matches('script, .s-nav-progress') && !el.inert,
      )
      if (primary) inerted.push(primary)
      inerted.forEach((el) => (el.inert = true))
    } else {
      inerted.forEach((el) => (el.inert = false))
      inerted = []
    }
  }

  function loadSky() {
    if (sky || skyPromise || !canvas) return skyPromise
    skyPromise = import('./menu-sky.js')
      .then(({ createMenuSky }) => {
        sky = createMenuSky(canvas, { root: menu, labels: names, still: reducedMotion })
        sky?.refresh()
        sky?.highlight(hovered >= 0 ? hovered : current)
      })
      .catch((error) => console.error('[sxsi] menu backdrop unavailable', error))
    return skyPromise
  }

  function open() {
    if (state.menuOpen) return
    state.menuOpen = true
    returnFocus = true
    state.reveal?.()
    setMenuShown(true)
    header.classList.add('is-menu-open', 'is-menu-layer')
    toggle.setAttribute('aria-expanded', 'true')
    if (toggleLabel) toggleLabel.textContent = 'Close'
    setBackgroundInert(true)
    lockScroll(true)
    loadSky()
    sky?.refresh()
    showDestination(-1)
    emit('menu:state', { open: true })
    emit('sound:cue', { type: 'whoosh' })
    if (reducedMotion) tl.progress(1)
    else {
      if (tl.progress() === 0) tl.invalidate() // re-measure viewport-dependent values
      tl.timeScale(1).play()
    }
  }

  function close() {
    if (!state.menuOpen) return
    state.menuOpen = false
    header.classList.remove('is-menu-open')
    toggle.setAttribute('aria-expanded', 'false')
    if (toggleLabel) toggleLabel.textContent = 'Menu'
    setBackgroundInert(false)
    lockScroll(false)
    emit('menu:state', { open: false })
    if (returnFocus) toggle.focus({ preventScroll: true })
    if (reducedMotion) {
      tl.progress(0)
      setMenuShown(false)
      header.classList.remove('is-menu-layer')
    } else tl.timeScale(2.1).reverse()
  }

  toggle.addEventListener('click', () => (state.menuOpen ? close() : open()))

  // The logo (→ #hero) also works as a destination while the menu is open.
  for (const link of $$('a[href^="#"]', header)) {
    link.addEventListener('click', () => {
      if (!state.menuOpen) return
      returnFocus = false
      close()
    })
  }

  // Warm the backdrop module when the visitor reaches for the menu.
  toggle.addEventListener('pointerenter', loadSky, { once: true })

  // ---- Keyboard: Esc closes, Tab is trapped inside header + menu ------------
  document.addEventListener('keydown', (event) => {
    if (!state.menuOpen) return
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (event.key !== 'Tab') return
    const focusables = [
      ...$$('a[href], button:not([disabled])', header),
      ...$$('a[href], button:not([disabled])', menu),
    ].filter((el) => !el.closest('[inert]') && !el.hidden && el.getClientRects().length > 0)
    if (!focusables.length) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    const active = document.activeElement
    const inside = focusables.includes(active)
    if (event.shiftKey && (active === first || !inside)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (active === last || !inside)) {
      event.preventDefault()
      first.focus()
    }
  })

  return (index) => {
    current = index
    links.forEach((link, j) => link.classList.toggle('is-current', j === index))
    if (hovered < 0) showDestination(-1)
  }
}
