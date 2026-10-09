/**
 * LAUNCH MANIFEST — SXSI's roadmap, flown as a launch manifest.
 *
 * The static HTML holds every mission (see the comment at the top of
 * manifest.html). This module enhances it:
 *   - reads the missions from their data attributes and updates the tallies;
 *   - replaces each static patch with a procedurally generated one
 *     (./patch.js) that tilts under the pointer / on focus and can be
 *     downloaded as a PNG "collectible";
 *   - runs a live T− countdown for the mission in progress (date from config);
 *   - marks the Kármán line ("space begins") before the first mission still
 *     ahead, with the atmosphere glowing behind everything already underway;
 *   - wide screens: the pinned, scroll-driven ascent (./flight.js);
 *     elsewhere: a vertical timeline whose rail draws as you scroll.
 * Reduced motion: no pin, no scrub, no reveals — the full static manifest.
 */
import { gsap, ScrollTrigger } from '../../lib/motion.js'
import { emit } from '../../lib/bus.js'
import { reducedMotion, byTier } from '../../lib/quality.js'
import { observeVisibility } from '../../lib/visibility.js'
import { $, $$, pad, clamp } from '../../lib/dom.js'
import { NEXT_MISSION } from '../../config.js'
import { assignMotifs, createPatchMarkup, patchToBlob } from './patch.js'
import { createFlight } from './flight.js'
import { paintStars } from './stars.js'

const FLIGHT_MQ = '(min-width: 1024px) and (min-height: 640px)'
const finePointer = typeof matchMedia === 'function' && matchMedia('(hover: hover) and (pointer: fine)').matches
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function init() {
  const root = document.getElementById('manifest')
  if (!root) return

  const missions = readMissions(root)
  if (!missions.length) return
  assignMotifs(missions)

  root.style.setProperty('--count', missions.length)
  missions.forEach((m, i) => m.el.style.setProperty('--i', i))
  root.classList.add('is-armed')
  if (reducedMotion) root.classList.add('is-static', 'is-entered')

  const announce = createAnnouncer(root)
  updateTally(root, missions)
  missions.forEach((m) => mountPatch(m, announce))
  initCountdowns(root, missions)
  const edge = mountEdge(missions)
  // Idle off-screen: the halo / cue loops pause (see .is-idle in the CSS).
  observeVisibility(root, (visible) => root.classList.toggle('is-idle', !visible), { rootMargin: '100px' })

  if (reducedMotion) {
    // Static manifest: the flown part of the timeline is lit, nothing moves.
    missions.forEach((m) => m.el.classList.add('is-in'))
    missions.filter((m) => m.status === 'complete' || m.status === 'active').forEach((m) => m.el.classList.add('is-reached'))
    const paintSky = createSkyPainter(root)
    requestAnimationFrame(paintSky)
    window.addEventListener('resize', paintSky, { passive: true })
    return
  }

  // Intro reveal (both layouts)
  ScrollTrigger.create({
    trigger: root,
    start: 'top 72%',
    once: true,
    onEnter: () => root.classList.add('is-entered'),
  })

  // Sound cue as the trajectory reaches a mission (played only if the visitor
  // enabled sound). Throttled so scrubbing back and forth can't stack cues.
  let lastCue = 0
  const onReach = (mission) => {
    const now = performance.now()
    if (now - lastCue < 600) return
    lastCue = now
    emit('sound:cue', { type: mission.status === 'active' ? 'ignition' : 'blip' })
  }

  const mm = gsap.matchMedia()
  mm.add(FLIGHT_MQ, () => createFlight(root, missions, { onReach }))
  mm.add(`not all and ${FLIGHT_MQ}`, () => createTimeline(root, missions, { onReach, edge }))
}

/* --------------------------------------------------------------------------
 * Data
 * ------------------------------------------------------------------------ */
function readMissions(root) {
  return $$('[data-mission]', root).map((el, index) => {
    const number = (el.dataset.number || pad(index + 1, 3)).trim()
    const isNext = NEXT_MISSION?.number === number
    return {
      el,
      index,
      number,
      name: ($('[data-mission-name]', el)?.textContent || `Mission ${number}`).trim(),
      status: (el.dataset.status || 'planned').trim().toLowerCase(),
      motif: el.dataset.motif?.trim().toLowerCase(),
      target: isNext && NEXT_MISSION.launchAt ? NEXT_MISSION.launchAt : el.dataset.target,
    }
  })
}

/**
 * The edge of space, drawn in the timeline layouts just before the first
 * mission that is still ahead (flight mode has its own Kármán line in the HUD).
 */
function mountEdge(missions) {
  const first = missions.find((m) => m.status === 'planned' || m.status === 'tbd')
  if (!first || first.index === 0) return null
  const edge = document.createElement('div')
  edge.className = 's-manifest__edge'
  edge.setAttribute('aria-hidden', 'true')
  edge.innerHTML = `
    <span class="s-manifest__edge-line"></span>
    <span class="s-manifest__edge-label hud">Kármán line <span>· 100 km</span></span>
    <span class="s-manifest__edge-tag hud">Space begins</span>`
  first.el.classList.add('has-edge')
  first.el.prepend(edge)
  return edge
}

