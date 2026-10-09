/**
 * MISSION CONTROL — SXSI's capabilities as a mission-control console.
 *
 * Six bento tiles, each a "system" with a live 2D-canvas micro-visualisation
 * (see ./viz). This module wires them to the page:
 *   - mounts every viz (DPR-aware canvas, render loop only while on screen);
 *   - hover / focus raise a tile's energy; a crosshair follows fine pointers;
 *   - each tile's run button (whose hit area spans the tile) re-runs its sim;
 *   - HOLD pauses every animation on the console (WCAG 2.2.2);
 *   - scroll reveal: the head rises in, then tiles power on one by one and
 *     the header's systems-online meter counts them up.
 * Reduced motion: no reveals, no marquee, each viz renders one resolved still.
 */
import { gsap, ScrollTrigger } from '../../lib/motion.js'
import { SplitText } from 'gsap/SplitText'
import { emit } from '../../lib/bus.js'
import { reducedMotion } from '../../lib/quality.js'
import { observeVisibility } from '../../lib/visibility.js'
import { $, $$, pad } from '../../lib/dom.js'
import { COORDINATES } from '../../config.js'
import { mountViz, readPalette } from './viz/core.js'
import { createReasoning } from './viz/reasoning.js'
import { createMemory } from './viz/memory.js'
import { createPerception } from './viz/perception.js'
import { createSafety } from './viz/safety.js'
import { createAgency } from './viz/agency.js'
import { createScale } from './viz/scale.js'
import { initTelemetry, formatNodes } from './telemetry.js'

gsap.registerPlugin(SplitText)

const FACTORIES = {
  reasoning: createReasoning,
  memory: createMemory,
  perception: createPerception,
  safety: createSafety,
  agency: createAgency,
  scale: createScale,
}
const SEEDS = { reasoning: 11, memory: 23, perception: 37, safety: 41, agency: 53, scale: 67 }
const GLYPHS = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789/#+-'
const WIDE = '(min-width: 1200px)' // the 12-column bento (see control.css)
const finePointer = typeof matchMedia === 'function' && matchMedia('(hover: hover) and (pointer: fine)').matches

export function init() {
  const root = document.getElementById('control')
  if (!root) return
  root.classList.add('is-armed')
  if (reducedMotion) root.classList.add('is-static')

  const coords = $('[data-control-coords]', root)
  if (coords && COORDINATES?.label) coords.textContent = COORDINATES.label.replace(/\s+/g, ' ')

  const pal = readPalette()
  const systems = $$('[data-control-tile]', root)
    .map((tile) => setupTile(tile, pal))
    .filter(Boolean)
  const scale = systems.find((sys) => sys.name === 'scale')

  const telemetry = initTelemetry(root, { getNodes: () => scale?.viz.count ?? 0 })
  initCounter(root, scale)
  initHold(root, systems, telemetry)
  const meter = createMeter(root)

  if (reducedMotion) return
  revealHead(root, meter)
  revealTiles(root, systems, meter)
}

/* --------------------------------------------------------------------------
 * Tiles
 * ------------------------------------------------------------------------ */
