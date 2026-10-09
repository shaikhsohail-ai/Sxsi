/**
 * FLIGHT COMPUTER (#terminal) — an interactive, scripted command console.
 *
 *   terminal.js   wiring: power-on, input (history, Tab, ghost completion,
 *                 block caret), chips, rail telemetry, scroll choreography
 *   commands.js   the command set — every reply is pre-written
 *   printer.js    safe DOM builders + typewriter output queue
 *   banner.js     ASCII SXSI mark → crisp SVG
 *   scope.js      rail oscilloscope (2D canvas)
 *   rain.js       the `matrix` easter egg
 *   liftoff.js    T−0: the ASCII vehicle climbing out of the screen
 *   handoff.js    after liftoff: fly the page to the Ascent pad (+ autopilot)
 *
 * Progressive enhancement: the boot screen and every label are static HTML.
 * With JS the screen starts "off" and powers on (CRT line → banner → boot
 * lines typed) when it scrolls into view. Reduced motion: no power-on, no
 * typewriter, no tilt — the console is simply on.
 */
import { gsap, ScrollTrigger, scrollToTarget } from '../../lib/motion.js'
import { SplitText } from 'gsap/SplitText'
import { emit } from '../../lib/bus.js'
import { reducedMotion, tier, isTouch } from '../../lib/quality.js'
import { observeVisibility } from '../../lib/visibility.js'
import { $, $$, clamp, pad } from '../../lib/dom.js'
import { NEXT_MISSION, COORDINATES } from '../../config.js'
import { renderBanner, cloneBanner } from './banner.js'
import { createPrinter, tone } from './printer.js'
import { createCommands, formatCountdown } from './commands.js'
import { createScope } from './scope.js'
import { rain } from './rain.js'
import { liftoff, renderPad } from './liftoff.js'
import { planHandoff } from './handoff.js'
import { starTile } from './stars.js'

gsap.registerPlugin(SplitText)

const HISTORY_KEY = 'sxsi.tty01.history'
const HISTORY_MAX = 50
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const finePointer = typeof matchMedia === 'function' && matchMedia('(hover: hover) and (pointer: fine)').matches
const CLIP_HIDDEN = 'inset(-6px 100% -6px -6px)'
const CLIP_SHOWN = 'inset(-6px -12px -6px -6px)'

