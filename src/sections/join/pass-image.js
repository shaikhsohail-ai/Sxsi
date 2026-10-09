/**
 * Renders a passenger's boarding pass as a 1200×630 share image (the size
 * social networks use for link cards): the pass floating above an orbital
 * sunrise, printed with the same seeded rosette and matrix code as the live
 * card. Loaded on demand when someone downloads or shares their pass.
 */
import { seededRandom } from '../../lib/dom.js'
import { LOGO_PATH } from '../nav/logo.js'
import { guillochePath, matrixCodePath } from './pass-data.js'

const W = 1200
const H = 630

const DISPLAY = '"Saira Variable", "Saira", "Arial Narrow", sans-serif'
const MONO = '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace'

const C = {
  text: '#f4f6fb',
  dim: 'rgba(244, 246, 251, 0.68)',
  label: 'rgba(244, 246, 251, 0.62)',
  fine: 'rgba(244, 246, 251, 0.74)',
  line: 'rgba(255, 255, 255, 0.13)',
  atmo: '#6fc3ff',
  ion: '#c7ecff',
  ignite: '#ff6b2c',
}

/** Waits for the faces we draw with (they're already on the page). */
async function loadFonts() {
  if (!document.fonts?.load) return
  const faces = [`700 64px ${DISPLAY}`, `650 40px ${DISPLAY}`, `500 12px ${MONO}`]
  await Promise.all(faces.map((face) => document.fonts.load(face).catch(() => null)))
}

