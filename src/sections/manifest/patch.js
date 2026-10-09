/**
 * Procedural mission patches.
 *
 * Every mission in the manifest gets an embroidered-badge style patch that is
 * generated from its data alone (number, name, status, optional motif), so a
 * new mission added to the HTML arrives with a patch of its own:
 *
 *   - a merrowed (satin-stitched) border and a double ring;
 *   - the mission name and number set on circular text paths;
 *   - a twill-textured field with seeded stars and an orbit / trajectory;
 *   - one of several motifs, plus an accent hue, both derived from a hash of
 *     the mission data (`data-motif` in the HTML can pin the motif).
 *
 * Patches are plain SVG markup (no CSS variables) so they can also be
 * exported as standalone PNG "collectibles" — see `patchToPNG()`.
 */
import { seededRandom, hashString } from '../../lib/dom.js'

const SVG_NS = 'http://www.w3.org/2000/svg'
const FONT = "'Saira Variable', 'Saira', 'Arial Narrow', sans-serif"

/** Motifs in hash order. Pinned per mission with data-motif="…". */
export const MOTIFS = ['sunrise', 'plume', 'arc', 'orbit', 'network', 'comet']

// Geometry (viewBox is centred on 0,0)
const R_EDGE = 119 // merrowed edge
const R_BAND = 110 // outer ring of the text band
const R_FIELD = 84 // inner ring / field

const f = (n) => Math.round(n * 100) / 100
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const hsl = (h, s, l, a = 1) => (a === 1 ? `hsl(${f(h)} ${f(s)}% ${f(l)}%)` : `hsl(${f(h)} ${f(s)}% ${f(l)}% / ${a})`)

/** Stable seed for a mission. */
export const patchSeed = (mission) => hashString(`${mission.number}·${mission.name}`.toUpperCase())

/** Picks the motif: explicit data wins, otherwise the hash decides. */
export function patchMotif(mission) {
  if (MOTIFS.includes(mission.motif)) return mission.motif
  return MOTIFS[patchSeed(mission) % MOTIFS.length]
}

/**
 * Resolves motifs for a whole manifest so neighbouring missions never share
 * one (a hash collision steps to the next free motif). Mutates `motif`.
 */
export function assignMotifs(missions) {
  missions.forEach((mission, i) => {
    let motif = patchMotif(mission)
    const prev = missions[i - 1]?.motif
    if (!MOTIFS.includes(mission.motif) && motif === prev) motif = MOTIFS[(MOTIFS.indexOf(motif) + 1) % MOTIFS.length]
    mission.motif = motif
  })
  return missions
}

/**
 * Thread colours. Hue comes from the hash but stays inside the site's
 * atmospheric band (cyan → indigo); the mission in progress is stitched in
 * ignition orange, flown missions get a silver border.
 */
export function patchPalette(mission) {
  const seed = patchSeed(mission)
  const active = mission.status === 'active'
  const tbd = mission.status === 'tbd'
  const hue = active ? 222 : 188 + (seed % 61)
  const sat = tbd ? 34 : 62

  const pal = {
    hue,
    thread: '#eef3fa',
    threadDim: hsl(hue, 22, 78),
    ink: hsl(hue, 60, 4),
    field0: hsl(hue, sat, 17),
    field1: hsl(hue, sat + 6, 5),
    band: hsl(hue, 42, 6.5),
    accent: hsl(hue, tbd ? 45 : 88, 68),
    accent2: hsl(hue + 14, tbd ? 30 : 74, 50),
    glow: hsl(hue, 100, 76),
    edge: hsl(hue, 30, 13),
    stitch: hsl(hue, 26, 36),
    flame: '#ff6b2c',
    flameSoft: '#ffb46b',
  }

  if (active) {
    Object.assign(pal, {
      accent: '#ff8a4c',
      accent2: '#ff6b2c',
      glow: '#ffb46b',
      edge: '#3b1407',
      stitch: '#ff7a3d',
    })
  } else if (mission.status === 'complete') {
    Object.assign(pal, { edge: '#2a3240', stitch: '#c3cddb' })
  } else if (tbd) {
    Object.assign(pal, { edge: '#191d26', stitch: '#5d6676' })
  }
  return pal
}

/**
 * Returns the patch as an SVG markup string.
 * @param {{number:string, name:string, status:string, motif?:string}} mission
 * @param {{title?:string}} [opts] accessible title (omit for decorative use)
 */
