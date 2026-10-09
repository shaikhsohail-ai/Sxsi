/**
 * Boarding-pass data + procedural art.
 *
 * Pure functions shared by the live HTML/SVG pass (join.js) and the share
 * image renderer (pass-image.js), so both always print the same crew ID, seat,
 * security rosette and matrix code for a given name.
 */
import { hashString, seededRandom, pad } from '../../lib/dom.js'
import { NEXT_MISSION, COORDINATES } from '../../config.js'

export const NAME_MAX = 28
export const NAME_MIN = 2

// Letters (any script), marks, digits, spaces and a little punctuation.
const NAME_PATTERN = /^[\p{L}\p{M}\p{N} .'’\-_]+$/u
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

/** Collapses whitespace and trims. */
export function normaliseName(raw) {
  return String(raw ?? '').replace(/\s+/g, ' ').trim()
}

/** Returns an error message, or '' when the name is printable. */
export function validateName(raw) {
  const name = normaliseName(raw)
  const length = [...name].length
  if (!name) return 'Enter a callsign or name to print on your pass.'
  if (length < NAME_MIN) return `Callsigns need at least ${NAME_MIN} characters.`
  if (length > NAME_MAX) return `Keep it to ${NAME_MAX} characters or fewer.`
  if (!NAME_PATTERN.test(name)) return 'Use letters, numbers, spaces, hyphens, periods or apostrophes.'
  return ''
}

/** Returns an error message, or '' when the email is empty (optional) or plausible. */
export function validateEmail(raw, { required = false } = {}) {
  const email = String(raw ?? '').trim()
  if (!email) return required ? 'Enter your email address.' : ''
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) return 'That email doesn’t look right. Check it for typos.'
  return ''
}

/** "2027-01-01T00:00:00Z" → { date: '01 JAN 2027', time: '00:00 UTC' } */
export function formatBoarding(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { date: 'TBA', time: '' }
  return {
    date: `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`,
  }
}

/** Everything printed on a pass, derived deterministically from the name. */
export function createPass(rawName) {
  const name = normaliseName(rawName).toLocaleUpperCase()
  const seed = hashString(`${name}|SXSI|${NEXT_MISSION.number}`)
  const rand = seededRandom(seed)
  const hex = seed.toString(16).toUpperCase().padStart(8, '0')
  const row = 1 + Math.floor(rand() * 24)
  const letter = 'ABCDEF'[Math.floor(rand() * 6)]
  const boarding = formatBoarding(NEXT_MISSION.launchAt)

  return {
    name,
    seed,
    crewId: `SX-${hex.slice(0, 4)}-${hex.slice(4)}`,
    flight: `SX ${NEXT_MISSION.number}`,
    missionNumber: NEXT_MISSION.number,
    missionName: String(NEXT_MISSION.name).toUpperCase(),
    seat: `${pad(row)}${letter}`,
    group: String(1 + Math.floor(rand() * 4)),
    gate: NEXT_MISSION.pad,
    boardingDate: boarding.date,
    boardingTime: boarding.time,
    originDetail: `${NEXT_MISSION.pad} · ${Math.abs(COORDINATES.lat).toFixed(2)}° ${COORDINATES.lat >= 0 ? 'N' : 'S'}`,
    destinationDetail: 'LEO · 400 KM',
  }
}

/** The ghost pass shown before anything is typed. */
export function samplePass() {
  const boarding = formatBoarding(NEXT_MISSION.launchAt)
  return {
    name: '',
    seed: hashString('SXSI'),
    crewId: 'SX-····-····',
    flight: `SX ${NEXT_MISSION.number}`,
    missionNumber: NEXT_MISSION.number,
    missionName: String(NEXT_MISSION.name).toUpperCase(),
    seat: '—',
    group: '—',
    gate: NEXT_MISSION.pad,
    boardingDate: boarding.date,
    boardingTime: boarding.time,
    originDetail: `${NEXT_MISSION.pad} · ${Math.abs(COORDINATES.lat).toFixed(2)}° ${COORDINATES.lat >= 0 ? 'N' : 'S'}`,
    destinationDetail: 'LEO · 400 KM',
  }
}

/**
 * Decorative 2D matrix code (Aztec-like bullseye + seeded data modules).
 * Not an encoding of anything — it only *looks* machine-readable.
 * Returns an SVG path in module units for a `0 0 size size` viewBox.
 */
export function matrixCodePath(seed, size = 19) {
  const rand = seededRandom(seed ^ 0x9e3779b9)
  const c = (size - 1) / 2
  let d = ''
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ring = Math.max(Math.abs(x - c), Math.abs(y - c))
      let on
      if (ring <= 4) on = ring % 2 === 0 // bullseye finder
      else if (ring === 5) {
        // orientation marks on three corners of the finder's quiet ring
        const corner = Math.abs(x - c) === 5 && Math.abs(y - c) === 5
        on = corner && !(x > c && y > c)
      } else on = rand() > 0.48
      if (on) d += `M${x} ${y}h1v1h-1z`
    }
  }
  return d
}

/**
 * Banknote-style guilloche rosette: families of phase-shifted sinusoidal
 * loops woven around a centre. Unit radius, centred on 0,0. Returns one SVG
 * path string (also usable as a canvas Path2D).
 */
export function guillochePath(seed, { detail = 1 } = {}) {
  const rand = seededRandom(seed ^ 0x51ed27)
  const families = [
    { base: 0.8, amp: 0.13, lobes: 9 + Math.floor(rand() * 6), copies: 20, sub: 0.04, subLobes: 31 },
    { base: 0.5, amp: 0.16, lobes: 6 + Math.floor(rand() * 5), copies: 16, sub: 0.05, subLobes: 17 },
    { base: 0.24, amp: 0.1, lobes: 5 + Math.floor(rand() * 4), copies: 12, sub: 0.02, subLobes: 13 },
    { base: 0.08, amp: 0.06, lobes: 3 + Math.floor(rand() * 3), copies: 8, sub: 0.0, subLobes: 0 },
  ]
  const twist = 0.6 + rand() * 0.8
  let d = ''
  for (const f of families) {
    const steps = Math.round((60 + f.lobes * 14) * detail)
    const copies = Math.max(6, Math.round(f.copies * detail))
    for (let k = 0; k < copies; k++) {
      const phase = (k / copies) * Math.PI * 2
      for (let i = 0; i <= steps; i++) {
        const t = (i / steps) * Math.PI * 2
        const r =
          f.base +
          f.amp * Math.sin(f.lobes * t + phase) +
          f.sub * Math.sin(f.subLobes * t - phase * twist)
        const x = r * Math.cos(t)
        const y = r * Math.sin(t)
        d += `${i ? 'L' : 'M'}${x.toFixed(4)} ${y.toFixed(4)}`
      }
    }
  }
  return d
}