export function init() {
  const root = document.getElementById('terminal')
  if (!root) return

  const q = (name) => $(`[data-terminal-${name}]`, root)
  const el = {
    bay: q('bay'),
    console: q('console'),
    screen: q('screen'),
    glass: q('glass'),
    scroll: q('scroll'),
    log: q('log'),
    form: q('form'),
    input: q('input'),
    overlay: q('overlay'),
    mirror: q('mirror'),
    caret: q('caret'),
    ghost: q('ghost'),
    flash: q('flash'),
    wipe: q('wipe'),
    vehicle: q('vehicle'),
    power: q('power'),
    rail: q('rail'),
    chips: q('chips'),
  }
  if (!el.log || !el.input || !el.form || !el.scroll || !el.screen || !el.overlay) return

  if (reducedMotion) root.classList.add('is-static')
  // Low-tier devices skip the per-glyph phosphor glow and the drifting refresh band.
  if (tier === 'low') root.classList.add('is-lite')
  fillConfig(root)
  // The overlay is white-space: pre — drop any formatting whitespace from the markup.
  for (const node of [...el.overlay.childNodes]) if (node.nodeType === 3) node.remove()

  // Swap the CSS lattice starfield for a seeded, non-repeating painted tile
  // (generated when the browser is idle; the CSS version shows until then).
  const starsEl = q('stars')
  if (starsEl) {
    const paint = () =>
      starTile().then((tile) => {
        if (!tile) return
        starsEl.style.backgroundImage = `url(${tile.url})`
        starsEl.style.backgroundSize = `${tile.width}px ${tile.height}px`
        starsEl.style.opacity = '0.8'
      })
    if ('requestIdleCallback' in window) requestIdleCallback(paint, { timeout: 3000 })
    else setTimeout(paint, 600)
  }

  const banner = renderBanner(q('ascii'))
  renderPad(el.vehicle)
  const padBox = el.vehicle?.parentElement
  const scope = createScope(q('scope'))
  const orbit = $('.r-orbit', root)
  if (reducedMotion) orbit?.pauseAnimations?.()

  /* ---- State --------------------------------------------------------- */
  let history = loadHistory()
  let cursor = history.length
  let draft = ''
  let commandsRun = 0
  let lines = $$('[data-boot-line]', root).length + 1
  let onScreen = false
  let powered = false
  let queue = Promise.resolve()
  let chipTyping = false
  let lastPointer = 'mouse'
  const arrivedAt = performance.now()

  const read = {
    utc: q('utc'),
    session: q('session'),
    count: q('count'),
    last: q('last'),
    ln: q('ln'),
    mode: q('mode'),
    countdown: q('countdown'),
  }
  const setText = (node, text) => {
    if (node && node.textContent !== text) node.textContent = text
  }
  const updateLn = () => setText(read.ln, pad(lines, 3))

  /* ---- Output -------------------------------------------------------- */
  const printer = createPrinter({
    log: el.log,
    scroller: el.scroll,
    instant: reducedMotion,
    onLine: () => {
      lines++
      updateLn()
      scope.kick(0.16)
    },
    onBusy: (busy) => root.classList.toggle('is-tx', busy),
  })

  const fx = {
    arm: (on) => {
      root.classList.toggle('is-armed', on)
      // A new count rolls a fresh vehicle out to the pad.
      if (on) root.classList.remove('is-flown')
    },
    ignite,
    rain: async (ms) => {
      root.classList.add('is-raining')
      await rain(el.screen, ms)
      root.classList.remove('is-raining')
    },
  }

  const commands = createCommands({
    print: (nodes, opts) => printer.print(nodes, opts),
    clear,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    emit,
    history: () => history.slice(),
    visible: () => onScreen,
    fx,
    setMode: (text) => setText(read.mode, text),
    handoff: () => planHandoff('ascent', { reducedMotion }),
    reducedMotion,
    touch: isTouch,
    banner: () => (banner ? cloneBanner(banner.svg) : null),
  })

  function clear() {
    // Phosphor wipe: the old lines move to a decorative layer that a bright
    // refresh line sweeps away, while the real log is emptied at once.
    const old = reducedMotion || !powered ? [] : Array.from(el.log.children)
    const offset = el.scroll.scrollTop
    printer.clear()
    lines = 0
    updateLn()
    root.classList.remove('is-engaged', 'is-flown') // the vehicle returns to the empty screen
    if (old.length) wipe(old, offset)
  }

  let afterglow = null
  function wipe(nodes, offset) {
    afterglow?.remove()
    const layer = (afterglow = document.createElement('div'))
    layer.className = 's-terminal__afterglow'
    layer.setAttribute('aria-hidden', 'true')
    const inner = document.createElement('div')
    inner.className = 's-terminal__log'
    inner.style.transform = `translateY(${-offset}px)`
    inner.append(...nodes)
    layer.append(inner)
    el.glass.append(layer)
    const height = el.glass.clientHeight
    const timing = { duration: 420, easing: 'cubic-bezier(0.65, 0, 0.35, 1)' }
    layer.animate([{ clipPath: 'inset(0 0 0 0)' }, { clipPath: 'inset(100% 0 0 0)' }], timing).finished
      .catch(() => {})
      .finally(() => layer.remove())
    el.wipe?.animate(
      [
        { transform: 'translateY(0)', opacity: 1 },
        { transform: `translateY(${height}px)`, opacity: 0.85 },
      ],
      timing,
    )
    // The fresh prompt surfaces once the sweep has passed the top rows.
    el.form.animate([{ opacity: 0 }, { opacity: 0, offset: 0.35 }, { opacity: 1 }], timing)
    scope.kick(0.5)
  }

  /* ---- Submitting ---------------------------------------------------- */
  function submit(raw) {
    const text = String(raw ?? '').slice(0, 80)
    if (text.trim()) {
      root.classList.add('is-engaged')
      record(text.trim())
      commandsRun++
      setText(read.count, pad(commandsRun, 3))
      setText(read.last, text.trim().toLowerCase().slice(0, 14))
    }
    powerOn(true)
    stopAttract()
    printer.skip()
    scope.kick(0.6)
    // During a countdown commands bypass the queue so `abort` lands at once.
    if (commands.launching) {
      commands.exec(text)
      return
    }
    queue = queue.then(() => commands.exec(text)).catch((error) => console.error('[terminal] command failed', error))
    printer.scrollToEnd()
  }

  el.form.addEventListener('submit', (event) => {
    event.preventDefault()
    const value = el.input.value
    el.input.value = ''
    cursor = history.length // record() moves it past a new entry
    draft = ''
    submit(value)
    syncCaret()
  })

  /* ---- History ------------------------------------------------------- */
  function record(text) {
    if (history[history.length - 1] !== text) history.push(text)
    if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX)
    cursor = history.length
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history))
    } catch {
      /* storage unavailable — history lives for this visit only */
    }
  }

  function recall(direction) {
    if (!history.length) return
    if (cursor === history.length) draft = el.input.value
    cursor = clamp(cursor + direction, 0, history.length)
    el.input.value = cursor === history.length ? draft : history[cursor]
    const end = el.input.value.length
    el.input.setSelectionRange(end, end)
  }

  /* ---- Completion ---------------------------------------------------- */
  function matchesFor(value) {
    const v = value.trimStart().toLowerCase()
    if (!v || /\s/.test(v)) return []
    return commands.names.filter((name) => name.startsWith(v))
  }

  function suggestion() {
    const value = el.input.value
    if (!value || el.input.selectionStart !== value.length) return ''
    const match = matchesFor(value).find((name) => name !== value.toLowerCase())
    return match ? match.slice(value.trimStart().length) : ''
  }

  /** Bash-style Tab: extend to the longest common prefix, list if ambiguous. */
  function complete() {
    const value = el.input.value
    const matches = matchesFor(value)
    if (!matches.length) return false
    const v = value.trimStart().toLowerCase()
    if (matches.length === 1 && matches[0] === v) return false
    let common = matches[0]
    for (const name of matches) while (!name.startsWith(common)) common = common.slice(0, -1)
    if (common.length > v.length) {
      el.input.value = common
    } else {
      printer.print(tone('dim', matches.join('   ')))
    }
    return true
  }

  /* ---- Block caret + ghost suggestion -------------------------------- */
  let typingTimer = 0
  let syncTimer = 0
  function syncCaret() {
    clearTimeout(syncTimer)
    syncTimer = 0
    const { input } = el
    const value = input.value
    const start = input.selectionStart ?? value.length
    const end = input.selectionEnd ?? start
    const overflow = input.scrollWidth > input.clientWidth + 1
    const ghost = overflow ? '' : suggestion()
    el.mirror.textContent = value.slice(0, start)
    // Fish-style: at the end of the line the block sits on the suggestion's first character.
    el.caret.textContent = start === end ? value[start] || ghost[0] || '\u00a0' : '\u00a0'
    el.ghost.textContent = ghost.slice(1)
    root.classList.toggle('has-selection', start !== end)
    el.overlay.style.transform = input.scrollLeft ? `translateX(${-input.scrollLeft}px)` : ''
  }
  // Keydown fires before the input's value / selection change, so defer one tick.
  const requestSync = () => {
    if (!syncTimer) syncTimer = setTimeout(syncCaret, 0)
  }

  el.input.addEventListener('input', () => {
    if (cursor === history.length) draft = el.input.value
    syncCaret()
  })
  el.input.addEventListener('select', syncCaret)
  el.input.addEventListener('click', syncCaret)
  el.input.addEventListener('keyup', syncCaret)
  el.input.addEventListener('focus', () => {
    powerOn(true)
    root.classList.add('is-focused')
    requestSync()
  })
  el.input.addEventListener('blur', () => root.classList.remove('is-focused'))
  document.addEventListener('selectionchange', () => {
    if (document.activeElement === el.input) requestSync()
  })

  el.input.addEventListener('keydown', (event) => {
    const { key } = event
    scope.kick(0.22)
    root.classList.add('is-typing')
    clearTimeout(typingTimer)
    typingTimer = setTimeout(() => root.classList.remove('is-typing'), 650)
    if (printer.busy && key !== 'Shift' && key !== 'Control' && key !== 'Meta' && key !== 'Alt') printer.skip()

    if (event.ctrlKey && !event.metaKey && !event.altKey) {
      const k = key.toLowerCase()
      if (k === 'l') {
        event.preventDefault()
        clear()
        return
      }
      // Ctrl+C interrupts — unless the visitor is copying selected text.
      const selected = el.input.selectionStart !== el.input.selectionEnd || String(window.getSelection?.() || '')
      if (k === 'c' && !selected) {
        event.preventDefault()
        commands.interrupt(el.input.value)
        el.input.value = ''
        requestSync()
        return
      }
    }

    switch (key) {
      case 'ArrowUp':
        event.preventDefault()
        recall(-1)
        break
      case 'ArrowDown':
        event.preventDefault()
        recall(1)
        break
      case 'Tab':
        if (!event.shiftKey && complete()) event.preventDefault()
        break
      case 'ArrowRight':
      case 'End': {
        const rest = suggestion()
        if (rest && el.input.selectionStart === el.input.value.length) {
          event.preventDefault()
          el.input.value += rest
        }
        break
      }
      case 'Escape':
        if (!commands.abort() && el.input.value) {
          el.input.value = ''
          cursor = history.length
        }
        break
      case 'PageUp':
      case 'PageDown':
        event.preventDefault()
        el.scroll.scrollBy({ top: (key === 'PageUp' ? -1 : 1) * el.scroll.clientHeight * 0.8 })
        break
    }
    requestSync()
  })

  /* ---- Clicking the screen focuses the prompt ------------------------ */
  el.screen.addEventListener('pointerdown', (event) => {
    lastPointer = event.pointerType || 'mouse'
  })
  el.screen.addEventListener('click', (event) => {
    if (event.target.closest('a, button, input')) return
    if (String(window.getSelection?.() || '')) return // let people copy output
    // On touch, only the prompt row raises the keyboard.
    if (lastPointer === 'touch' && !event.target.closest('.s-terminal__prompt')) return
    el.input.focus({ preventScroll: true })
  })

  /* ---- Wheel: scroll the log when it can, the page when it can't ------ */
  // Lenis ignores events inside [data-lenis-prevent]; toggle it per wheel event
  // so the console never traps the page scroll.
  el.scroll.addEventListener(
    'wheel',
    (event) => {
      const s = el.scroll
      const can = event.deltaY > 0 ? s.scrollTop + s.clientHeight < s.scrollHeight - 1 : s.scrollTop > 0
      s.toggleAttribute('data-lenis-prevent', can)
    },
    { passive: true },
  )

  /* ---- Attract mode: an idle prompt suggests commands ------------------ */
  // Until the visitor engages, the empty prompt types a few commands in faint
  // text (aria-hidden overlay — purely visual; Tab/Enter ignore it).
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const ATTRACT = ['help', 'launch', 'status', 'fleet', 'ping']
  let attractRun = 0
  async function attractLoop() {
    const run = ++attractRun
    const alive = () => run === attractRun
    root.classList.add('is-attract')
    await delay(1600)
    for (let n = 0; alive(); n++) {
      const word = ATTRACT[n % ATTRACT.length]
      for (let i = 1; i <= word.length && alive(); i++) {
        el.mirror.textContent = word.slice(0, i)
        await delay(80 + Math.random() * 70)
      }
      await delay(1900)
      for (let i = word.length - 1; i >= 0 && alive(); i--) {
        el.mirror.textContent = word.slice(0, i)
        await delay(36)
      }
      await delay(650)
    }
  }
  function stopAttract() {
    if (!root.classList.contains('is-attract')) return
    attractRun++
    root.classList.remove('is-attract')
    syncCaret()
  }
  function maybeAttract() {
    if (reducedMotion || !powered || !onScreen || commandsRun || chipTyping) return
    if (el.input.value || document.activeElement === el.input || root.classList.contains('is-attract')) return
    attractLoop()
  }
  el.input.addEventListener('focus', stopAttract)
  el.input.addEventListener('blur', () => setTimeout(maybeAttract, 400))

  /* ---- Quick-command chips ------------------------------------------- */
  async function typeAndRun(text) {
    if (chipTyping) return
    chipTyping = true
    powerOn(true)
    stopAttract()
    if (reducedMotion || commands.launching) {
      chipTyping = false
      submit(text)
      return
    }
    root.classList.add('is-autotype')
    printer.skip()
    el.input.value = ''
    for (const ch of text) {
      el.input.value += ch
      el.input.setSelectionRange?.(el.input.value.length, el.input.value.length)
      syncCaret()
      scope.kick(0.2)
      await delay(26 + Math.random() * 34)
    }
    await delay(140)
    el.input.value = ''
    syncCaret()
    root.classList.remove('is-autotype')
    chipTyping = false
    submit(text)
  }
  el.chips?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-cmd]')
    if (!button) return
    revealConsole()
    typeAndRun(button.dataset.cmd)
  })

  // The chips sit below the console; on short / phone viewports the console's
  // top (where a countdown board prints) can be scrolled under the nav. Bring
  // it back so the reply is actually seen.
  function revealConsole() {
    const navH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--nav-h')) || 64
    const top = el.console.getBoundingClientRect().top
    if (top < navH + 8) scrollToTarget(el.console, { offset: -(navH + 14), duration: reducedMotion ? 0 : 1.1, immediate: reducedMotion })
  }

  // The "help" key in the intro becomes a shortcut: fly to the console and run it.
  const helpKey = $('.s-terminal__kbd', root)
  if (helpKey) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `${helpKey.className} s-terminal__kbd--button`
    button.textContent = helpKey.textContent
    button.setAttribute('aria-label', 'Run help in the flight computer')
    helpKey.replaceWith(button)
    button.addEventListener('click', () => {
      const box = el.bay.getBoundingClientRect()
      const inView = box.top >= 0 && box.top < innerHeight * 0.5
      if (!inView) scrollToTarget(el.bay, { offset: -Math.round(innerHeight * 0.1) })
      setTimeout(() => typeAndRun('help'), inView || reducedMotion ? 0 : 900)
    })
  }

  /* ---- Rail + clock --------------------------------------------------- */
  function tick() {
    const now = new Date()
    setText(read.utc, `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`)
    const s = Math.floor((performance.now() - arrivedAt) / 1000)
    setText(read.session, `${pad(s / 3600)}:${pad((s % 3600) / 60)}:${pad(s % 60)}`)
    setText(read.countdown, formatCountdown(now.getTime()))
  }
  tick()
  let clock = 0
  observeVisibility(root, (visible) => {
    onScreen = visible
    root.classList.toggle('is-visible', visible)
    if (visible && !clock) clock = setInterval(tick, 1000)
    if (!visible && clock) {
      clearInterval(clock)
      clock = 0
    }
    if (orbit && !reducedMotion) {
      if (visible) orbit.unpauseAnimations?.()
      else orbit.pauseAnimations?.()
    }
    if (visible) maybeAttract()
    else stopAttract()
  })

  /* ---- Glare follows the pointer -------------------------------------- */
  if (finePointer && !reducedMotion) {
    let frame = 0
    let px = 0
    let py = 0
    el.screen.addEventListener('pointermove', (event) => {
      px = event.clientX
      py = event.clientY
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const box = el.screen.getBoundingClientRect()
        el.screen.style.setProperty('--glare-x', `${(px - box.left).toFixed(1)}px`)
        el.screen.style.setProperty('--glare-y', `${(py - box.top).toFixed(1)}px`)
      })
    })
    el.screen.addEventListener('pointerenter', () => root.classList.add('is-hover'))
    el.screen.addEventListener('pointerleave', () => root.classList.remove('is-hover'))
  }

  /* ---- Ignition (launch T−0) ------------------------------------------ */
  /** Flash, rumble and the ASCII liftoff. Resolves when the vehicle has cleared the screen. */
  function ignite() {
    if (reducedMotion) {
      root.classList.add('is-flown')
      return Promise.resolve()
    }
    root.classList.add('is-ignite', 'is-liftoff')
    setTimeout(() => root.classList.remove('is-ignite'), 1600)
    // autoAlpha: the layer is visibility:hidden (out of the paint) except during the flash.
    gsap.timeline()
      .fromTo(el.flash, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.18, ease: 'power2.out' })
      .to(el.flash, { autoAlpha: 0, duration: 1.8, ease: 'expo.out' })
    // Engine rumble: decaying random offsets.
    const shake = gsap.timeline()
    for (let i = 0; i < 16; i++) {
      const k = 1 - i / 16
      shake.to(el.console, { x: (Math.random() - 0.5) * 5 * k, y: (Math.random() - 0.5) * 4 * k, duration: 0.05, ease: 'none' })
    }
    shake.to(el.console, { x: 0, y: 0, duration: 0.2, ease: 'power2.out' })
    return liftoff(el.screen, { anchor: el.vehicle }).finally(() => {
      root.classList.add('is-flown') // the pad stays empty until the next count or clear
      root.classList.remove('is-liftoff')
    })
  }

  /* ---- Power-on ------------------------------------------------------- */
  const bootLines = $$('[data-boot-line]', root)
  const bannerCaption = $('.t-banner__caption', root)
  const leds = $$('[data-terminal-led]', root)
  const railParts = el.rail ? Array.from(el.rail.children) : []

  let powerTl = null
  function powerOn(immediate = false) {
    // Interacting mid-boot lands the rest of the sequence at once.
    if (powered) {
      if (immediate && powerTl?.isActive()) powerTl.progress(1)
      return
    }
    powered = true
    root.classList.remove('is-off')
    root.classList.add('is-on')
    setText(read.mode, 'Interactive') // the static markup says Standby (no JS = no input)
    if (reducedMotion) return

    const svg = banner?.svg
    const targets = [el.glass, el.power, svg, bannerCaption, el.form, padBox, ...bootLines, ...leds, ...railParts].filter(Boolean)
    if (immediate) {
      gsap.killTweensOf(targets)
      gsap.set(targets, { clearProps: 'clipPath,opacity,filter,transform' })
      leds.forEach((led) => led.classList.add('is-lit'))
      return
    }

    emit('sound:cue', { type: 'blip' })
    const tl = (powerTl = gsap.timeline({ defaults: { ease: 'expo.out' } }))
    tl.fromTo(el.power, { scaleX: 0, opacity: 1 }, { scaleX: 1, duration: 0.45 }, 0)
      .to(el.power, { opacity: 0, scaleY: 6, duration: 0.5, ease: 'power2.out' }, 0.38)
      .fromTo(
        el.glass,
        { clipPath: 'inset(49.6% 0% 49.6% 0%)', filter: 'brightness(2.6)' },
        { clipPath: 'inset(0% 0% 0% 0%)', filter: 'brightness(1)', duration: 0.9, ease: 'expo.inOut', clearProps: 'clipPath,filter' },
        0.3,
      )
    leds.forEach((led, i) => tl.add(() => led.classList.add('is-lit'), 0.2 + i * 0.16))
    if (svg) {
      tl.fromTo(
        svg,
        { clipPath: 'inset(0 100% 0 0)' },
        { clipPath: 'inset(0 0% 0 0)', duration: 0.95, ease: `steps(${banner.cols})`, clearProps: 'clipPath' },
        0.75,
      )
    }
    if (bannerCaption) tl.fromTo(bannerCaption, { opacity: 0 }, { opacity: 1, duration: 0.8, ease: 'power2.out' }, 1.5)
    let at = 1.1
    for (const node of bootLines) {
      const len = node.textContent.trim().length
      const duration = Math.min(0.6, Math.max(0.12, len * 0.012))
      tl.fromTo(node, { clipPath: CLIP_HIDDEN }, { clipPath: CLIP_SHOWN, duration, ease: `steps(${clamp(len, 1, 72)})`, clearProps: 'clipPath' }, at)
      tl.add(() => scope.kick(0.25), at)
      at += duration * 0.6 + 0.06
    }
    tl.fromTo(el.form, { opacity: 0 }, { opacity: 1, duration: 0.6, ease: 'power2.out', clearProps: 'opacity' }, at)
    if (padBox) tl.fromTo(padBox, { opacity: 0 }, { opacity: 1, duration: 1.2, ease: 'power2.out', clearProps: 'opacity' }, at + 0.2)
    if (railParts.length) {
      tl.fromTo(railParts, { opacity: 0, x: 8 }, { opacity: 1, x: 0, duration: 0.9, stagger: 0.12, clearProps: 'opacity,transform' }, 0.55)
    }
    tl.call(maybeAttract)
  }

  if (!reducedMotion) {
    // Screen starts dark; content held back until power-on.
    root.classList.add('is-off')
    gsap.set(el.glass, { clipPath: 'inset(49.6% 0% 49.6% 0%)' })
    gsap.set(bootLines, { clipPath: CLIP_HIDDEN })
    if (banner?.svg) gsap.set(banner.svg, { clipPath: 'inset(0 100% 0 0)' })
    gsap.set([bannerCaption, el.form, padBox, ...railParts].filter(Boolean), { opacity: 0 })
    gsap.set(el.power, { scaleX: 0, opacity: 0 })
    let stopWatching = null
    stopWatching = observeVisibility(
      el.screen,
      (visible, entry) => {
        if (powered || !visible || (entry && entry.intersectionRatio < 0.3)) return
        powerOn()
        // Deferred: the observer may call back synchronously on first observe.
        queueMicrotask(() => stopWatching?.())
      },
      { threshold: [0, 0.3, 0.6] },
    )
  } else {
    powered = true
    root.classList.add('is-on')
    setText(read.mode, 'Interactive')
    leds.forEach((led) => led.classList.add('is-lit'))
  }

  /* ---- Scroll choreography -------------------------------------------- */
  if (!reducedMotion) {
    revealHead(root)
    gsap.fromTo(
      el.console,
      { rotationX: 14, yPercent: 7, scale: 0.94, transformPerspective: 1800, transformOrigin: '50% 100%' },
      {
        rotationX: 0,
        yPercent: 0,
        scale: 1,
        ease: 'none',
        scrollTrigger: { trigger: el.bay, start: 'top bottom', end: 'top 38%', scrub: 0.7 },
      },
    )
    const spill = $('.s-terminal__spill', root)
    if (spill) {
      gsap.fromTo(
        spill,
        { opacity: 0, scaleX: 0.6 },
        { opacity: 1, scaleX: 1, ease: 'none', scrollTrigger: { trigger: el.bay, start: 'top 85%', end: 'top 30%', scrub: 0.7 } },
      )
    }
    if (starsEl) {
      gsap.fromTo(starsEl, { yPercent: -4 }, { yPercent: 4, ease: 'none', scrollTrigger: { trigger: root, start: 'top bottom', end: 'bottom top', scrub: true } })
    }
    const chips = $$('.s-terminal__chips-label, .s-terminal__chip, .s-terminal__foot', root)
    gsap.set(chips, { opacity: 0, y: 14 })
    ScrollTrigger.create({
      trigger: el.chips,
      start: 'top 94%',
      once: true,
      onEnter: () => gsap.to(chips, { opacity: 1, y: 0, duration: 1, ease: 'expo.out', stagger: 0.035, clearProps: 'transform' }),
    })
  }

  updateLn()
  syncCaret()
}

