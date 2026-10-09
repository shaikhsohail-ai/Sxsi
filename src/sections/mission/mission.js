/**
 * Mission — the manifesto.
 *
 * 1. Splits the statement into words (screen readers keep one sentence via an
 *    sr-only copy) and lights them one by one with a scrubbed timeline while
 *    the frame is held by `position: sticky`. Each word owns a CSS variable
 *    `--l` (0 → 1); mission.css turns it into opacity, colour and glow.
 * 2. Mirrors progress in a segmented "transmission" meter (one segment/word).
 * 3. Reveals the principles + facts as they enter (CSS transitions).
 * 4. Runs the ambient orbital chart (orbits.js) only while the stage is near.
 *
 * Reduced motion: no split-dimming, no runway, no reveals — fully lit text
 * and a single still frame of the chart.
 */
import { gsap, ScrollTrigger } from '../../lib/motion.js'
import { emit } from '../../lib/bus.js'
import { reducedMotion, tier } from '../../lib/quality.js'
import { observeVisibility } from '../../lib/visibility.js'
import { $, $$, clamp, pad } from '../../lib/dom.js'

const STEP = 0.3 // timeline gap between successive words
const SPAN = 1.15 // how long each word takes to light (≈ 4 words in flight)

export function init() {
  const root = document.getElementById('mission')
  if (!root) return

  const stage = $('[data-mission-stage]', root)
  const statement = $('[data-mission-statement]', root)
  const words = statement ? splitStatement(statement) : []
  const meter = buildMeter(root, words)

  // Shared with the orbital chart (see orbits.js for what each field drives).
  const state = {
    enter: reducedMotion ? 1 : 0,
    progress: reducedMotion ? 1 : 0,
    wave: 0,
    waveStrength: 1,
  }

  if (!reducedMotion && stage && words.length) {
    root.classList.add('is-armed')
    if (tier === 'low') root.classList.add('is-lite')
    initManifesto(stage, words, meter, state)
    initReveals(root)
  }

  startOrbits(root, stage, statement, state)
}

/* --------------------------------------------------------------------------
 * Split: "We build <em>intelligence</em> …" → word spans (aria-hidden) plus
 * one sr-only sentence, so assistive tech reads it exactly as written.
 * ------------------------------------------------------------------------ */
function splitStatement(el) {
  const sentence = el.textContent.replace(/\s+/g, ' ').trim()
  const tokens = []
  for (const node of el.childNodes) {
    if (node.nodeType !== Node.TEXT_NODE && node.nodeType !== Node.ELEMENT_NODE) continue
    const key = node.nodeType === Node.ELEMENT_NODE
    for (const text of node.textContent.split(/\s+/)) if (text) tokens.push({ text, key })
  }

  const visual = document.createElement('span')
  visual.className = 's-mission__visual'
  visual.setAttribute('aria-hidden', 'true')

  const words = []
  for (const { text, key } of tokens) {
    if (text === '—' && words.length) {
      // The dash rides with the word before it (non-breaking, lights with it)
      const dash = document.createElement('span')
      dash.className = 's-mission__dash'
      dash.textContent = text
      words[words.length - 1].append('\u00a0', dash)
      continue
    }
    if (words.length) visual.append(' ')
    const span = document.createElement('span')
    span.className = 's-mission__w' + (key ? ' s-mission__w--key' : '')
    span.textContent = text
    if (key) span.dataset.key = '1'
    visual.append(span)
    words.push(span)
  }

  const sr = document.createElement('span')
  sr.className = 'sr-only'
  sr.textContent = sentence
  el.replaceChildren(sr, visual)
  return words
}

/* --------------------------------------------------------------------------
 * Meter: one segment per word; key words get an atmo segment.
 * ------------------------------------------------------------------------ */
