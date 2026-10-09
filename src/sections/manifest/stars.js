/**
 * Star sprites: one tiny element per layer whose box-shadows are the stars.
 * Painted once, then only ever moved as a composited layer.
 */
import { lerp, seededRandom } from '../../lib/dom.js'

/**
 * Paints a star layer into `container`.
 * @param {HTMLElement} container
 * @param {{ width:number, height:number, count:number, size?:number, alpha?:[number, number], seed?:number }} opts
 * @returns {HTMLElement} the layer element (translate it for parallax)
 */
export function paintStars(container, { width, height, count, size = 1, alpha = [0.25, 0.8], seed = 1 }) {
  const rand = seededRandom(seed)
  const shadows = []
  for (let i = 0; i < count; i++) {
    const x = Math.round(rand() * width)
    const y = Math.round(rand() * height)
    const a = lerp(alpha[0], alpha[1], rand() ** 2).toFixed(2)
    const tint = rand() < 0.12 ? '199 236 255' : '244 246 251'
    shadows.push(`${x}px ${y}px 0 ${rand() < 0.08 ? 0.6 : 0}px rgb(${tint} / ${a})`)
  }
  const el = document.createElement('span')
  el.className = 's-manifest__starlayer'
  el.style.width = el.style.height = `${size}px`
  el.style.boxShadow = shadows.join(',')
  container.append(el)
  return el
}