/* -------------------------------------------------------------------------- */

function revealHead(root) {
  const head = $('.s-terminal__head', root)
  const title = $('.s-terminal__title', root)
  const items = $$('[data-terminal-reveal]', root)
  const rule = $('.s-terminal__head-grid', root)
  if (!head || !title) return
  const split = SplitText.create(title, { type: 'words,chars', mask: 'chars', charsClass: 's-terminal__char', wordsClass: 's-terminal__word' })
  gsap.set(split.chars, { yPercent: 115 })
  gsap.set(items, { opacity: 0, y: 20 })
  rule?.style.setProperty('--terminal-rule', '0')
  ScrollTrigger.create({
    trigger: head,
    start: 'top 82%',
    once: true,
    onEnter: () => {
      const tl = gsap.timeline()
      tl.to(split.chars, { yPercent: 0, duration: 1.4, ease: 'expo.out', stagger: 0.03 }, 0)
      tl.to(items, { opacity: 1, y: 0, duration: 1.2, ease: 'expo.out', stagger: 0.08, clearProps: 'transform' }, 0.15)
      if (rule) tl.to(rule, { '--terminal-rule': 1, duration: 1.6, ease: 'expo.inOut' }, 0.1)
    },
  })
}

function fillConfig(root) {
  const set = (name, text) => {
    const node = $(`[data-terminal-${name}]`, root)
    if (node && text) node.textContent = text
  }
  if (NEXT_MISSION) {
    set('mnum', NEXT_MISSION.number)
    set('mname', NEXT_MISSION.name ? NEXT_MISSION.name[0] + NEXT_MISSION.name.slice(1).toLowerCase() : '')
    set('pad', NEXT_MISSION.pad)
    const at = new Date(NEXT_MISSION.launchAt)
    if (!Number.isNaN(at.getTime())) set('mdate', `${pad(at.getUTCDate())} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}`)
  }
  if (COORDINATES?.label) set('coords', COORDINATES.label.replace(/\s+/g, ' '))
}

function loadHistory() {
  try {
    const list = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]')
    return Array.isArray(list) ? list.filter((item) => typeof item === 'string').slice(-HISTORY_MAX) : []
  } catch {
    return []
  }
}