function setupTile(tile, pal) {
  const name = tile.dataset.controlTile
  const factory = FACTORIES[name]
  const canvas = $('.s-control__canvas', tile)
  if (!factory || !canvas) return null

  const state = $('[data-control-state]', tile)
  const readout = $('[data-control-readout]', tile)
  const run = $('[data-control-run]', tile)
  const viz = factory({ pal, seed: SEEDS[name] })

  const mount = mountViz({
    tile,
    canvas,
    viz,
    onStatus: (text, tone) => {
      if (!state) return
      state.textContent = text
      state.classList.toggle('is-ignite', tone === 'ignite')
    },
    onReadout: (text) => {
      if (readout) readout.textContent = text
    },
  })

  // Hover / focus energy
  let hovering = false
  let focused = false
  let pulse = 0
  const sync = () => {
    const active = hovering || focused
    tile.classList.toggle('is-active', active)
    tile.classList.toggle('is-hover', hovering)
    mount.setEnergy(active || pulse ? 1 : 0)
  }

  if (finePointer) initCrosshair(tile, mount)

  tile.addEventListener('pointerenter', (event) => {
    if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return
    hovering = true
    sync()
  })
  tile.addEventListener('pointerleave', () => {
    hovering = false
    mount.setPointer(false)
    sync()
  })
  tile.addEventListener('focusin', (event) => {
    focused = event.target.matches(':focus-visible')
    tile.classList.toggle('is-focus', focused)
    sync()
  })
  tile.addEventListener('focusout', () => {
    focused = false
    tile.classList.remove('is-focus')
    sync()
  })

  if (run) {
    run.hidden = false
    run.addEventListener('click', () => {
      mount.trigger()
      emit('sound:cue', { type: name === 'safety' ? 'whoosh' : 'blip' })
      if (name === 'safety') gsap.delayedCall(1.4, () => emit('sound:cue', { type: 'confirm' }))
      // Touch has no hover: give the tile a short burst of energy instead.
      clearTimeout(pulse)
      pulse = setTimeout(() => {
        pulse = 0
        sync()
      }, 1600)
      sync()
    })
  }

  return { name, tile, viz, mount }
}

/** Crosshair + reticle that follow a fine pointer; feeds pointer coords to the viz. */
function initCrosshair(tile, mount) {
  tile.classList.add('has-pointer')
  const layer = document.createElement('div')
  layer.className = 's-control__xhair'
  layer.setAttribute('aria-hidden', 'true')
  layer.innerHTML =
    '<span class="s-control__xh s-control__xh--h"></span>' +
    '<span class="s-control__xh s-control__xh--v"></span>' +
    '<span class="s-control__xreticle ticks"><span class="s-control__xlabel">000 · 000</span></span>'
  tile.insertBefore(layer, $('.s-control__frame', tile))

  const h = $('.s-control__xh--h', layer)
  const v = $('.s-control__xh--v', layer)
  const reticle = $('.s-control__xreticle', layer)
  const text = $('.s-control__xlabel', layer)
  // Hairlines track the pointer exactly; the reticle trails a beat behind ("lock-on").
  const toX = gsap.quickSetter(reticle, 'x', 'px')
  const toY = gsap.quickSetter(reticle, 'y', 'px')
  const follow = { x: 0, y: 0 }
  const lag = { duration: 0.28, ease: 'power3.out' }
  const ease = {
    x: gsap.quickTo(follow, 'x', { ...lag, onUpdate: () => toX(follow.x) }),
    y: gsap.quickTo(follow, 'y', { ...lag, onUpdate: () => toY(follow.y) }),
  }
  let entered = false

  tile.addEventListener('pointermove', (event) => {
    if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return
    // Rect read in a pointer handler (not scroll): layout is clean here, we only write transforms.
    const rect = tile.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    mount.setPointer(true, x, y)
    // Feeds the CSS pointer light (lit edge + console-glass spotlight).
    tile.style.setProperty('--control-tx', `${x}px`)
    tile.style.setProperty('--control-ty', `${y}px`)
    h.style.transform = `translate3d(0, ${y}px, 0)`
    v.style.transform = `translate3d(${x}px, 0, 0)`
    if (!entered) {
      entered = true
      follow.x = x
      follow.y = y
      toX(x)
      toY(y)
    }
    ease.x(x)
    ease.y(y)
    text.textContent = `X ${pad((x / rect.width) * 1000, 3)} · Y ${pad((y / rect.height) * 1000, 3)}`
  })
  tile.addEventListener('pointerleave', () => {
    entered = false
  })
}

/** Big node counter in the SCALE tile (+ the ribbon's NODES readout). */
function initCounter(root, scale) {
  const el = $('[data-control-counter]', root)
  if (!el || !scale) return
  let last = ''
  const update = () => {
    const text = formatNodes(scale.viz.count)
    if (text !== last) {
      last = text
      el.textContent = text
    }
  }
  if (reducedMotion) {
    // Stills are computed after layout; read the count once they exist.
    requestAnimationFrame(() => requestAnimationFrame(update))
    return
  }
  // Only tick while the tile is on screen.
  observeVisibility(scale.tile, (visible) => (visible ? gsap.ticker.add(update) : gsap.ticker.remove(update)), {
    rootMargin: '100px',
  })
}

