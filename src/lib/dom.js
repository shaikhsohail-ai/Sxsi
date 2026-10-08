/** Small DOM + math helpers. */
export const $ = (selector, root = document) => root.querySelector(selector)
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector))

export const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value))
export const lerp = (a, b, t) => a + (b - a) * t
/** Maps `value` from [inMin, inMax] to [outMin, outMax], clamped. */
export const mapRange = (value, inMin, inMax, outMin, outMax) =>
  outMin + (outMax - outMin) * clamp((value - inMin) / (inMax - inMin))
export const pad = (n, width = 2) => String(Math.floor(Math.abs(n))).padStart(width, '0')

/** Formats a number with fixed decimals and thin-space grouping, e.g. 27 600.0 */
export function formatNumber(value, decimals = 0) {
  const [int, frac] = Math.abs(value).toFixed(decimals).split('.')
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return (value < 0 ? '−' : '') + grouped + (frac ? '.' + frac : '')
}

/** Deterministic PRNG (mulberry32) — use for procedural art that must be stable. */
export function seededRandom(seed = 1) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Stable 32-bit string hash (FNV-1a). */
export function hashString(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