export function createPatchMarkup(mission, { title } = {}) {
  const seed = patchSeed(mission)
  const rand = seededRandom(seed)
  const pal = patchPalette(mission)
  const motif = patchMotif(mission)
  const id = `mp${String(mission.number).replace(/[^a-z0-9]/gi, '')}-${(seed % 46656).toString(36)}`

  const defs = `
    <defs>
      <radialGradient id="${id}-field" cx="0" cy="-30" r="118" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="${pal.field0}"/>
        <stop offset="1" stop-color="${pal.field1}"/>
      </radialGradient>
      <radialGradient id="${id}-edge" cx="-30" cy="-40" r="170" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#ffffff" stop-opacity=".16"/>
        <stop offset=".6" stop-color="#ffffff" stop-opacity="0"/>
      </radialGradient>
      <pattern id="${id}-twill" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(38)">
        <line x1="0" y1="0" x2="0" y2="3" stroke="#ffffff" stroke-opacity=".055" stroke-width="1.1"/>
      </pattern>
      <pattern id="${id}-twill2" width="2.6" height="2.6" patternUnits="userSpaceOnUse" patternTransform="rotate(-52)">
        <line x1="0" y1="0" x2="0" y2="2.6" stroke="#ffffff" stroke-opacity=".05" stroke-width=".9"/>
      </pattern>
      <clipPath id="${id}-clip"><circle r="${R_FIELD}"/></clipPath>
      <path id="${id}-top" d="M ${-93} 0 A 93 93 0 0 1 93 0"/>
      <path id="${id}-bottom" d="M ${-101.5} 0 A 101.5 101.5 0 0 0 101.5 0"/>
      ${motifDefs(motif, id, pal)}
    </defs>`

  // ---- Border: merrowed edge, satin stitches, double ring ---------------
  const border = `
    <circle r="${R_EDGE}" fill="${pal.edge}"/>
    <circle r="${R_EDGE - 4.5}" fill="none" stroke="${pal.stitch}" stroke-width="8" stroke-dasharray="1.15 1.05" opacity=".95"/>
    <circle r="${R_EDGE - 4.5}" fill="none" stroke="#000" stroke-width="8" stroke-dasharray=".35 1.85" stroke-dashoffset=".5" opacity=".35"/>
    <circle r="${R_BAND}" fill="${pal.band}"/>
    <circle r="${R_BAND}" fill="url(#${id}-twill2)"/>
    <circle r="${R_BAND - 1}" fill="none" stroke="${pal.thread}" stroke-width="1.7"/>
    <circle r="${R_FIELD + 2.6}" fill="none" stroke="${pal.thread}" stroke-width="1.7"/>`

  // ---- Lettering -----------------------------------------------------------
  const name = mission.name.toUpperCase()
  const topSize = name.length > 12 ? 13 : name.length > 9 ? 14.5 : 16
  // Short names spread a little around the arc (not so far that the letters
  // drift apart); long ones get tighter tracking.
  const topLength = Math.min(250, Math.max(96, name.length * topSize * 1.02))
  const bottom = `SXSI · MISSION ${mission.number}`
  // Relief: each line is stitched twice — a dark offset copy below the thread
  // (an SVG filter would be cheaper to write, but filtered groups don't follow
  // animated CSS transforms reliably in Chromium).
  const words = (fill, stroke, dy) => `
    <g transform="translate(0 ${dy})" font-family="${FONT}" font-weight="650" fill="${fill}" stroke="${stroke}" stroke-width="1.6" paint-order="stroke" style="font-stretch:125%">
      <text font-size="${topSize}" text-anchor="middle">
        <textPath href="#${id}-top" startOffset="50%" textLength="${f(topLength)}" lengthAdjust="spacing">${esc(name)}</textPath>
      </text>
      <text font-size="10.2" text-anchor="middle"${dy ? '' : ` fill="${pal.threadDim}"`}>
        <textPath href="#${id}-bottom" startOffset="50%" textLength="150" lengthAdjust="spacing">${esc(bottom)}</textPath>
      </text>
    </g>`
  const lettering = `
    ${words('#000', '#000', 1.1).replace('<g ', '<g opacity=".55" ')}
    ${words(pal.thread, pal.ink, 0)}
    ${starShape(-98, -1.5, 5.2, pal.accent, 0)}
    ${starShape(98, -1.5, 5.2, pal.accent, 0)}`

  // ---- Field ---------------------------------------------------------------
  const field = `
    <g clip-path="url(#${id}-clip)">
      <circle r="${R_FIELD + 1}" fill="url(#${id}-field)"/>
      <circle r="${R_FIELD + 1}" fill="url(#${id}-twill)"/>
      ${stars(rand, pal, motif === 'network' ? 26 : 18)}
      ${trajectory(rand, pal, motif)}
      ${MOTIF_FN[motif](rand, pal, id)}
    </g>
    <circle r="${R_FIELD}" fill="none" stroke="${pal.ink}" stroke-width="1.2" opacity=".8"/>`

  // ---- Light: a soft top-left sheen baked into the threads ----------------
  const light = `<circle r="${R_EDGE}" fill="url(#${id}-edge)" style="mix-blend-mode:screen"/>`

  const label = title ? `<title>${esc(title)}</title>` : ''
  const a11y = title ? 'role="img"' : 'aria-hidden="true" focusable="false"'
  return `<svg xmlns="${SVG_NS}" class="s-manifest__patch-svg" viewBox="-120 -120 240 240" ${a11y} data-motif="${motif}">${label}${defs}${border}${field}${lettering}${light}</svg>`
}

