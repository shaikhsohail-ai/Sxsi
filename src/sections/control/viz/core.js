/**
 * Shared plumbing for the Mission Control micro-visualisations.
 *
 * Every viz is a plain factory returning
 *   { resize(s), step(dt, s), draw(ctx, s), trigger(s), settle(s), status, tone, readout() }
 * and `mountViz()` gives it a DPR-aware 2D canvas, a render loop that only
 * runs while its tile is on screen, a smoothed hover "energy", pointer
 * coordinates, a boot (power-on) progress and HUD text reporting.
 *
 * `s` (the shared tile state) holds, in CSS pixels:
 *   w, h        canvas size           t       viz clock (s, frozen on hold)
 *   energy      0..1 hover/focus      boot    0..1 power-on progress
 *   mx, my      pointer position      pointer true while a fine pointer is over the tile
 *   band        { top, bottom, h, mid } the vertical strip between the tile's
 *               HUD and its copy — where a viz should keep its focal point
 */
import { dpr, reducedMotion, tier } from '../../../lib/quality.js'
import { createRenderLoop } from '../../../lib/visibility.js'

/* --------------------------------------------------------------------------
 * Palette — read from the design tokens so canvases stay in sync with CSS.
 * ------------------------------------------------------------------------ */
export function readPalette() {
  const css = getComputedStyle(document.documentElement)
  const get = (name, fallback) => parseColor(css.getPropertyValue(name).trim() || fallback)
  return {
    text: get('--c-text', '#f4f6fb'),
    atmo: get('--c-atmo', '#6fc3ff'),
    deep: get('--c-atmo-deep', '#1f6bff'),
    ion: get('--c-ion', '#c7ecff'),
    ignite: get('--c-ignite', '#ff6b2c'),
    igniteSoft: get('--c-ignite-soft', '#ffb46b'),
    ok: get('--c-ok', '#4dffa8'),
  }
}

function parseColor(value) {
  let r = 255
  let g = 255
  let b = 255
  const hex = value.match(/^#([0-9a-f]{3,8})$/i)
  if (hex) {
    let h = hex[1]
    if (h.length <= 4) h = h.split('').map((c) => c + c).join('')
    r = parseInt(h.slice(0, 2), 16)
    g = parseInt(h.slice(2, 4), 16)
    b = parseInt(h.slice(4, 6), 16)
  } else {
    const m = value.match(/rgba?\(([^)]+)\)/i)
    if (m) [r, g, b] = m[1].split(/[\s,/]+/).map(Number)
  }
  return { r, g, b, rgb: `rgb(${r},${g},${b})`, a: (alpha) => `rgba(${r},${g},${b},${alpha})` }
}

/** Mixes two parsed colors: t = 0 → a, t = 1 → b. Returns an rgb() string. */
export function mixColor(a, b, t) {
  const m = (x, y) => Math.round(x + (y - x) * t)
  return `rgb(${m(a.r, b.r)},${m(a.g, b.g)},${m(a.b, b.b)})`
}

/* --------------------------------------------------------------------------
 * Glow sprites — pre-rendered radial gradients (canvas shadowBlur is slow).
 * ------------------------------------------------------------------------ */
const sprites = new Map()

export function glowSprite(color, size = 128) {
  const key = `${color.rgb}|${size}`
  let sprite = sprites.get(key)
  if (sprite) return sprite
  sprite = document.createElement('canvas')
  sprite.width = sprite.height = size
  const g = sprite.getContext('2d')
  const half = size / 2
  const grad = g.createRadialGradient(half, half, 0, half, half, half)
  grad.addColorStop(0, color.a(1))
  grad.addColorStop(0.1, color.a(0.8))
  grad.addColorStop(0.3, color.a(0.26))
  grad.addColorStop(0.6, color.a(0.06))
  grad.addColorStop(1, color.a(0))
  g.fillStyle = grad
  g.fillRect(0, 0, size, size)
  sprites.set(key, sprite)
  return sprite
}