function buildMeter(root, words) {
  const track = $('[data-mission-track]', root)
  const count = $('[data-mission-count]', root)
  const label = $('[data-mission-meter-state]', root)
  const meter = $('[data-mission-meter]', root)
  const segs = words.map((word) => {
    const seg = document.createElement('span')
    seg.className = 's-mission__seg' + (word.dataset.key ? ' s-mission__seg--key' : '')
    track?.append(seg)
    return seg
  })
  const total = pad(words.length)
  let shown = -1
  const set = (lit) => {
    if (lit === shown || !count) return
    shown = lit
    count.textContent = `${pad(lit)}/${total}`
    const status = lit >= words.length ? 'received' : lit > 0 ? 'incoming' : 'standby'
    if (label) label.textContent = status
    if (meter) meter.dataset.state = status
  }
  set(words.length)
  return { segs, set }
}

/* --------------------------------------------------------------------------
 * The scrubbed manifesto.
 * ------------------------------------------------------------------------ */
function initManifesto(stage, words, meter, state) {
  gsap.set([...words, ...meter.segs], { '--l': 0 })
  meter.set(0)

  const tl = gsap.timeline({
    defaults: { ease: 'none' },
    scrollTrigger: {
      trigger: stage,
      start: 'top 45%',
      end: 'bottom bottom', // the moment the sticky frame lets go
      scrub: 0.9,
    },
  })

  words.forEach((word, i) => {
    tl.to([word, meter.segs[i]], { '--l': 1, duration: SPAN, ease: 'sine.inOut' }, i * STEP)
  })
  const litAt = tl.duration()
  tl.to({}, { duration: litAt * 0.14 }) // hold, fully lit, before the frame releases

  let cued = false
  let lastLit = -1 // -1: the first update only records where the page opened
  tl.eventCallback('onUpdate', () => {
    const time = tl.time()
    state.progress = clamp(time / litAt)
    // A word counts as lit once it is halfway through its transition.
    const lit = clamp(Math.floor((time - SPAN / 2) / STEP) + 1, 0, words.length)
    meter.set(lit)

    // Reading forward past a key word: the planet transmits (orbits.js),
    // with a blip — or, on the last word, the 'received' chime below.
    if (lastLit >= 0 && lit > lastLit) {
      const fresh = words.slice(lastLit, lit)
      if (fresh.some((word) => word.dataset.key)) {
        state.waveStrength = lit === words.length ? 1.35 : 1
        state.wave++
        if (lit < words.length) emit('sound:cue', { type: 'blip' })
      }
    }
    lastLit = lit

    if (lit === words.length && !cued) {
      cued = true
      emit('sound:cue', { type: 'confirm' })
    } else if (lit < words.length - 3) {
      cued = false
    }
  })

  // Fade the orbital chart in as the stage arrives.
  ScrollTrigger.create({
    trigger: stage,
    start: 'top bottom',
    end: 'top 10%',
    onUpdate: (self) => (state.enter = self.progress),
    onRefresh: (self) => (state.enter = self.progress),
  })
}

/* --------------------------------------------------------------------------
 * Principles + facts: add `.is-in` once, CSS does the rest.
 * ------------------------------------------------------------------------ */
function initReveals(root) {
  for (const el of $$('[data-mission-reveal]', root)) {
    const reveal = () => el.classList.add('is-in')
    ScrollTrigger.create({
      trigger: el,
      start: 'top 86%',
      once: true,
      onEnter: reveal,
      // Arrived from below (deep link / restored scroll): never leave it hidden.
      onEnterBack: reveal,
      onLeave: reveal,
      onRefresh: (self) => self.progress > 0 && reveal(),
    })
  }
}

/* --------------------------------------------------------------------------
 * Orbital chart — created lazily the first time the stage nears the viewport.
 * ------------------------------------------------------------------------ */
function startOrbits(root, stage, statement, state) {
  const canvas = $('[data-mission-canvas]', root)
  if (!canvas || !stage) return
  let started = false
  const stop = observeVisibility(
    stage,
    (visible) => {
      if (!visible || started) return
      started = true
      queueMicrotask(() => stop()) // `stop` may not exist yet if this ran synchronously
      import('./orbits.js')
        .then(({ createOrbits }) => createOrbits({ canvas, host: stage, state, avoid: statement }))
        .catch((error) => console.error('[sxsi] mission chart unavailable', error))
    },
    { rootMargin: '60% 0px' },
  )
}