/* ==========================================================================
 * Shared pieces
 * ======================================================================== */

/** n-pointed star centred on x,y. */
function starShape(x, y, r, fill, rot = 0, points = 5, inner = 0.45) {
  let d = ''
  for (let i = 0; i < points * 2; i++) {
    const a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2 + rot
    const rr = i % 2 ? r * inner : r
    d += `${i ? 'L' : 'M'}${f(x + Math.cos(a) * rr)} ${f(y + Math.sin(a) * rr)}`
  }
  return `<path d="${d}Z" fill="${fill}"/>`
}

/** Four-point sparkle. */
function sparkle(x, y, r, fill) {
  const k = r * 0.18
  return `<path d="M${f(x)} ${f(y - r)} L${f(x + k)} ${f(y - k)} L${f(x + r)} ${f(y)} L${f(x + k)} ${f(y + k)} L${f(x)} ${f(y + r)} L${f(x - k)} ${f(y + k)} L${f(x - r)} ${f(y)} L${f(x - k)} ${f(y - k)}Z" fill="${fill}"/>`
}

function stars(rand, pal, count) {
  let out = ''
  for (let i = 0; i < count; i++) {
    const a = rand() * Math.PI * 2
    const d = Math.sqrt(rand()) * (R_FIELD - 6)
    const x = Math.cos(a) * d
    const y = Math.sin(a) * d
    const r = 0.45 + rand() * rand() * 1.3
    out += `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="${pal.thread}" opacity="${f(0.45 + rand() * 0.55)}"/>`
  }
  for (let i = 0; i < 3; i++) {
    const a = rand() * Math.PI * 2
    const d = 22 + rand() * 50
    out += sparkle(Math.cos(a) * d, Math.sin(a) * d, 3 + rand() * 3.5, i === 0 ? pal.glow : pal.thread)
  }
  return out
}

/** The orbit / trajectory common to every patch: a tilted, partly dashed ellipse. */
function trajectory(rand, pal, motif) {
  if (motif === 'orbit') return '' // that motif is all orbits
  const rx = 70 + rand() * 30
  const ry = 13 + rand() * 13
  const rot = -38 + rand() * 76
  const cy = -6 + rand() * 20
  const node = rand() * Math.PI * 2
  const nx = Math.cos(node) * rx
  const ny = Math.sin(node) * ry
  return `
    <g transform="translate(0 ${f(cy)}) rotate(${f(rot)})" fill="none" stroke-linecap="round">
      <ellipse rx="${f(rx)}" ry="${f(ry)}" stroke="${pal.accent}" stroke-width="1" opacity=".38" stroke-dasharray="1.5 3.5"/>
      <path d="M ${f(-rx)} 0 A ${f(rx)} ${f(ry)} 0 0 0 ${f(rx)} 0" stroke="${pal.accent}" stroke-width="1.5" opacity=".75"/>
      <circle cx="${f(nx)}" cy="${f(ny)}" r="2.2" fill="${pal.thread}" stroke="none"/>
    </g>`
}

/* ==========================================================================
 * Motifs — each draws inside the clipped field (radius 84)
 * ======================================================================== */