/** Additively draws a glow sprite centred on (x, y). */
export function drawGlow(ctx, sprite, x, y, radius, alpha) {
  if (alpha <= 0.003 || radius <= 0.5) return
  const prevOp = ctx.globalCompositeOperation
  ctx.globalCompositeOperation = 'lighter'
  ctx.globalAlpha = Math.min(1, alpha)
  ctx.drawImage(sprite, x - radius, y - radius, radius * 2, radius * 2)
  ctx.globalCompositeOperation = prevOp
}

/* --------------------------------------------------------------------------
 * Small maths
 * ------------------------------------------------------------------------ */
export const TAU = Math.PI * 2
export const sat = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
export const easeOut = (t) => 1 - Math.pow(1 - sat(t), 3)
export const easeInOut = (t) => {
  t = sat(t)
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}
export const expoOut = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * sat(t)))
/** Frame-rate independent exponential approach factor. */
export const approach = (rate, dt) => 1 - Math.exp(-rate * dt)
/** Wraps an angle to (-π, π]. */
export const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a))
/**
 * Length of (x, y). Math.hypot allocates on every call (it takes varargs);
 * this two-argument form inlines to a plain sqrt — use it in frame loops.
 */
export const hypot = (x, y) => Math.sqrt(x * x + y * y)

/**
 * Batches small rects into quantised alpha buckets, so hundreds of dots or
 * bars cost a handful of fills instead of one draw call each. The buckets are
 * kept between frames (a count marks their live part), so a frame allocates
 * nothing.
 */
export function rectBatch(levels = 16) {
  const buckets = Array.from({ length: levels + 1 }, () => [])
  const counts = new Uint32Array(levels + 1)
  return {
    add(x, y, w, h, alpha) {
      if (alpha <= 0.01) return
      const k = Math.min(levels, Math.max(1, Math.round(alpha * levels)))
      const b = buckets[k]
      const n = counts[k]
      b[n] = x
      b[n + 1] = y
      b[n + 2] = w
      b[n + 3] = h
      counts[k] = n + 4
    },
    dot(x, y, size, alpha) {
      this.add(x - size / 2, y - size / 2, size, size, alpha)
    },
    flush(ctx, color) {
      ctx.fillStyle = color
      for (let k = 1; k <= levels; k++) {
        const n = counts[k]
        if (!n) continue
        const b = buckets[k]
        ctx.globalAlpha = k / levels
        ctx.beginPath()
        for (let i = 0; i < n; i += 4) ctx.rect(b[i], b[i + 1], b[i + 2], b[i + 3])
        ctx.fill()
        counts[k] = 0
      }
    },
  }
}

/** Shared empty dash list: `ctx.setLineDash(NO_DASH)` resets without allocating. */
export const NO_DASH = Object.freeze([])

/** One dotted line (dash pattern) — cheaper than a dot per fillRect. */
export function dotted(ctx, x0, y0, x1, y1, dash, color, alpha) {
  ctx.globalAlpha = alpha
  ctx.strokeStyle = color
  ctx.lineWidth = 1
  ctx.setLineDash(dash)
  ctx.beginPath()
  ctx.moveTo(x0, y0)
  ctx.lineTo(x1, y1)
  ctx.stroke()
  ctx.setLineDash(NO_DASH)
}

export const MONO = '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace'

const FONTS = new Map() // size → font string, built once per size
const lastFont = new WeakMap() // ctx → the font label() last set on it

/**
 * Tiny mono HUD label drawn on canvas. The font is only assigned when it
 * changes (mountViz forgets it when a resize resets the context); don't call
 * this between save() and restore().
 */
export function label(ctx, text, x, y, { color = 'rgb(244,246,251)', alpha = 0.5, size = 9, align = 'left', baseline = 'middle' } = {}) {
  if (alpha <= 0.01) return
  ctx.globalAlpha = Math.min(1, alpha)
  ctx.fillStyle = color
  let font = FONTS.get(size)
  if (!font) FONTS.set(size, (font = `500 ${size}px ${MONO}`))
  if (lastFont.get(ctx) !== font) {
    ctx.font = font
    lastFont.set(ctx, font)
  }
  ctx.textAlign = align
  ctx.textBaseline = baseline
  ctx.fillText(text, x, y)
}

/* --------------------------------------------------------------------------
 * Mounting
 * ------------------------------------------------------------------------ */