function updateTally(root, missions) {
  const count = (fn) => pad(missions.filter(fn).length)
  const values = {
    all: pad(missions.length),
    complete: count((m) => m.status === 'complete'),
    active: count((m) => m.status === 'active'),
    ahead: count((m) => m.status === 'planned' || m.status === 'tbd'),
  }
  for (const el of $$('[data-tally]', root)) {
    const value = values[el.dataset.tally]
    if (value != null) el.textContent = value
  }
}

/* --------------------------------------------------------------------------
 * Patches — generated, tiltable, collectible
 * ------------------------------------------------------------------------ */
function mountPatch(mission, announce) {
  const slot = $('[data-mission-patch]', mission.el)
  if (!slot) return
  const markup = createPatchMarkup(mission)
  const label = `Mission ${mission.number} ${mission.name} patch`

  // The artwork is decorative (its lettering repeats the card); the button on
  // top of it carries the name, so its accessible name matches what it does.
  slot.innerHTML = `
    <span class="s-manifest__patch-tilt" aria-hidden="true">
      ${markup}
      <span class="s-manifest__patch-glint"></span>
      <span class="s-manifest__patch-sheen"></span>
    </span>
    <button class="s-manifest__patch" type="button"></button>
    <span class="s-manifest__patch-hint hud" aria-hidden="true">
      <span class="s-manifest__patch-hint-idle">Collect patch</span>
      <span class="s-manifest__patch-hint-done">Patch collected</span>
      <svg viewBox="0 0 12 12" focusable="false"><path d="M6 1.5v7M2.8 5.6 6 8.8l3.2-3.2M2 10.5h8" /></svg>
    </span>`
  if (mission.status === 'active') slot.insertAdjacentHTML('afterbegin', '<span class="s-manifest__patch-halo" aria-hidden="true"></span>')

  const button = $('.s-manifest__patch', slot)
  button.setAttribute('aria-label', `Download the ${label}`)
  const tilt = $('.s-manifest__patch-tilt', slot)
  initTilt(slot, button, tilt)

  let busy = false
  button.addEventListener('click', async () => {
    if (busy) return
    busy = true
    slot.classList.add('is-busy')
    try {
      const { blob, ext } = await patchToBlob(markup)
      const slug = mission.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      downloadBlob(blob, `sxsi-mission-${mission.number}-${slug}-patch.${ext}`)
      emit('sound:cue', { type: 'confirm' })
      slot.classList.add('is-collected')
      announce(`Mission ${mission.number} ${mission.name} patch downloaded.`)
      setTimeout(() => slot.classList.remove('is-collected'), 2400)
    } catch (error) {
      console.warn('[sxsi] manifest: patch export failed', error)
    } finally {
      busy = false
      slot.classList.remove('is-busy')
    }
  })
}