function motifDefs(motif, id, pal) {
  if (motif === 'plume' || motif === 'comet') {
    return `
      <radialGradient id="${id}-puff" cx=".38" cy=".3" r=".75">
        <stop offset="0" stop-color="${hsl(pal.hue, 18, 88)}"/>
        <stop offset=".6" stop-color="${hsl(pal.hue, 14, 58)}"/>
        <stop offset="1" stop-color="${hsl(pal.hue, 20, 30)}"/>
      </radialGradient>
      <linearGradient id="${id}-flame" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#ffffff"/>
        <stop offset=".22" stop-color="${pal.flameSoft}"/>
        <stop offset=".7" stop-color="${pal.flame}"/>
        <stop offset="1" stop-color="${pal.flame}" stop-opacity="0"/>
      </linearGradient>`
  }
  if (motif === 'orbit') {
    return `
      <radialGradient id="${id}-planet" cx="-10" cy="-8" r="34" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="${pal.accent}"/>
        <stop offset=".55" stop-color="${pal.accent2}"/>
        <stop offset="1" stop-color="${pal.field1}"/>
      </radialGradient>`
  }
  return `
    <radialGradient id="${id}-planet" cx="0" cy="-40" r="140" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${pal.accent2}" stop-opacity=".9"/>
      <stop offset=".35" stop-color="${pal.field0}"/>
      <stop offset="1" stop-color="${pal.ink}"/>
    </radialGradient>`
}

/** A planet's limb seen from orbit; returns markup + the limb geometry. */
function limb(pal, id, cx, cy, r) {
  return `
    <circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r)}" fill="url(#${id}-planet)"/>
    <circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r + 2)}" fill="none" stroke="${pal.glow}" stroke-width="5" opacity=".22"/>
    <circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r)}" fill="none" stroke="${pal.accent}" stroke-width="1.6"/>`
}

