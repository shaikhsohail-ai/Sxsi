/**
 * Mission Control head + ribbon: the UTC mission clock, mission elapsed time
 * and the simulated telemetry ticker.
 *
 * The ticker is a seamless marquee (the list is cloned once, aria-hidden) that
 * slows under the pointer and pauses offscreen or on HOLD. Under reduced
 * motion (or without JS) it's never built: CSS lays the readings out as a
 * still board.
 */
import { gsap } from '../../lib/motion.js'
import { reducedMotion } from '../../lib/quality.js'
import { observeVisibility } from '../../lib/visibility.js'
import { $, $$, pad, formatNumber } from '../../lib/dom.js'

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
const PX_PER_SECOND = 42

export function initTelemetry(root, { getNodes }) {
  const started = performance.now()
  const clock = {
    utc: $('[data-control-utc]', root),
    date: $('[data-control-date]', root),
    doy: $('[data-control-doy]', root),
    met: $('[data-control-met]', root),
    day: $('[data-control-day]', root),
  }

  let visible = false
  let held = false
  let clockTimer = 0
  let valueTimer = 0

  /* ---- Clock ------------------------------------------------------------------- */
  const elapsed = () => Math.floor((performance.now() - started) / 1000)
  const hms = (secs) => `${pad(secs / 3600)}:${pad((secs / 60) % 60)}:${pad(secs % 60)}`

  function tickClock() {
    const now = new Date()
    if (clock.utc) {
      clock.utc.innerHTML = `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:<span class="s-control__clock-sec">${pad(now.getUTCSeconds())}</span>`
    }
    if (clock.date) clock.date.textContent = `${pad(now.getUTCDate())} ${MONTHS[now.getUTCMonth()]} ${now.getUTCFullYear()}`
    if (clock.doy) {
      const start = Date.UTC(now.getUTCFullYear(), 0, 0)
      clock.doy.textContent = pad(Math.floor((now.getTime() - start) / 86400000), 3)
    }
    if (clock.met) clock.met.textContent = `T+ ${hms(elapsed())}`
    if (clock.day) {
      const secs = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds()
      clock.day.style.setProperty('--control-day', (secs / 86400).toFixed(5))
    }
    setValue('uptime', hms(elapsed()))
  }

  function scheduleClock() {
    clearTimeout(clockTimer)
    if (!visible) return
    tickClock()
    // Align ticks to the wall-clock second.
    clockTimer = setTimeout(scheduleClock, 1000 - (Date.now() % 1000) + 8)
  }

  /* ---- Simulated values ---------------------------------------------------------- */
  const sim = { tokens: 48213, temp: 2.74, latency: 18, orbit: 412.6, signal: -71.4, dv: 98.2 }
  const wander = (v, step, min, max) => Math.min(max, Math.max(min, v + (Math.random() - 0.5) * step))

  function setValue(key, text) {
    for (const el of $$(`[data-tlm="${key}"]`, root)) if (el.textContent !== text) el.textContent = text
  }

  function tickValues() {
    if (!held) {
      sim.tokens = wander(sim.tokens, 2600, 41000, 56000)
      sim.temp = wander(sim.temp, 0.03, 2.69, 2.79)
      sim.latency = wander(sim.latency, 4, 12, 26)
      sim.orbit = wander(sim.orbit, 0.18, 411.8, 413.4)
      sim.signal = wander(sim.signal, 0.8, -74, -69)
      sim.dv = Math.max(97.1, sim.dv - Math.random() * 0.004)
      setValue('tokens', formatNumber(sim.tokens))
      setValue('temp', `${sim.temp.toFixed(2)} K`)
      setValue('latency', `${pad(sim.latency, 3)} ms`)
      setValue('orbit', `${sim.orbit.toFixed(1)} km`)
      setValue('signal', `${formatNumber(sim.signal, 1)} dBm`)
      setValue('dv', `${sim.dv.toFixed(1)} %`)
      setValue('nodes', formatNodes(getNodes()))
    }
  }

  function scheduleValues() {
    clearInterval(valueTimer)
    valueTimer = 0
    if (visible && !reducedMotion) valueTimer = setInterval(tickValues, 700)
  }

  /* ---- Marquee ---------------------------------------------------------------------- */
  const ticker = $('[data-control-ticker]', root)
  const track = $('[data-control-track]', root)
  let marquee = null

  if (track && !reducedMotion) {
    // A running marquee keeps its strip even if reduced motion is switched on
    // later (the CSS still board would otherwise lay out its moving copies).
    root.classList.add('is-marquee')
    // Clone once for a seamless loop; the copy is decorative.
    const items = Array.from(track.children)
    for (const item of items) {
      const clone = item.cloneNode(true)
      clone.setAttribute('aria-hidden', 'true')
      track.appendChild(clone)
    }
    const build = () => {
      const progress = marquee ? marquee.progress() : 0
      marquee?.kill()
      const distance = track.scrollWidth / 2
      marquee = gsap.fromTo(track, { x: 0 }, { x: -distance, duration: distance / PX_PER_SECOND, ease: 'none', repeat: -1, paused: true })
      marquee.progress(progress)
      if (visible && !held) marquee.play()
    }
    build()
    document.fonts?.ready.then(build)
    let resizeTimer = 0
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(build, 200)
    })
    ticker.addEventListener('pointerenter', () => gsap.to(marquee, { timeScale: 0.18, duration: 0.6, ease: 'power2.out' }))
    ticker.addEventListener('pointerleave', () => gsap.to(marquee, { timeScale: 1, duration: 0.9, ease: 'power2.inOut' }))
  }

  observeVisibility(
    root,
    (isVisible) => {
      visible = isVisible
      scheduleClock()
      scheduleValues()
      if (marquee) isVisible && !held ? marquee.play() : marquee.pause()
    },
    { rootMargin: '100px' },
  )

  tickClock()

  return {
    setHeld(value) {
      held = value
      if (marquee) held || !visible ? marquee.pause() : marquee.play()
    },
  }
}

/** Zero-padded, thin-grouped node count: 000 064, 012 845, 1 204 551. */
export function formatNodes(n) {
  const digits = String(Math.max(0, Math.floor(n))).padStart(6, '0')
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}