/* --------------------------------------------------------------------------
 * HOLD — pauses every animation on the console
 * ------------------------------------------------------------------------ */
function initHold(root, systems, telemetry) {
  const button = $('[data-control-hold]', root)
  if (!button || reducedMotion) return
  button.hidden = false
  button.addEventListener('click', () => {
    const held = button.getAttribute('aria-pressed') !== 'true'
    button.setAttribute('aria-pressed', String(held))
    root.classList.toggle('is-held', held)
    for (const sys of systems) sys.mount.setHeld(held)
    telemetry.setHeld(held)
    emit('sound:cue', { type: 'blip' })
  })
}

/* --------------------------------------------------------------------------
 * Systems board (header): count + one lamp per system
 * ------------------------------------------------------------------------ */
function createMeter(root) {
  const box = $('.s-control__systems', root)
  const count = $('[data-control-online]', root)
  const status = $('[data-control-systems-status]', root)
  const rows = $$('[data-control-lamp]', root)
  const names = rows.map((row) => row.dataset.controlLamp)
  const total = rows.length
  const on = new Set(names)

  const render = () => {
    if (count) count.textContent = pad(on.size)
    rows.forEach((row, i) => row.classList.toggle('is-on', on.has(names[i])))
    box?.classList.toggle('is-standby', on.size < total)
    if (status) status.textContent = on.size >= total ? 'All systems nominal' : on.size ? 'Power-on sequence' : 'Standby'
  }

  if (!reducedMotion) {
    on.clear()
    render()
  }

  let done = false
  /** Brings one system online (the next one in order when no name is given). */
  const up = (name = names.find((n) => !on.has(n))) => {
    if (!name || on.has(name)) return
    on.add(name)
    render()
    const row = rows[names.indexOf(name)]
    if (row) {
      row.classList.add('is-hot')
      gsap.delayedCall(0.4, () => row.classList.remove('is-hot'))
    }
    if (on.size === total && !done) {
      done = true
      emit('sound:cue', { type: 'confirm' })
    }
  }

  return {
    up,
    sequence() {
      names.forEach((name, i) => gsap.delayedCall(i * 0.22, () => up(name)))
    },
  }
}

/* --------------------------------------------------------------------------
 * Reveals
 * ------------------------------------------------------------------------ */
function revealHead(root, meter) {
  const head = $('.s-control__head', root)
  const title = $('.s-control__title', root)
  const items = $$('.s-control__head [data-control-reveal]', root)
  const rule = $('.s-control__head-grid', root)
  const split = SplitText.create(title, { type: 'words,chars', mask: 'chars', charsClass: 's-control__char', wordsClass: 's-control__word' })
  gsap.set(split.chars, { yPercent: 112 })
  gsap.set(items, { y: 22 })
  if (rule) gsap.set(rule, { '--control-rule': 0 })

  ScrollTrigger.create({
    trigger: head,
    start: 'top 82%',
    once: true,
    onEnter: () => {
      const tl = gsap.timeline()
      tl.to(split.chars, { yPercent: 0, duration: 1.5, ease: 'expo.out', stagger: 0.028 }, 0)
      tl.to(items, { opacity: 1, y: 0, duration: 1.3, ease: 'expo.out', stagger: 0.09 }, 0.2)
      if (rule) tl.to(rule, { '--control-rule': 1, duration: 1.6, ease: 'expo.inOut' }, 0.1)
      // When the grid sits below the fold (narrow screens), the meter runs its
      // own power-on sequence instead of waiting for every tile.
      if (!matchMedia(WIDE).matches) tl.add(() => meter.sequence(), 0.9)
    },
  })

  // Ribbon + footnote
  const ribbon = $('[data-control-ribbon]', root)
  const ribbonItems = $$('[data-control-ribbon] [data-control-reveal], [data-control-ticker], [data-control-hold]', root)
  gsap.set(ribbonItems, { opacity: 0 })
  ScrollTrigger.create({
    trigger: ribbon,
    start: 'top 90%',
    once: true,
    onEnter: () => {
      gsap.fromTo(ribbon, { clipPath: 'inset(0 50% 0 50%)' }, { clipPath: 'inset(0 0% 0 0%)', duration: 1.3, ease: 'expo.inOut', clearProps: 'clipPath' })
      gsap.to(ribbonItems, { opacity: 1, duration: 1, ease: 'power2.out', stagger: 0.1, delay: 0.5 })
    },
  })

  const note = $('.s-control__note', root)
  if (note) {
    gsap.set(note, { y: 16 })
    ScrollTrigger.create({
      trigger: note,
      start: 'top 95%',
      once: true,
      onEnter: () => gsap.to(note, { opacity: 1, y: 0, duration: 1.2, ease: 'expo.out' }),
    })
  }
}

