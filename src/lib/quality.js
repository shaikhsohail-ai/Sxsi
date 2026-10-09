/**
 * Device capability heuristics shared by every visual section.
 * Use `tier` to scale particle counts / shader detail and `dpr` for renderers.
 */
const nav = typeof navigator !== 'undefined' ? navigator : {}
const mq = (q) => typeof matchMedia === 'function' && matchMedia(q).matches

const cores = nav.hardwareConcurrency || 4
const memory = nav.deviceMemory || 8
const saveData = Boolean(nav.connection && nav.connection.saveData)

export const isTouch = mq('(pointer: coarse)')
export const reducedMotion = mq('(prefers-reduced-motion: reduce)')
export const isSmallScreen = typeof window !== 'undefined' && Math.min(window.innerWidth, window.innerHeight) < 700

/** 'high' | 'medium' | 'low' */
export const tier = saveData
  ? 'low'
  : cores >= 8 && memory >= 8 && !isTouch
    ? 'high'
    : cores >= 4 && !isSmallScreen
      ? 'medium'
      : 'low'

const MAX_DPR = { high: 2, medium: 1.5, low: 1.25 }

/** Device pixel ratio clamped to what the tier can afford. */
export const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, MAX_DPR[tier])

/** Pick a value per tier: `byTier({ high: 4000, medium: 2000, low: 800 })`. */
export const byTier = (values) => values[tier] ?? values.medium

let webglSupport
/** True when a WebGL context can be created (cached). */
export function hasWebGL() {
  if (webglSupport !== undefined) return webglSupport
  try {
    // A detached, local canvas: nothing keeps it once this returns.
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
    webglSupport = Boolean(gl)
    // Only a probe: hand the context straight back (browsers cap live contexts,
    // and software GL keeps paying for one that is never drawn to).
    gl?.getExtension('WEBGL_lose_context')?.loseContext()
  } catch {
    webglSupport = false
  }
  return webglSupport
}
