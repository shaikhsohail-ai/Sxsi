/**
 * Ascent flight profile — pure functions, no DOM.
 *
 * Everything in the Ascent experience is driven by one number: scroll
 * progress `p` (0 → 1) through the pinned section. This module maps `p` to a
 * believable (but SIMULATED) mission: clock, altitude, velocity, throttle,
 * stage, atmospheric layer, plus the timing of every visual beat.
 */
import { clamp } from '../../lib/dom.js'

/**
 * Scroll progress at which each beat happens. Tuned for pacing, not physics:
 * every event card (liftoff, max-Q, MECO, stage sep, SECO, orbit) holds the
 * screen for at least 0.12 of the flight, so no chapter passes in a wheel notch.
 */
export const BEATS = {
  ignition: 0.045, // T−3 s: engines light, hold-down
  liftoff: 0.065,
  maxq: 0.24,
  meco: 0.36,
  sep: 0.49,
  ses: 0.53, // second-stage ignition
  fairing: 0.58,
  seco: 0.67,
  orbit: 0.815,
}

/** Timeline events in page order. `beat` keys into BEATS. */
export const EVENTS = [
  { id: 'liftoff', beat: 'liftoff', label: 'Liftoff' },
  { id: 'maxq', beat: 'maxq', label: 'Max-Q' },
  { id: 'meco', beat: 'meco', label: 'MECO' },
  { id: 'sep', beat: 'sep', label: 'Stage sep' },
  { id: 'seco', beat: 'seco', label: 'SECO' },
  { id: 'orbit', beat: 'orbit', label: 'Orbit' },
]

/**
 * Monotone cubic interpolation (Fritsch–Carlson) through [x, y] keyframes.
 * Smooth like a spline, but never overshoots — telemetry must not wobble.
 */
export function curve(points) {
  const n = points.length
  const xs = points.map((pt) => pt[0])
  const ys = points.map((pt) => pt[1])
  const d = []
  const m = new Array(n)
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]))
  m[0] = d[0]
  m[n - 1] = d[n - 2]
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = m[i + 1] = 0
      continue
    }
    const a = m[i] / d[i]
    const b = m[i + 1] / d[i]
    const s = a * a + b * b
    if (s > 9) {
      const t = 3 / Math.sqrt(s)
      m[i] = t * a * d[i]
      m[i + 1] = t * b * d[i]
    }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0]
    if (x >= xs[n - 1]) return ys[n - 1]
    let i = 0
    while (x > xs[i + 1]) i++
    const h = xs[i + 1] - xs[i]
    const t = (x - xs[i]) / h
    const t2 = t * t
    const t3 = t2 * t
    return (
      (2 * t3 - 3 * t2 + 1) * ys[i] +
      (t3 - 2 * t2 + t) * h * m[i] +
      (-2 * t3 + 3 * t2) * ys[i + 1] +
      (t3 - t2) * h * m[i + 1]
    )
  }
}

/** Scroll progress → mission elapsed time (seconds, negative = countdown). */
export const missionTime = curve([
  [0, -10],
  [BEATS.ignition, -3],
  [BEATS.liftoff, 0],
  [0.1, 5],
  [0.135, 10],
  [0.17, 24],
  [BEATS.maxq, 72],
  [BEATS.meco, 150],
  [BEATS.sep, 154],
  [BEATS.ses, 160],
  [BEATS.fairing, 192],
  [BEATS.seco, 510],
  [BEATS.orbit, 540],
  [1, 572],
])

/** Mission time → altitude in km (gravity-turn shaped). */
export const altitudeAt = curve([
  [0, 0],
  [5, 0.02],
  [10, 0.1],
  [20, 0.5],
  [30, 1.3],
  [45, 3.6],
  [60, 7.2],
  [72, 11.4],
  [90, 18.5],
  [120, 36],
  [150, 64],
  [160, 72],
  [192, 97],
  [240, 126],
  [300, 151],
  [400, 181],
  [510, 201],
  [572, 206],
])