function revealTiles(root, systems, meter) {
  const bySystem = new Map(systems.map((sys) => [sys.tile, sys]))
  const tiles = systems.map((sys) => sys.tile)
  let first = true

  ScrollTrigger.batch(tiles, {
    start: 'top 86%',
    once: true,
    onEnter: (batch) => {
      if (first) {
        first = false
        emit('sound:cue', { type: 'blip' })
      }
      batch.forEach((tile, i) => powerOn(bySystem.get(tile), i * 0.16, meter))
    },
  })
}

/** One tile's power-on: scanline wipe, viz boot, HUD decode, copy rise. */
function powerOn(sys, delay, meter) {
  if (!sys) return
  const { tile, mount } = sys
  const scan = document.createElement('span')
  scan.className = 's-control__scan'
  scan.setAttribute('aria-hidden', 'true')
  tile.appendChild(scan)

  // The run button only fades: a transform on it would become the containing
  // block of its stretched ::after and shrink the tile-wide hit area.
  const copy = $$('.s-control__body > *, .s-control__state, .s-control__readout, .s-control__counter', tile)
  const run = $('.s-control__run', tile)
  const sysLabel = $('[data-control-decode]', tile)
  gsap.set(copy, { opacity: 0, y: 14 })
  if (run) gsap.set(run, { opacity: 0 })

  const tl = gsap.timeline({ delay })
  tl.set(tile, { opacity: 1 })
  tl.fromTo(tile, { clipPath: 'inset(0 0 100% 0)' }, { clipPath: 'inset(0 0 0% 0)', duration: 1.05, ease: 'expo.inOut', clearProps: 'clipPath' }, 0)
  tl.fromTo(scan, { opacity: 1, y: 0 }, { y: () => tile.offsetHeight, duration: 1.05, ease: 'expo.inOut' }, 0)
  tl.to(scan, { opacity: 0, duration: 0.4, onComplete: () => scan.remove() }, 0.9)
  tl.to(mount.state, { boot: 1, duration: 2.2, ease: 'power2.out' }, 0.3)
  tl.add(() => sysLabel && decode(sysLabel), 0.25)
  tl.to(copy, { opacity: 1, y: 0, duration: 1.1, ease: 'expo.out', stagger: 0.07, clearProps: 'transform' }, 0.5)
  if (run) tl.to(run, { opacity: 1, duration: 0.9, ease: 'power2.out' }, 0.75)
  if (matchMedia(WIDE).matches) tl.add(() => meter.up(sys.name), 0.85)
}

/** Scrambles a short mono label into place. */
function decode(el) {
  const final = el.textContent
  const total = 16
  let frame = 0
  const tick = () => {
    frame++
    const reveal = Math.floor((frame / total) * final.length)
    let out = ''
    for (let i = 0; i < final.length; i++) {
      const ch = final[i]
      out += i < reveal || ch === ' ' || ch === '/' ? ch : GLYPHS[(Math.random() * GLYPHS.length) | 0]
    }
    el.textContent = out
    if (frame >= total) {
      el.textContent = final
      gsap.ticker.remove(tick)
    }
  }
  gsap.ticker.add(tick)
}