const MOTIF_FN = {
  /** FIRST LIGHT — the sun breaking over a planet's limb, city lights below. */
  sunrise(rand, pal, id) {
    const R = 112
    const cy = 30 + R + rand() * 6
    const sx = -18 + rand() * 36
    const sy = cy - Math.sqrt(R * R - sx * sx) - 1
    let rays = ''
    const n = 12 + Math.floor(rand() * 8)
    for (let i = 0; i < n; i++) {
      const a = Math.PI + (i / (n - 1)) * Math.PI
      const len = (i % 2 ? 16 : 30) + rand() * 22
      rays += `<line x1="${f(sx + Math.cos(a) * 11)}" y1="${f(sy + Math.sin(a) * 11)}" x2="${f(sx + Math.cos(a) * (11 + len))}" y2="${f(sy + Math.sin(a) * (11 + len))}"/>`
    }
    let lights = ''
    for (let i = 0; i < 16; i++) {
      const x = -70 + rand() * 140
      const top = cy - Math.sqrt(Math.max(0, R * R - x * x))
      const y = top + 8 + rand() * 40
      lights += `<circle cx="${f(x)}" cy="${f(y)}" r="${f(0.6 + rand() * 0.9)}"/>`
    }
    return `
      ${limb(pal, id, 0, cy, R)}
      <g fill="${pal.flameSoft}" opacity=".7">${lights}</g>
      <g stroke="${pal.thread}" stroke-width="1.2" stroke-linecap="round" opacity=".85">${rays}</g>
      <ellipse cx="${f(sx)}" cy="${f(sy)}" rx="62" ry="1.6" fill="${pal.thread}" opacity=".85"/>
      <circle cx="${f(sx)}" cy="${f(sy)}" r="14" fill="${pal.glow}" opacity=".3"/>
      <circle cx="${f(sx)}" cy="${f(sy)}" r="7.5" fill="#ffffff"/>`
  },

  /** IGNITION — an original launch vehicle lifting off its tower on a plume. */
  plume(rand, pal, id) {
    const tilt = -5 + rand() * 10
    const side = rand() < 0.5 ? -1 : 1
    let smoke = ''
    for (let i = 0; i < 13; i++) {
      const x = -78 + rand() * 156
      const y = 66 + rand() * 18 - Math.max(0, 30 - Math.abs(x)) * 0.25
      const r = 9 + rand() * 15
      smoke += `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="url(#${id}-puff)" opacity="${f(0.55 + rand() * 0.4)}"/>`
    }
    // Lattice tower beside the vehicle
    const tx = side * 27
    let lattice = ''
    for (let y = -34; y < 62; y += 9) lattice += `M${tx - 4} ${y} L${tx + 4} ${y + 9} M${tx + 4} ${y} L${tx - 4} ${y + 9}`
    return `
      <g stroke="${pal.threadDim}" stroke-width=".9" fill="none" opacity=".8">
        <path d="M${tx - 4} -36 V 70 M${tx + 4} -36 V 70"/>
        <path d="${lattice}" opacity=".6"/>
        <path d="M${tx - side * 4} -22 H ${side * 7}" stroke-width="1.6"/>
      </g>
      <g transform="rotate(${f(tilt)} 0 30)">
        <ellipse cx="0" cy="44" rx="18" ry="34" fill="${pal.flameSoft}" opacity=".16"/>
        <path d="M-8.5 16 C -12 40 -6 58 0 84 C 6 58 12 40 8.5 16 Z" fill="url(#${id}-flame)"/>
        <path d="M-4 16 C -5 30 -2 40 0 52 C 2 40 5 30 4 16 Z" fill="#ffffff" opacity=".9"/>
        <path d="M-7 14 L-12.5 24 L-12.5 27 L-7 22 Z M7 14 L12.5 24 L12.5 27 L7 22 Z" fill="${pal.threadDim}"/>
        <path d="M-7 18 V -30 C -7 -44 -2 -52 0 -57 C 2 -52 7 -44 7 -30 V 18 Z" fill="${pal.thread}"/>
        <path d="M0 -57 C 2 -52 7 -44 7 -30 V 18 H 1.5 V -30 Z" fill="${hsl(pal.hue, 18, 70)}" opacity=".55"/>
        <path d="M-7 -12 H 7 M-7 -16 H 7" stroke="${pal.accent2}" stroke-width="1.5"/>
        <path d="M-5 18 H 5 L 6.5 22 H -6.5 Z" fill="${pal.threadDim}"/>
      </g>
      ${smoke}`
  },

  /** ASCENT — a trajectory climbing off the limb, event ticks along the way. */
  arc(rand, pal, id) {
    const cx = -42 + rand() * 16
    const R = 128
    const cy = 52 + R
    const sx = cx + 26
    const sy = cy - Math.sqrt(R * R - 26 * 26)
    const ex = 46 + rand() * 18
    const ey = -48 + rand() * 12
    const c1x = sx + 6
    const c1y = sy - 60
    const c2x = ex - 50
    const c2y = ey + 10
    const path = `M${f(sx)} ${f(sy)} C ${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(ex)} ${f(ey)}`
    // Ticks: sample the cubic
    const at = (t) => {
      const u = 1 - t
      const x = u * u * u * sx + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * ex
      const y = u * u * u * sy + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ey
      return [x, y]
    }
    let ticks = ''
    for (const t of [0.22, 0.45, 0.68]) {
      const [x, y] = at(t)
      const [x2, y2] = at(t + 0.01)
      const a = Math.atan2(y2 - y, x2 - x) + Math.PI / 2
      ticks += `<line x1="${f(x - Math.cos(a) * 4)}" y1="${f(y - Math.sin(a) * 4)}" x2="${f(x + Math.cos(a) * 4)}" y2="${f(y + Math.sin(a) * 4)}"/>`
    }
    const [px, py] = at(0.985)
    const heading = Math.atan2(ey - py, ex - px) * (180 / Math.PI)
    return `
      ${limb(pal, id, cx, cy, R)}
      <path d="M-84 ${f(-2 + rand() * 6)} H 84" stroke="${pal.threadDim}" stroke-width=".8" stroke-dasharray="3 3" opacity=".45"/>
      <path d="${path}" fill="none" stroke="${pal.glow}" stroke-width="5" opacity=".18" stroke-linecap="round"/>
      <path d="${path}" fill="none" stroke="${pal.thread}" stroke-width="1.8" stroke-linecap="round"/>
      <g stroke="${pal.accent}" stroke-width="1.4" stroke-linecap="round">${ticks}</g>
      <g transform="translate(${f(ex)} ${f(ey)}) rotate(${f(heading)})">
        <path d="M-3 0 L -16 -3.5 L -16 3.5 Z" fill="${pal.flameSoft}" opacity=".9"/>
        <path d="M7 0 L -4 -5 L -1.5 0 L -4 5 Z" fill="${pal.thread}"/>
      </g>
      <circle cx="${f(sx)}" cy="${f(sy)}" r="2.6" fill="${pal.thread}"/>`
  },

  /** ORBIT — a world ringed by tilted orbits, the fleet stationed on them. */
  orbit(rand, pal, id) {
    const pr = 23 + rand() * 6
    let back = ''
    let front = ''
    let sats = ''
    const satPts = []
    const count = 3
    for (let i = 0; i < count; i++) {
      const rx = 44 + i * 13 + rand() * 6
      const ry = 10 + rand() * 12
      const rot = -34 + (i / (count - 1)) * 58 + (rand() - 0.5) * 12
      const g = `transform="rotate(${f(rot)})"`
      back += `<path ${g} d="M ${f(-rx)} 0 A ${f(rx)} ${f(ry)} 0 0 1 ${f(rx)} 0"/>`
      front += `<path ${g} d="M ${f(-rx)} 0 A ${f(rx)} ${f(ry)} 0 0 0 ${f(rx)} 0"/>`
      // satellite on the near half of the orbit
      const a = 0.25 * Math.PI + rand() * 0.5 * Math.PI
      const lx = Math.cos(a) * rx * (rand() < 0.5 ? -1 : 1)
      const ly = Math.sin(a) * ry
      const r = (rot * Math.PI) / 180
      const x = lx * Math.cos(r) - ly * Math.sin(r)
      const y = lx * Math.sin(r) + ly * Math.cos(r)
      satPts.push([x, y])
      sats += `<g transform="translate(${f(x)} ${f(y)}) rotate(45)"><rect x="-3" y="-3" width="6" height="6" fill="${pal.thread}"/></g><circle cx="${f(x)}" cy="${f(y)}" r="7" fill="${pal.glow}" opacity=".2"/>`
    }
    const links = satPts.map(([x, y], i) => {
      const [x2, y2] = satPts[(i + 1) % satPts.length]
      return `<line x1="${f(x)}" y1="${f(y)}" x2="${f(x2)}" y2="${f(y2)}"/>`
    }).join('')
    return `
      <g fill="none" stroke="${pal.accent}" stroke-width="1.3" opacity=".55">${back}</g>
      <circle r="${f(pr + 3)}" fill="${pal.glow}" opacity=".16"/>
      <circle r="${f(pr)}" fill="url(#${id}-planet)"/>
      <path d="M ${f(-pr)} 0 A ${f(pr)} ${f(pr)} 0 0 0 ${f(pr)} 0 A ${f(pr * 1.15)} ${f(pr * 0.7)} 0 0 1 ${f(-pr)} 0" fill="${pal.ink}" opacity=".45" transform="rotate(-28)"/>
      <circle r="${f(pr)}" fill="none" stroke="${pal.thread}" stroke-width="1.3" opacity=".9"/>
      <g fill="none" stroke="${pal.thread}" stroke-width="1.5">${front}</g>
      <g stroke="${pal.accent}" stroke-width=".8" stroke-dasharray="2 2.5" opacity=".7">${links}</g>
      ${sats}`
  },

  /** BEYOND — a constellation of nodes (intelligence as a network of light) around a bright star. */
  network(rand, pal) {
    const pts = []
    const count = 10 + Math.floor(rand() * 4)
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + rand() * 0.5
      const d = 26 + rand() * 46
      pts.push([Math.cos(a) * d, Math.sin(a) * d * 0.86 - 4])
    }
    const seen = new Set()
    let lines = ''
    pts.forEach(([x, y], i) => {
      const near = pts
        .map(([x2, y2], j) => ({ j, d: (x2 - x) ** 2 + (y2 - y) ** 2 }))
        .filter((p) => p.j !== i)
        .sort((a, b) => a.d - b.d)
        .slice(0, 2)
      for (const { j } of near) {
        const key = i < j ? `${i}-${j}` : `${j}-${i}`
        if (seen.has(key)) continue
        seen.add(key)
        lines += `<line x1="${f(x)}" y1="${f(y)}" x2="${f(pts[j][0])}" y2="${f(pts[j][1])}"/>`
      }
    })
    // spokes from the central star to a few nodes
    const cx = -6 + rand() * 12
    const cy = -10 + rand() * 10
    let spokes = ''
    for (let i = 0; i < pts.length; i += 3) spokes += `<line x1="${f(cx)}" y1="${f(cy)}" x2="${f(pts[i][0])}" y2="${f(pts[i][1])}"/>`
    const nodes = pts
      .map(([x, y], i) => `<circle cx="${f(x)}" cy="${f(y)}" r="${i % 3 ? 1.7 : 2.6}" fill="${i % 3 ? pal.threadDim : pal.thread}"/>`)
      .join('')
    return `
      <ellipse cx="${f(cx)}" cy="${f(cy)}" rx="70" ry="18" fill="${pal.accent2}" opacity=".12" transform="rotate(-24 ${f(cx)} ${f(cy)})"/>
      <g stroke="${pal.accent}" stroke-width="1" opacity=".7">${lines}</g>
      <g stroke="${pal.glow}" stroke-width=".7" stroke-dasharray="1.5 2.5" opacity=".55">${spokes}</g>
      ${nodes}
      <circle cx="${f(cx)}" cy="${f(cy)}" r="16" fill="${pal.glow}" opacity=".22"/>
      ${starShape(cx, cy, 15, pal.thread, 0, 4, 0.16)}
      ${starShape(cx, cy, 8, pal.thread, Math.PI / 4, 4, 0.22)}
      <circle cx="${f(cx)}" cy="${f(cy)}" r="3" fill="#ffffff"/>`
  },

  /** Fallback for future missions — a comet / ascending chevron. */
  comet(rand, pal, id) {
    const a = (-40 - rand() * 30) * (Math.PI / 180)
    const len = 120
    const hx = Math.cos(a) * 30
    const hy = Math.sin(a) * 30
    const tx = hx - Math.cos(a) * len
    const ty = hy - Math.sin(a) * len
    let streaks = ''
    for (let i = -2; i <= 2; i++) {
      const o = i * 4.5
      const nx = -Math.sin(a) * o
      const ny = Math.cos(a) * o
      streaks += `<line x1="${f(hx + nx * 0.4)}" y1="${f(hy + ny * 0.4)}" x2="${f(tx + nx)}" y2="${f(ty + ny)}" opacity="${f(1 - Math.abs(i) * 0.3)}"/>`
    }
    return `
      <g stroke="${pal.accent}" stroke-width="1.3" stroke-linecap="round">${streaks}</g>
      <circle cx="${f(hx)}" cy="${f(hy)}" r="14" fill="${pal.glow}" opacity=".25"/>
      <circle cx="${f(hx)}" cy="${f(hy)}" r="6" fill="#ffffff"/>
      <path d="M-40 60 L 0 34 L 40 60" fill="none" stroke="${pal.thread}" stroke-width="2.2" stroke-linejoin="round"/>
      <path d="M-28 70 L 0 52 L 28 70" fill="none" stroke="url(#${id}-flame)" stroke-width="1.6" opacity=".8"/>`
  },
}