/** Mission time → velocity in km/h. */
export const velocityAt = curve([
  [0, 0],
  [5, 22],
  [10, 80],
  [20, 250],
  [30, 440],
  [45, 780],
  [60, 1220],
  [72, 1580],
  [90, 2350],
  [120, 4400],
  [150, 7900],
  [154, 7930],
  [160, 8050],
  [192, 9700],
  [240, 12500],
  [300, 15800],
  [400, 21100],
  [510, 27200],
  [540, 27560],
  [572, 27580],
])

/** Altitude (km) → sky phase 0 (dawn pad) … 1 (black space), for shaders. */
export const skyPhaseAt = curve([
  [0, 0],
  [2, 0.12],
  [12, 0.27],
  [50, 0.52],
  [85, 0.72],
  [150, 0.9],
  [206, 1],
])

export const LAYERS = ['Troposphere', 'Stratosphere', 'Mesosphere', 'Thermosphere', 'Orbit']
/** Altitude boundaries (km) between layers; orbit is decided by the ORBIT beat. */
const LAYER_TOPS = [12, 50, 85]

const ramp = (p, a, b) => clamp((p - a) / (b - a))

/** Engine throttle 0–100 %, including the classic Max-Q "throttle bucket". */
export function throttleAt(p) {
  if (p < BEATS.ignition) return 0
  if (p < BEATS.meco) {
    const spool = ramp(p, BEATS.ignition, BEATS.ignition + 0.012)
    const bucket = ramp(p, BEATS.maxq - 0.045, BEATS.maxq - 0.02) - ramp(p, BEATS.maxq + 0.02, BEATS.maxq + 0.045)
    return 100 * spool - 28 * bucket
  }
  if (p < BEATS.ses) return 100 * (1 - ramp(p, BEATS.meco, BEATS.meco + 0.006))
  if (p < BEATS.seco) return 100 * ramp(p, BEATS.ses, BEATS.ses + 0.006)
  return 100 * (1 - ramp(p, BEATS.seco, BEATS.seco + 0.006))
}

/** Index of the most recent event at progress p (−1 before liftoff). */
export function eventIndexAt(p) {
  let index = -1
  EVENTS.forEach((event, i) => {
    if (p >= BEATS[event.beat]) index = i
  })
  return index
}

/** Altitude (km) → index into LAYERS. */
export function layerIndexAt(altKm, p) {
  if (p >= BEATS.orbit) return 4
  let i = 0
  while (i < LAYER_TOPS.length && altKm >= LAYER_TOPS[i]) i++
  return i
}

/** Fraction 0–1 through the altitude tape (each layer gets an equal band). */
export function tapeAt(altKm, p) {
  const bands = [0, 12, 50, 85, 160, 206]
  if (p >= BEATS.orbit) return 0.8 + 0.2 * ramp(p, BEATS.orbit, 1)
  for (let i = 0; i < bands.length - 1; i++) {
    if (altKm < bands[i + 1] || i === 3) {
      const local = clamp((altKm - bands[i]) / (bands[i + 1] - bands[i]))
      return Math.min(0.8, (i + local) / 5)
    }
  }
  return 0.8
}

/** All telemetry for one frame. */
export function telemetry(p) {
  const t = missionTime(p)
  const alt = t <= 0 ? 0 : altitudeAt(t)
  const vel = t <= 0 ? 0 : velocityAt(t)
  return {
    p,
    t,
    alt,
    vel,
    throttle: throttleAt(p),
    stage: p >= BEATS.sep ? 2 : 1,
    layer: layerIndexAt(alt, p),
    tape: tapeAt(alt, p),
    event: eventIndexAt(p),
    sky: skyPhaseAt(alt),
  }
}

/** Formats seconds as "T+ 00:02:41" / "T− 00:00:09". */
export function formatClock(seconds) {
  const sign = seconds < 0 ? '−' : '+'
  const s = Math.floor(Math.abs(seconds) + (seconds < 0 ? 0.999 : 0))
  const hh = String(Math.floor(s / 3600)).padStart(2, '0')
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return { sign, digits: `${hh}:${mm}:${ss}` }
}