/** 3D tilt + light sheen that follows a fine pointer; keyboard focus gets a resting tilt. */
function initTilt(slot, button, tilt) {
  button.addEventListener('focus', () => slot.classList.toggle('is-focus', button.matches(':focus-visible')))
  button.addEventListener('blur', () => slot.classList.remove('is-focus'))
  if (reducedMotion) return

  const rx = gsap.quickTo(tilt, 'rotationX', { duration: 0.7, ease: 'power3.out' })
  const ry = gsap.quickTo(tilt, 'rotationY', { duration: 0.7, ease: 'power3.out' })
  gsap.set(tilt, { transformPerspective: 900 })
  const rest = () => {
    if (slot.classList.contains('is-focus')) {
      rx(10)
      ry(-14)
      tilt.style.setProperty('--mx', '28%')
      tilt.style.setProperty('--my', '22%')
    } else {
      rx(0)
      ry(0)
    }
  }
  button.addEventListener('focus', rest)
  button.addEventListener('blur', rest)
  if (!finePointer) return

  let rect = null
  button.addEventListener('pointerenter', () => {
    rect = button.getBoundingClientRect()
    slot.classList.add('is-hover')
  })
  button.addEventListener('pointermove', (event) => {
    if (!rect) rect = button.getBoundingClientRect()
    const x = clamp((event.clientX - rect.left) / rect.width)
    const y = clamp((event.clientY - rect.top) / rect.height)
    rx((0.5 - y) * 26)
    ry((x - 0.5) * 30)
    tilt.style.setProperty('--mx', `${(x * 100).toFixed(1)}%`)
    tilt.style.setProperty('--my', `${(y * 100).toFixed(1)}%`)
  })
  button.addEventListener('pointerleave', () => {
    rect = null
    slot.classList.remove('is-hover')
    rest()
  })
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

function createAnnouncer(root) {
  const live = document.createElement('p')
  live.className = 'sr-only'
  live.setAttribute('aria-live', 'polite')
  root.append(live)
  return (text) => {
    live.textContent = ''
    requestAnimationFrame(() => (live.textContent = text))
  }
}

/* --------------------------------------------------------------------------
 * Countdown — T− to the target of the mission in progress
 * ------------------------------------------------------------------------ */
function initCountdowns(root, missions) {
  const clocks = missions
    .filter((m) => m.target && !Number.isNaN(Date.parse(m.target)))
    .map((m) => {
      const at = Date.parse(m.target)
      const date = $('[data-mission-date]', m.el)
      if (date) {
        const d = new Date(at)
        date.textContent = `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
        date.setAttribute('datetime', d.toISOString())
      }
      const out = $('[data-mission-countdown]', m.el)
      if (out) {
        out.hidden = false
        out.setAttribute('aria-hidden', 'true')
      }
      return { at, out }
    })
    .filter((c) => c.out)
  if (!clocks.length) return

  const tick = () => {
    const now = Date.now()
    for (const { at, out } of clocks) {
      const diff = at - now
      const s = Math.floor(Math.abs(diff) / 1000)
      const days = Math.floor(s / 86400)
      const text = `T${diff >= 0 ? '−' : '+'} ${pad(days, 3)}D ${pad((s / 3600) % 24)}:${pad((s / 60) % 60)}:${pad(s % 60)}`
      if (out.textContent !== text) out.textContent = text
    }
  }
  tick()
  let timer = 0
  observeVisibility(
    root,
    (visible) => {
      clearInterval(timer)
      timer = 0
      if (visible) {
        tick()
        timer = setInterval(tick, 1000)
      }
    },
    { rootMargin: '200px' },
  )
}

/** A sparse, static starfield behind the timeline (repainted only when the size changes). */
function createSkyPainter(root) {
  const frame = $('[data-manifest-frame]', root)
  const starsEl = $('[data-manifest-stars]', root)
  let size = ''
  return () => {
    const width = frame.offsetWidth
    const height = frame.offsetHeight
    const key = `${width}x${height}`
    if (key === size || !width || !height) return
    size = key
    starsEl.replaceChildren()
    const count = Math.round(((width * height) / 9000) * byTier({ high: 1, medium: 0.8, low: 0.6 }))
    paintStars(starsEl, { width, height, count, alpha: [0.18, 0.65], seed: 0x5a53 })
  }
}

/* --------------------------------------------------------------------------
 * Timeline mode (narrow / short screens): rail draws, missions assemble
 * ------------------------------------------------------------------------ */
function createTimeline(root, missions, { onReach, edge }) {
  const list = $('[data-manifest-list]', root)
  const rail = document.createElement('span')
  rail.className = 's-manifest__rail'
  rail.setAttribute('aria-hidden', 'true')
  rail.innerHTML = '<span class="s-manifest__rail-fill"></span><span class="s-manifest__rail-head"></span>'
  list.prepend(rail)
  const fill = rail.firstElementChild
  const head = rail.lastElementChild

  const paintSky = createSkyPainter(root)
  let railH = 0
  // The signal travels with the drawing tip of the rail (pure writes on scroll).
  const draw = (p) => {
    fill.style.transform = `scaleY(${p.toFixed(4)})`
    head.style.transform = `translate3d(0,${(p * railH).toFixed(1)}px,0)`
    head.style.opacity = p > 0 && p < 1 ? '1' : '0'
  }

  const triggers = [
    ScrollTrigger.create({
      trigger: list,
      start: 'top 62%',
      end: 'bottom 62%',
      onRefresh: (self) => {
        paintSky()
        railH = rail.offsetHeight
        draw(self.progress)
      },
      onUpdate: (self) => draw(self.progress),
      onLeave: () => draw(1),
      onLeaveBack: () => draw(0),
    }),
  ]

  if (edge) {
    triggers.push(
      ScrollTrigger.create({
        trigger: edge,
        start: 'top 62%',
        end: 'max',
        onToggle: (self) => edge.classList.toggle('is-crossed', self.isActive),
      }),
    )
  }

  for (const mission of missions) {
    triggers.push(
      ScrollTrigger.create({
        trigger: mission.el,
        start: 'top 86%',
        once: true,
        onEnter: () => mission.el.classList.add('is-in'),
      }),
      ScrollTrigger.create({
        trigger: $('.s-manifest__patch-slot', mission.el) || mission.el,
        start: 'center 62%',
        end: 'max',
        onToggle: (self) => {
          mission.el.classList.toggle('is-reached', self.isActive)
          if (self.isActive && self.direction > 0) onReach?.(mission)
        },
      }),
    )
  }

  return () => {
    triggers.forEach((t) => t.kill())
    edge?.classList.remove('is-crossed')
    rail.remove()
    $('[data-manifest-stars]', root).replaceChildren()
    missions.forEach((m) => m.el.classList.remove('is-reached'))
  }
}