/* ==========================================================================
 * Export — a standalone PNG with the display face embedded
 * ======================================================================== */

let fontCSS
async function embeddedFontCSS() {
  if (fontCSS !== undefined) return fontCSS
  try {
    const { default: url } = await import('@fontsource-variable/saira/files/saira-latin-standard-normal.woff2?url')
    const buf = await (await fetch(url)).arrayBuffer()
    let bin = ''
    const bytes = new Uint8Array(buf)
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
    fontCSS = `@font-face{font-family:'Saira Variable';font-weight:100 900;font-stretch:50% 125%;src:url(data:font/woff2;base64,${btoa(bin)}) format('woff2')}`
  } catch {
    fontCSS = ''
  }
  return fontCSS
}

/**
 * Renders patch markup to a PNG blob (transparent background).
 * Falls back to an SVG blob if the canvas route fails.
 */
export async function patchToBlob(markup, size = 1200) {
  const css = await embeddedFontCSS()
  const svg = markup
    .replace('<svg ', `<svg width="${size}" height="${size}" `)
    .replace(/(<svg[^>]*>)/, `$1<style>${css}</style>`)
  const svgBlob = new Blob([svg], { type: 'image/svg+xml' })
  const url = URL.createObjectURL(svgBlob)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    // Give an embedded web font a beat to apply inside the SVG image.
    await new Promise((resolve) => setTimeout(resolve, 60))
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = size
    canvas.getContext('2d').drawImage(img, 0, 0, size, size)
    const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (png) return { blob: png, ext: 'png' }
  } catch {
    /* fall through to SVG */
  } finally {
    URL.revokeObjectURL(url)
  }
  return { blob: svgBlob, ext: 'svg' }
}
