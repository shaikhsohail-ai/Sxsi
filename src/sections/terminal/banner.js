/**
 * Boot banner: turns the ASCII / box-drawing SXSI mark in the static <pre>
 * into a crisp SVG.
 *
 * Why: the web font only ships Latin glyphs, so box-drawing characters fall
 * back to whatever monospace the OS has — and their advance widths differ
 * (Consolas ≠ Menlo ≠ DejaVu), which skews the art. Drawing each character
 * cell as vector geometry keeps the mark perfectly aligned at any width,
 * while the <pre> stays in the HTML as the no-JS rendition.
 *
 *   █        → solid block (the letterform)
 *   ═ ║ ╔ ╗ ╚ ╝ → double-line "shadow" strokes
 */
const NS = 'http://www.w3.org/2000/svg'

// Cell geometry in SVG units (≈ a monospace cell at line-height 1.1).
const CW = 6
const CH = 11
// Double-line rails, as fractions of the cell.
const X1 = CW * 0.3
const X2 = CW * 0.7
const Y1 = CH * 0.36
const Y2 = CH * 0.64

/** Polylines for each double-line glyph, cell-local coordinates. */
const STROKES = {
  '═': [[[0, Y1], [CW, Y1]], [[0, Y2], [CW, Y2]]],
  '║': [[[X1, 0], [X1, CH]], [[X2, 0], [X2, CH]]],
  '╗': [[[0, Y1], [X2, Y1], [X2, CH]], [[0, Y2], [X1, Y2], [X1, CH]]],
  '╔': [[[CW, Y1], [X1, Y1], [X1, CH]], [[CW, Y2], [X2, Y2], [X2, CH]]],
  '╝': [[[0, Y2], [X2, Y2], [X2, 0]], [[0, Y1], [X1, Y1], [X1, 0]]],
  '╚': [[[CW, Y2], [X1, Y2], [X1, 0]], [[CW, Y1], [X2, Y1], [X2, 0]]],
}

const r = (n) => Math.round(n * 100) / 100

/**
 * Builds the SVG for `ascii` and swaps it in for `pre`.
 * Returns { svg, cols, rows } (or null if there's nothing to draw).
 */
export function renderBanner(pre) {
  if (!pre) return null
  const rows = pre.textContent.replace(/^\n+|\s+$/g, '').split('\n')
  const cols = Math.max(...rows.map((row) => [...row].length))
  if (!cols) return null

  let blocks = ''
  let strokes = ''

  rows.forEach((row, y) => {
    const chars = [...row]
    let runStart = -1
    // Merge horizontal runs of █ into single rects (fewer seams, smaller path).
    for (let x = 0; x <= chars.length; x++) {
      const isBlock = chars[x] === '█'
      if (isBlock && runStart < 0) runStart = x
      if (!isBlock && runStart >= 0) {
        // Tiny overlap hides anti-aliasing seams between stacked rows.
        blocks += `M${runStart * CW} ${y * CH}h${(x - runStart) * CW}v${CH + 0.2}h${-(x - runStart) * CW}z`
        runStart = -1
      }
      const lines = STROKES[chars[x]]
      if (lines) {
        for (const line of lines) {
          strokes += line.map(([px, py], i) => `${i ? 'L' : 'M'}${r(x * CW + px)} ${r(y * CH + py)}`).join('')
        }
      }
    }
  })

  const width = cols * CW
  const height = rows.length * CH
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('class', 't-banner__svg')
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  svg.innerHTML = `
    <defs>
      <linearGradient id="terminal-banner-fill" x1="0" y1="0" x2="0" y2="${height}" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#ffffff" />
        <stop offset=".55" stop-color="#dff2ff" />
        <stop offset="1" stop-color="#6fc3ff" />
      </linearGradient>
      <pattern id="terminal-banner-scan" width="4" height="1.5" patternUnits="userSpaceOnUse">
        <rect width="4" height=".42" fill="#000" opacity=".16" />
      </pattern>
      <linearGradient id="terminal-banner-sheen" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#fff" stop-opacity="0" />
        <stop offset=".5" stop-color="#fff" stop-opacity=".95" />
        <stop offset="1" stop-color="#fff" stop-opacity="0" />
      </linearGradient>
      <clipPath id="terminal-banner-clip"><path d="${blocks}" /></clipPath>
    </defs>
    <path class="t-banner__shadow" d="${strokes}" />
    <path class="t-banner__blocks" d="${blocks}" fill="url(#terminal-banner-fill)" />
    <path class="t-banner__scan" d="${blocks}" fill="url(#terminal-banner-scan)" />
    <g clip-path="url(#terminal-banner-clip)">
      <rect class="t-banner__sheen" x="${-width * 0.3}" y="0" width="${width * 0.22}" height="${height}" fill="url(#terminal-banner-sheen)" />
    </g>`
  // NOTE: innerHTML above contains only geometry derived from our own static
  // markup — never visitor input.

  pre.replaceWith(svg)
  return { svg, cols, rows: rows.length }
}

let clones = 0
/** A copy of the banner with its own gradient / pattern ids (safe to print). */
export function cloneBanner(svg) {
  const copy = svg.cloneNode(true)
  const suffix = `-${++clones}`
  copy.querySelectorAll('[id]').forEach((node) => (node.id += suffix))
  for (const attr of ['fill', 'clip-path']) {
    copy.querySelectorAll(`[${attr}^="url(#"]`).forEach((node) => {
      node.setAttribute(attr, node.getAttribute(attr).replace(/\)$/, `${suffix})`))
    })
  }
  copy.style.removeProperty('clip-path')
  return copy
}
