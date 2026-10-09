/**
 * The SXSI wordmark — one source of truth for JS-rendered copies (boot).
 * Static copies are inlined in nav.html / footer.html; public/logo.svg is the
 * standalone file. Geometry: wide squared S whose terminals are cut parallel
 * to the X; the X is two straight crossing trajectories, one passing behind
 * the other (the gap), with no stroke extending beyond the letter.
 */
export const LOGO_VIEWBOX = '0 0 211.2 40'

export const LOGO_PATH =
  'M60,0H11.5A11.5,11.5 0 0 0 0,11.5V11.6A11.5,11.5 0 0 0 11.5,23.1H48.5A5.3,5.3 0 0 1 53.8,28.4V28.5A5.3,5.3 0 0 1 48.5,33.8H6.79L0,40H48.5A11.5,11.5 0 0 0 60,28.5V28.4A11.5,11.5 0 0 0 48.5,16.9H11.5A5.3,5.3 0 0 1 6.2,11.6V11.5A5.3,5.3 0 0 1 11.5,6.2H53.21L60,0Z' +
  'M69.5,0L79.7,0L123.5,40L113.3,40ZM113.3,0L123.5,0L102.9,18.81L97.8,14.15ZM90.1,21.19L95.2,25.84L79.7,40L69.5,40Z' +
  'M193,0H144.5A11.5,11.5 0 0 0 133,11.5V11.6A11.5,11.5 0 0 0 144.5,23.1H181.5A5.3,5.3 0 0 1 186.8,28.4V28.5A5.3,5.3 0 0 1 181.5,33.8H139.79L133,40H181.5A11.5,11.5 0 0 0 193,28.5V28.4A11.5,11.5 0 0 0 181.5,16.9H144.5A5.3,5.3 0 0 1 139.2,11.6V11.5A5.3,5.3 0 0 1 144.5,6.2H186.21L193,0Z' +
  'M205,0H211.2V40H205Z'

/** Decorative inline SVG markup (fill: currentColor). */
export function logoSvg(className = '') {
  return `<svg class="${className}" viewBox="${LOGO_VIEWBOX}" fill="currentColor" aria-hidden="true" focusable="false"><path d="${LOGO_PATH}"/></svg>`
}