const REPORT_EVERY = 0.12 // seconds between HUD text updates
const FRAME_SKIP = tier === 'low' ? 2 : 1 // low-tier devices draw at ~30fps

/**
 * @param {object} o
 * @param {HTMLElement} o.tile
 * @param {HTMLCanvasElement} o.canvas
 * @param {object} o.viz          the visualisation instance
 * @param {(text: string, tone?: string) => void} [o.onStatus]
 * @param {(text: string) => void} [o.onReadout]
 */
export function mountViz({ tile, canvas, viz, onStatus, onReadout }) {
  const ctx = canvas.getContext('2d')
  const s = {
    w: 0,
    h: 0,
    t: 0,
    energy: 0,
    energyTarget: 0,
    boot: reducedMotion ? 1 : 0,
    mx: 0,
    my: 0,
    pointer: false,
    held: false,
    still: reducedMotion,
    band: { top: 0, bottom: 0, h: 0, mid: 0 },
  }

  // offsetTop/Height ignore transforms, so reveal tweens don't skew this.
  const hud = tile.querySelector('.s-control__hud')
  const body = tile.querySelector('.s-control__body')
  const counter = tile.querySelector('.s-control__counter')
  const measureBand = () => {
    const top = hud ? hud.offsetTop + hud.offsetHeight : s.h * 0.2
    let bottom = body ? body.offsetTop : s.h * 0.75
    // On phones the SCALE counter sits in flow above the copy: it's the floor.
    if (counter && getComputedStyle(counter).position === 'static') bottom = Math.min(bottom, counter.offsetTop)
    s.band.top = top
    s.band.bottom = Math.max(top + 40, bottom)
    s.band.h = s.band.bottom - s.band.top
    s.band.mid = (s.band.top + s.band.bottom) / 2
  }

  let lastStatus = ''
  let lastReadout = ''
  let reportClock = 0
  let settled = false

  const report = (force = false) => {
    if (!force && s.t - reportClock < REPORT_EVERY) return
    reportClock = s.t
    const status = viz.status || ''
    const tone = viz.tone || ''
    if (onStatus && status + tone !== lastStatus) {
      lastStatus = status + tone
      onStatus(status, tone)
    }
    const readout = viz.readout?.() || ''
    if (onReadout && readout !== lastReadout) {
      lastReadout = readout
      onReadout(readout)
    }
  }

  const render = () => {
    if (!s.w) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    ctx.clearRect(0, 0, s.w, s.h)
    viz.draw(ctx, s)
    ctx.globalAlpha = 1
  }

  const ro = new ResizeObserver((entries) => {
    const box = entries[0].contentRect
    const w = Math.max(1, Math.round(box.width))
    const h = Math.max(1, Math.round(box.height))
    if (w === s.w && h === s.h) return
    s.w = w
    s.h = h
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    lastFont.delete(ctx) // resizing reset the context's state
    measureBand()
    viz.resize(s)
    if (s.still && !settled) {
      settled = true
      viz.settle?.(s)
      report(true)
    }
    render() // a resize clears the canvas; repaint immediately
  })
  ro.observe(canvas)

  let loop = null
  let frame = 0
  let pending = 0
  if (!s.still) {
    loop = createRenderLoop(tile, (_, dt) => {
      if (!s.w) return
      pending += dt
      if (++frame % FRAME_SKIP) return
      dt = Math.min(pending, 0.1)
      pending = 0
      s.energy += (s.energyTarget - s.energy) * approach(5, dt)
      if (s.held) return
      s.t += dt
      viz.step(dt, s)
      render()
      report()
    })
  }

  return {
    state: s,
    viz,
    render,
    setEnergy(value) {
      s.energyTarget = value
      if (s.still) s.energy = value
    },
    setPointer(active, x = s.mx, y = s.my) {
      s.pointer = active
      s.mx = x
      s.my = y
    },
    setHeld(held) {
      s.held = held
    },
    trigger() {
      viz.trigger?.(s)
      if (s.still) {
        // Reduced motion: jump straight to a new resolved still frame.
        viz.settle?.(s)
        render()
      }
      report(true)
    },
    destroy() {
      loop?.destroy()
      ro.disconnect()
    },
  }
}