/** Sets a font; `stretch` is a CSS keyword where canvas supports it. */
function setFont(ctx, { family = DISPLAY, size = 16, weight = 600, stretch = 'normal', spacing = 0 } = {}) {
  ctx.font = `${weight} ${size}px ${family}`
  if ('fontStretch' in ctx) ctx.fontStretch = stretch
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${spacing}px`
}

/** Draws text, shrinking it to `maxWidth` when needed. Returns the drawn width. */
function text(ctx, str, x, y, opts = {}) {
  const { color = C.text, align = 'left', maxWidth } = opts
  let size = opts.size ?? 16
  setFont(ctx, { ...opts, size })
  let width = ctx.measureText(str).width
  if (maxWidth && width > maxWidth) {
    size = Math.max(8, Math.floor((size * maxWidth) / width))
    setFont(ctx, { ...opts, size })
    width = ctx.measureText(str).width
  }
  ctx.fillStyle = color
  ctx.textAlign = align
  ctx.textBaseline = 'alphabetic'
  ctx.fillText(str, x, y)
  return width
}

const label = (ctx, str, x, y, extra = {}) =>
  text(ctx, str.toUpperCase(), x, y, { family: MONO, size: 11, weight: 500, spacing: 2.4, color: C.label, ...extra })

/** Card outline with ticket notches where the stub perforation meets the edges. */
function cardPath(x, y, w, h, r, notchX, notch) {
  const p = new Path2D()
  p.moveTo(x + r, y)
  p.lineTo(notchX - notch, y)
  p.arc(notchX, y, notch, Math.PI, 0, true)
  p.lineTo(x + w - r, y)
  p.arcTo(x + w, y, x + w, y + r, r)
  p.lineTo(x + w, y + h - r)
  p.arcTo(x + w, y + h, x + w - r, y + h, r)
  p.lineTo(notchX + notch, y + h)
  p.arc(notchX, y + h, notch, 0, Math.PI, true)
  p.lineTo(x + r, y + h)
  p.arcTo(x, y + h, x, y + h - r, r)
  p.lineTo(x, y + r)
  p.arcTo(x, y, x + r, y, r)
  p.closePath()
  return p
}

function drawSky(ctx, seed) {
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, W, H)

  // Stars
  const rand = seededRandom(seed ^ 0x2545f491)
  for (let i = 0; i < 320; i++) {
    const x = rand() * W
    const y = rand() * H * 0.92
    const r = 0.35 + Math.pow(rand(), 4) * 1.1
    ctx.globalAlpha = 0.15 + Math.pow(rand(), 2) * 0.75
    ctx.fillStyle = rand() > 0.8 ? C.ion : '#fff'
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1

  // Planet + atmosphere: the limb apex sits just under the card.
  const R = 2300
  const apex = 556
  const cx = W / 2
  const cy = apex + R

  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  const atmo = ctx.createRadialGradient(cx, cy, R - 2, cx, cy, R + 170)
  atmo.addColorStop(0, 'rgba(199, 236, 255, 0.95)')
  atmo.addColorStop(0.012, 'rgba(111, 195, 255, 0.75)')
  atmo.addColorStop(0.06, 'rgba(31, 107, 255, 0.4)')
  atmo.addColorStop(0.25, 'rgba(31, 107, 255, 0.12)')
  atmo.addColorStop(1, 'rgba(31, 107, 255, 0)')
  ctx.fillStyle = atmo
  ctx.fillRect(0, 0, W, H)

  // Warm scattering around the sunrise
  const warm = ctx.createRadialGradient(cx, apex, 0, cx, apex, 420)
  warm.addColorStop(0, 'rgba(255, 196, 140, 0.7)')
  warm.addColorStop(0.18, 'rgba(255, 140, 70, 0.25)')
  warm.addColorStop(0.5, 'rgba(255, 107, 44, 0.06)')
  warm.addColorStop(1, 'rgba(255, 107, 44, 0)')
  ctx.fillStyle = warm
  ctx.fillRect(0, 0, W, H)
  ctx.restore()

  // Night side
  const planet = ctx.createRadialGradient(cx, cy, R - 70, cx, cy, R)
  planet.addColorStop(0, '#000')
  planet.addColorStop(0.75, '#020814')
  planet.addColorStop(1, '#0b2a5c')
  ctx.fillStyle = planet
  ctx.beginPath()
  ctx.arc(cx, cy, R, 0, Math.PI * 2)
  ctx.fill()

  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  // Terminator glow under the sun
  ctx.save()
  ctx.translate(cx, apex + 2)
  ctx.scale(1, 0.12)
  const term = ctx.createRadialGradient(0, 0, 0, 0, 0, 260)
  term.addColorStop(0, 'rgba(255, 150, 80, 0.75)')
  term.addColorStop(1, 'rgba(255, 107, 44, 0)')
  ctx.fillStyle = term
  ctx.fillRect(-300, -300, 600, 600)
  ctx.restore()

  // Sun
  const sun = ctx.createRadialGradient(cx, apex - 2, 0, cx, apex - 2, 120)
  sun.addColorStop(0, 'rgba(255, 255, 255, 1)')
  sun.addColorStop(0.08, 'rgba(255, 250, 240, 0.95)')
  sun.addColorStop(0.22, 'rgba(255, 210, 160, 0.45)')
  sun.addColorStop(1, 'rgba(255, 160, 90, 0)')
  ctx.fillStyle = sun
  ctx.fillRect(cx - 130, apex - 130, 260, 260)

  // Anamorphic streak along the horizon
  ctx.save()
  ctx.translate(cx, apex - 1)
  ctx.scale(1, 0.018)
  const streak = ctx.createRadialGradient(0, 0, 0, 0, 0, 620)
  streak.addColorStop(0, 'rgba(230, 244, 255, 0.95)')
  streak.addColorStop(0.35, 'rgba(111, 195, 255, 0.35)')
  streak.addColorStop(1, 'rgba(111, 195, 255, 0)')
  ctx.fillStyle = streak
  ctx.fillRect(-640, -640, 1280, 1280)
  ctx.restore()
  ctx.restore()

  // Signature on the night side
  text(ctx, 'FOR THE SKY.', cx, 606, { size: 15, weight: 700, stretch: 'expanded', spacing: 5, color: 'rgba(244, 246, 251, 0.9)', align: 'center' })
  label(ctx, 'sxsi.ai', 40, 606, { size: 13, color: C.label })
  label(ctx, 'Commemorative', W - 40, 606, { size: 13, color: C.fine, align: 'right' })
}

/** The SXSI wordmark (shared with the nav), `h` px tall with its top-left at x, y. Returns its width. */
let wordmark
function drawWordmark(ctx, x, y, h, color = C.text) {
  wordmark ||= new Path2D(LOGO_PATH)
  const s = h / 40
  ctx.save()
  ctx.translate(x, y)
  ctx.scale(s, s)
  ctx.fillStyle = color
  ctx.fill(wordmark)
  ctx.restore()
  return 211.2 * s
}

/** Everything printed on the card goes on its own layer so the foil can tint ink only. */
function drawInk(ctx, pass, box) {
  const { x, y, w, h, stubX } = box
  const left = x + 42
  const right = stubX - 40

  // Security rosette
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, stubX - x, h)
  ctx.clip()
  ctx.translate(x + (stubX - x) * 0.66, y + h * 0.5)
  ctx.scale(250, 250)
  ctx.strokeStyle = 'rgba(199, 236, 255, 0.16)'
  ctx.lineWidth = 0.6 / 250
  ctx.stroke(new Path2D(guillochePath(pass.seed, { detail: 0.9 })))
  ctx.restore()

  // Header
  const markW = drawWordmark(ctx, left, y + 39, 18)
  ctx.fillStyle = 'rgba(255, 255, 255, 0.18)'
  ctx.fillRect(left + markW + 18, y + 37, 1, 22)
  label(ctx, 'Crew boarding pass', left + markW + 36, y + 53, { color: C.dim })
  label(ctx, 'Mission', right, y + 40, { align: 'right' })
  text(ctx, `${pass.missionNumber} · ${pass.missionName}`, right, y + 62, {
    size: 16, weight: 650, stretch: 'semi-expanded', spacing: 1.6, align: 'right',
  })
  ctx.fillStyle = C.line
  ctx.fillRect(left, y + 80, right - left, 1)

  // Route
  label(ctx, 'Origin', left, y + 120)
  const earthW = text(ctx, 'EARTH', left, y + 178, { size: 60, weight: 700, stretch: 'expanded', spacing: 0.6 })
  label(ctx, pass.originDetail, left, y + 204, { color: C.dim, spacing: 1.8 })
  label(ctx, 'Destination', right, y + 120, { align: 'right' })
  const orbitW = text(ctx, 'ORBIT', right, y + 178, { size: 60, weight: 700, stretch: 'expanded', spacing: 0.6, align: 'right' })
  label(ctx, pass.destinationDetail, right, y + 204, { color: C.dim, spacing: 1.8, align: 'right' })

  // Ascent profile between the ports
  const ax0 = left + earthW + 30
  const ax1 = right - orbitW - 30
  const ay0 = y + 176
  const ay1 = y + 124
  ctx.save()
  ctx.setLineDash([2, 4])
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(ax0 - 6, ay0 + 2)
  ctx.lineTo(ax1 + 6, ay0 + 2)
  ctx.stroke()
  ctx.restore()
  ctx.save()
  ctx.strokeStyle = C.ion
  ctx.lineWidth = 1.6
  ctx.shadowColor = 'rgba(111, 195, 255, 0.9)'
  ctx.shadowBlur = 6
  ctx.beginPath()
  ctx.moveTo(ax0, ay0)
  ctx.bezierCurveTo(ax0, ay0 - (ay0 - ay1) * 0.6, ax0 + (ax1 - ax0) * 0.28, ay1 + 2, ax1, ay1)
  ctx.stroke()
  ctx.restore()
  ctx.fillStyle = C.text
  ctx.fillRect(ax0 - 3, ay0 - 1, 6, 6)
  ctx.strokeStyle = 'rgba(199, 236, 255, 0.55)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.arc(ax1, ay1, 6, 0, Math.PI * 2)
  ctx.stroke()
  ctx.save()
  ctx.fillStyle = C.ignite
  ctx.shadowColor = C.ignite
  ctx.shadowBlur = 8
  ctx.beginPath()
  ctx.arc(ax1, ay1, 2.6, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  // Passenger
  label(ctx, 'Passenger', left, y + 246)
  text(ctx, pass.name, left, y + 290, { size: 40, weight: 650, stretch: 'expanded', spacing: 1.4, maxWidth: right - left })

  // Fields
  ctx.fillStyle = C.line
  ctx.fillRect(left, y + 314, right - left, 1)
  ctx.fillRect(left, y + 376, right - left, 1)
  const fields = [
    ['Flight', pass.flight],
    ['Seat', pass.seat],
    ['Gate', pass.gate],
    ['Boarding', `${pass.boardingDate}  ${pass.boardingTime}`],
    ['Class', 'CREW'],
  ]
  const widths = [96, 74, 92, 250, 0]
  let fx = left
  fields.forEach(([key, value], i) => {
    const align = i === fields.length - 1 ? 'right' : 'left'
    const at = align === 'right' ? right : fx
    label(ctx, key, at, y + 338, { align })
    text(ctx, value, at, y + 362, { size: 16, weight: 650, stretch: 'semi-expanded', spacing: 1, align })
    fx += widths[i]
  })

  // Fine print. The "not valid for travel" disclosure is part of what the pass
  // says, so it prints at a size that reads at 100%.
  const fine = { size: 14, spacing: 1.8 }
  const idLabelW = label(ctx, 'Crew ID', left, y + 406, { ...fine, color: C.fine })
  const idW = label(ctx, pass.crewId, left + idLabelW + 12, y + 406, { ...fine, color: C.text })
  label(ctx, 'Commemorative · Not valid for travel', right, y + 406, {
    ...fine,
    color: C.fine,
    align: 'right',
    maxWidth: right - (left + idLabelW + 12 + idW + 32),
  })

  // Stub
  const sl = stubX + 34
  const sr = x + w - 34
  drawWordmark(ctx, sl, y + 43, 15)
  ctx.strokeStyle = 'rgba(111, 195, 255, 0.75)'
  ctx.lineWidth = 1
  ctx.strokeRect(sr - 74, y + 40, 74, 22)
  label(ctx, 'Issued', sr - 37, y + 56, { size: 11, spacing: 2, align: 'center', color: C.atmo })
  ctx.fillStyle = C.line
  ctx.fillRect(sl, y + 80, sr - sl, 1)
  label(ctx, 'Seat', sl, y + 116)
  text(ctx, pass.seat, sl, y + 166, { size: 46, weight: 700, stretch: 'expanded', spacing: 0.8 })
  label(ctx, 'Gate', sr, y + 116, { align: 'right' })
  text(ctx, pass.gate, sr, y + 137, { size: 15, weight: 650, stretch: 'semi-expanded', spacing: 1, align: 'right' })
  label(ctx, 'Group', sr, y + 160, { align: 'right' })
  text(ctx, pass.group, sr, y + 181, { size: 15, weight: 650, stretch: 'semi-expanded', spacing: 1, align: 'right' })

  // (the gate stamp lands between the seat and the code — see renderPassImage)
  const codeSize = 104
  ctx.save()
  ctx.translate(sl, y + 282)
  ctx.scale(codeSize / 19, codeSize / 19)
  ctx.fillStyle = C.text
  ctx.fill(new Path2D(matrixCodePath(pass.seed)))
  ctx.restore()
  label(ctx, pass.crewId, sl, y + 406, { size: 13, color: C.dim, spacing: 1.4 })
}

/** Returns a 1200×630 canvas with the pass drawn on it. */
export async function renderPassImage(pass) {
  await loadFonts()
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')

  drawSky(ctx, pass.seed)

  const box = { x: 100, y: 44, w: 1000, h: 432, r: 12, notch: 15 }
  box.stubX = box.x + box.w - 272
  const outline = cardPath(box.x, box.y, box.w, box.h, box.r, box.stubX, box.notch)

  // Card body with atmospheric light spilling onto it from below
  ctx.save()
  ctx.shadowColor = 'rgba(31, 107, 255, 0.4)'
  ctx.shadowBlur = 70
  ctx.shadowOffsetY = 16
  const body = ctx.createLinearGradient(box.x, box.y, box.x + box.w * 0.5, box.y + box.h * 1.3)
  body.addColorStop(0, '#111a2b')
  body.addColorStop(0.5, '#0a0f1a')
  body.addColorStop(1, '#05080e')
  ctx.fillStyle = body
  ctx.fill(outline)
  ctx.restore()

  ctx.save()
  ctx.clip(outline)
  const tint = ctx.createRadialGradient(box.x, box.y, 0, box.x, box.y, 700)
  tint.addColorStop(0, 'rgba(111, 195, 255, 0.1)')
  tint.addColorStop(1, 'rgba(111, 195, 255, 0)')
  ctx.fillStyle = tint
  ctx.fillRect(box.x, box.y, box.w, box.h)
  const under = ctx.createLinearGradient(0, box.y + box.h - 120, 0, box.y + box.h)
  under.addColorStop(0, 'rgba(255, 170, 110, 0)')
  under.addColorStop(1, 'rgba(255, 170, 110, 0.07)')
  ctx.fillStyle = under
  ctx.fillRect(box.x, box.y, box.w, box.h)
  // Stub panel
  ctx.fillStyle = 'rgba(255, 255, 255, 0.03)'
  ctx.fillRect(box.stubX, box.y, box.x + box.w - box.stubX, box.h)
  ctx.restore()

  // Ink layer with a holographic foil sweep across the printed elements only
  const ink = document.createElement('canvas')
  ink.width = W
  ink.height = H
  const ictx = ink.getContext('2d')
  drawInk(ictx, pass, box)
  ictx.globalCompositeOperation = 'source-atop'
  const foil = ictx.createLinearGradient(box.x + 120, box.y - 40, box.x + 620, box.y + box.h + 60)
  foil.addColorStop(0, 'rgba(111, 195, 255, 0)')
  foil.addColorStop(0.38, 'rgba(111, 195, 255, 0)')
  foil.addColorStop(0.46, 'rgba(111, 195, 255, 0.55)')
  foil.addColorStop(0.52, 'rgba(199, 236, 255, 0.6)')
  foil.addColorStop(0.58, 'rgba(255, 180, 107, 0.55)')
  foil.addColorStop(0.66, 'rgba(255, 180, 107, 0)')
  foil.addColorStop(1, 'rgba(255, 180, 107, 0)')
  ictx.fillStyle = foil
  ictx.fillRect(0, 0, W, H)
  ctx.drawImage(ink, 0, 0)

  // Perforation + edge
  ctx.save()
  ctx.setLineDash([5, 6])
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.32)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(box.stubX + 0.5, box.y + box.notch + 6)
  ctx.lineTo(box.stubX + 0.5, box.y + box.h - box.notch - 6)
  ctx.stroke()
  ctx.restore()
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)'
  ctx.lineWidth = 1
  ctx.stroke(outline)

  // Stamp
  ctx.save()
  ctx.translate(box.stubX + 136, box.y + 228)
  ctx.rotate((-8 * Math.PI) / 180)
  ctx.globalAlpha = 0.9
  ctx.strokeStyle = C.atmo
  ctx.lineWidth = 1.5
  ctx.strokeRect(-78, -34, 156, 68)
  ctx.globalAlpha = 0.35
  ctx.lineWidth = 3
  ctx.strokeRect(-72, -28, 144, 56)
  ctx.globalAlpha = 0.9
  label(ctx, 'Cleared for boarding', 0, -14, { size: 8.5, align: 'center', color: C.atmo, spacing: 1.8 })
  text(ctx, 'CREW', 0, 10, { size: 21, weight: 700, stretch: 'expanded', spacing: 5, align: 'center', color: C.atmo })
  label(ctx, `Mission ${pass.missionNumber}`, 0, 25, { size: 8.5, align: 'center', color: C.atmo, spacing: 1.8 })
  ctx.restore()

  return canvas
}

/** Canvas → PNG blob. */
export function toBlob(canvas) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG encoding failed'))), 'image/png'),
  )
}
