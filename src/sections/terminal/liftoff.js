/**
 * T−0 on the flight computer: an ASCII vehicle lifts off the bottom of the
 * screen on a glyph plume, kicks up a ground cloud and climbs out of frame.
 *
 * Rendering: the vehicle is pre-drawn once to a sprite (with its phosphor
 * glow); the exhaust is a small particle system whose particles are binned
 * into the character grid every frame, so each cell draws one glyph whose
 * character and colour come from its heat — fire near the nozzle, smoke as
 * it cools. Self-contained rAF that ends itself and removes its canvas;
 * never called under reduced motion.
 *
 * The vehicle is an original design (and wears the SXSI letters). On wide
 * screens it already stands on its pad in the idle console (`renderPad`);
 * liftoff then starts from exactly that spot, so the vehicle the visitor
 * has been looking at is the one that flies.
 */
import { dpr, tier } from '../../lib/quality.js'

const VEHICLE = [
  '    |    ',
  '   /^\\   ',
  '  /   \\  ',
  '  |   |  ',
  '  | S |  ',
  '  | X |  ',
  '  | S |  ',
  '  | I |  ',
  '  |---|  ',
  '  |   |  ',
  '  |   |  ',
  ' /|   |\\ ',
  '/_|___|_\\',
  '   VVV   ',
]
const LETTERS = new Set(['S', 'X', 'I'])
// The pad is a 3-column service tower beside the vehicle; its arm swings clear at ignition.
const TOWER = 3
const ARM_ROW = 5
const LINE = 1.15 // line-height of a grid row, in ems (the pad's <pre> uses the same)

/**
 * Fills `pre` with the vehicle standing on its pad (tower + vehicle), as
 * styled spans built from text nodes. Purely decorative.
 */
export function renderPad(pre) {
  if (!pre) return
  const frag = document.createDocumentFragment()
  const kind = (char) => (char === 'H' ? 'is-tower' : char === '=' ? 'is-arm' : LETTERS.has(char) ? 'is-mark' : '')
  VEHICLE.forEach((row, r) => {
    const tower = r < 2 ? '   ' : r === ARM_ROW ? 'H==' : 'H  '
    const text = tower + row
    // Group runs of the same kind into one span.
    let run = ''
    let runKind = null
    const flush = () => {
      if (!run) return
      if (runKind) {
        const span = document.createElement('span')
        span.className = runKind
        span.textContent = run
        frag.append(span)
      } else {
        frag.append(document.createTextNode(run))
      }
      run = ''
    }
    for (const char of text) {
      const k = kind(char)
      if (k !== runKind) flush()
      runKind = k
      run += char
    }
    flush()
    if (r < VEHICLE.length - 1) frag.append(document.createTextNode('\n'))
  })
  pre.replaceChildren(frag)
}

/** Offset of `el` inside `host` in layout px (ignores CSS transforms). */
function offsetWithin(el, host) {
  let x = 0
  let y = 0
  for (let node = el; node && node !== host; node = node.offsetParent) {
    x += node.offsetLeft
    y += node.offsetTop
  }
  return { x, y }
}

// Heat → glyph. Hot cells are dense characters in white-orange; as exhaust
// cools it turns to sparse, blue-grey smoke.
const LEVELS = [
  { min: 0.8, color: '#fff6e6', glyphs: '@#%' },
  { min: 0.6, color: '#ffd7a3', glyphs: '#%*' },
  { min: 0.43, color: '#ffb46b', glyphs: '*+x' },
  { min: 0.29, color: '#ff6b2c', glyphs: '+=:' },
  { min: 0.16, color: 'rgba(200, 214, 234, 0.6)', glyphs: ':;~' },
  { min: 0.05, color: 'rgba(150, 172, 204, 0.36)', glyphs: ".'`" },
]

const HOLD = 0.7 // s on the pad at full thrust before the clamps release
const CLIMB = 1.75 // s from release until the vehicle clears the top
const SETTLE = 0.8 // s for the exhaust to thin before fading out
const rand = (a, b) => a + Math.random() * (b - a)

/**
 * Runs the liftoff over `host` (the screen). `anchor`: the idle pad's <pre>;
 * when it's displayed the flight starts from its exact cells.
 */
export function liftoff(host, { anchor = null } = {}) {
  return new Promise((resolve) => {
    const W = host.clientWidth
    const H = host.clientHeight
    if (!W || !H) return resolve()

    const scale = Math.min(dpr, 1.5)
    const canvas = document.createElement('canvas')
    canvas.className = 's-terminal__liftoff'
    canvas.setAttribute('aria-hidden', 'true')
    canvas.width = Math.round(W * scale)
    canvas.height = Math.round(H * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) return resolve()
    host.append(canvas)
    ctx.setTransform(scale, 0, 0, scale, 0, 0)

    const vCols = VEHICLE[0].length
    const onPad = Boolean(anchor && anchor.offsetWidth)
    // Character cell: the idle pad's, or sized so the vehicle stands ~40% of the screen.
    const size = onPad
      ? parseFloat(getComputedStyle(anchor).fontSize)
      : Math.round(Math.max(11, Math.min(17, (H * 0.4) / (VEHICLE.length * LINE))))
    const cw = size * 0.6
    const ch = size * LINE
    const font = `600 ${size}px 'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, monospace`
    const vw = vCols * cw
    const vh = VEHICLE.length * ch

    // Grid origin (the tower's column) and the ground line.
    let gx
    let groundY
    if (onPad) {
      const at = offsetWithin(anchor, host)
      gx = at.x
      groundY = at.y + vh
    } else {
      gx = Math.round(W / 2 / cw - vCols / 2) * cw - TOWER * cw
      groundY = H - ch * 1.6
    }
    const vx = gx + TOWER * cw
    const restY = groundY - vh
    // Exhaust cells share the vehicle's grid, so plume glyphs line up with its columns.
    const ox = ((gx % cw) + cw) % cw
    const oy = ((groundY % ch) + ch) % ch
    const cols = Math.ceil((W - ox) / cw)
    const rows = Math.ceil((H - oy) / ch)

    const sprite = drawVehicle({ cw, ch, font, scale })

    /* ---- Exhaust particles ---------------------------------------------- */
    const MAX = tier === 'low' ? 700 : tier === 'medium' ? 1100 : 1500
    const RATE = tier === 'low' ? 520 : 900 // particles / s at full thrust
    const parts = []
    const heat = new Float32Array(cols * rows)
    const density = new Uint8Array(cols * rows)
    const buckets = LEVELS.map(() => [])

    function emit(count, nozzleX, nozzleY, thrust) {
      for (let i = 0; i < count && parts.length < MAX; i++) {
        const smoke = Math.random() < 0.24
        parts.push({
          x: nozzleX + rand(-1.1, 1.1) * cw,
          y: nozzleY + rand(0, ch * 0.5),
          vx: smoke ? rand(-36, 36) : rand(-75, 75),
          vy: smoke ? rand(50, 150) : rand(360, 620) * (0.6 + thrust * 0.4),
          age: 0,
          life: smoke ? rand(1.1, 2.1) : rand(0.32, 0.7),
          h0: smoke ? rand(0.24, 0.3) : rand(0.78, 1),
          ground: false,
        })
      }
    }

    function step(dt) {
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i]
        p.age += dt
        if (p.age >= p.life) {
          parts[i] = parts[parts.length - 1]
          parts.pop()
          continue
        }
        p.x += p.vx * dt
        p.y += p.vy * dt
        if (!p.ground && p.y >= groundY) {
          // Deflected along the pad: the ground cloud rolls outwards and lifts.
          p.ground = true
          p.y = groundY - rand(0, ch * 1.2)
          p.vx = (Math.random() < 0.5 ? -1 : 1) * rand(120, 340)
          p.vy = -rand(10, 64)
          p.life = p.age + rand(0.7, 1.5)
          p.h0 *= 0.62
        }
        if (p.ground) {
          p.vx *= 1 - Math.min(1, dt * 1.7)
          p.vy *= 1 - Math.min(1, dt * 0.6)
        } else {
          p.vx *= 1 - Math.min(1, dt * 0.8)
        }
      }
    }

    function drawExhaust() {
      heat.fill(0)
      density.fill(0)
      for (const p of parts) {
        const c = Math.floor((p.x - ox) / cw)
        const r = Math.floor((p.y - oy) / ch)
        if (c < 0 || r < 0 || c >= cols || r >= rows) continue
        const k = 1 - p.age / p.life
        const idx = r * cols + c
        heat[idx] = Math.max(heat[idx], p.h0 * k * k)
        if (density[idx] < 255) density[idx]++
      }
      for (const list of buckets) list.length = 0
      for (let idx = 0; idx < heat.length; idx++) {
        // Crowded cells glow a little hotter (capped, so the core stays a core).
        const h = heat[idx] && Math.min(1, heat[idx] + Math.min(0.1, density[idx] * 0.012))
        if (h < LEVELS[LEVELS.length - 1].min) continue
        for (let l = 0; l < LEVELS.length; l++) {
          if (h >= LEVELS[l].min) {
            buckets[l].push(idx)
            break
          }
        }
      }
      ctx.font = font
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      buckets.forEach((list, l) => {
        if (!list.length) return
        const { color, glyphs } = LEVELS[l]
        ctx.fillStyle = color
        for (const idx of list) {
          const c = idx % cols
          const r = (idx / cols) | 0
          ctx.fillText(glyphs[(Math.random() * glyphs.length) | 0], ox + c * cw + cw / 2, oy + r * ch + ch / 2)
        }
      })
    }

    /* ---- Static set: pad, tower ----------------------------------------- */
    // Ground hairline (matches the idle pad's when there is one)
    const x0 = onPad ? gx - 12 * cw : 0
    const x1 = onPad ? vx + vw + 5 * cw : W
    const line = ctx.createLinearGradient(x0, 0, x1, 0)
    line.addColorStop(0, 'rgba(111, 195, 255, 0)')
    line.addColorStop(0.55, 'rgba(199, 236, 255, 0.55)')
    line.addColorStop(1, 'rgba(111, 195, 255, 0)')

    function drawPad(t) {
      ctx.fillStyle = line
      ctx.fillRect(x0, Math.round(groundY + ch * 0.35), x1 - x0, 1)

      // Service tower to the left, arm swinging clear at ignition.
      ctx.font = font
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = 'rgba(170, 196, 232, 0.5)'
      const top = groundY - vh
      for (let r = 2; r < VEHICLE.length; r++) ctx.fillText('H', gx + cw / 2, top + ch * (r + 0.5))
      if (t < 0.25) {
        ctx.fillText('=', gx + cw * 1.5, top + ch * (ARM_ROW + 0.5))
        ctx.fillText('=', gx + cw * 2.5, top + ch * (ARM_ROW + 0.5))
      }
    }

    /* ---- Loop ----------------------------------------------------------- */
    const end = HOLD + CLIMB + SETTLE
    const climbDistance = restY + vh + ch * 2
    const accel = (2 * climbDistance) / (CLIMB * CLIMB)
    let start = 0
    let last = 0
    let raf = 0
    let done = false

    const frame = (now) => {
      if (!start) start = last = now
      // rAF timestamps can trail the synchronous first call by a frame — never step backwards.
      const t = Math.max(0, (now - start) / 1000)
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000))
      last = Math.max(last, now)

      // Thrust builds over the hold; altitude follows constant acceleration.
      const thrust = Math.min(1, t / 0.45)
      const climbT = Math.max(0, t - HOLD)
      const alt = 0.5 * accel * climbT * climbT
      const y = restY - alt
      const shake = t < HOLD ? (Math.random() - 0.5) * 1.2 * thrust : 0
      const nozzleX = vx + vw / 2
      const nozzleY = y + vh - ch * 0.3

      if (y + vh > -ch) emit(Math.round(RATE * thrust * dt), nozzleX, nozzleY, thrust)
      step(dt)

      ctx.clearRect(0, 0, W, H)
      drawPad(t)
      drawExhaust()
      if (y + vh > 0) ctx.drawImage(sprite, Math.round(vx + shake), Math.round(y), vw, vh)

      if (t < end && !done) {
        raf = requestAnimationFrame(frame)
      } else {
        finish()
      }
    }

    function finish() {
      if (done) return
      done = true
      cancelAnimationFrame(raf)
      canvas.classList.add('is-out')
      setTimeout(() => {
        canvas.remove()
        resolve()
      }, 600)
    }

    // First frame now, so the vehicle never blinks out between the pad and the canvas.
    frame(performance.now())
    // Safety: a hidden tab pauses rAF — never leave the overlay behind.
    setTimeout(finish, (end + 1.2) * 1000)
  })
}

/** Pre-renders the vehicle (glow pass + crisp pass) to an offscreen canvas. */
function drawVehicle({ cw, ch, font, scale }) {
  const canvas = document.createElement('canvas')
  const w = VEHICLE[0].length * cw
  const h = VEHICLE.length * ch
  canvas.width = Math.ceil(w * scale)
  canvas.height = Math.ceil(h * scale)
  const ctx = canvas.getContext('2d')
  ctx.setTransform(scale, 0, 0, scale, 0, 0)

  // Solid hull: fill between each row's outer glyphs so the screen behind
  // doesn't show through the vehicle.
  ctx.fillStyle = '#02050b'
  VEHICLE.forEach((row, r) => {
    const a = row.search(/\S/)
    const b = row.length - 1 - [...row].reverse().join('').search(/\S/)
    if (a < 0 || row.trim().length < 2) return
    ctx.fillRect((a + 0.5) * cw, r * ch, (b - a) * cw, ch + 0.5)
  })

  ctx.font = font
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const paint = (glow) => {
    ctx.shadowBlur = glow ? 10 : 0
    ctx.shadowColor = glow ? 'rgba(111, 195, 255, 0.75)' : 'transparent'
    VEHICLE.forEach((row, r) => {
      ;[...row].forEach((char, c) => {
        if (char === ' ') return
        ctx.fillStyle = LETTERS.has(char) ? '#6fc3ff' : char === '-' ? '#9fb8d6' : char === 'V' ? '#c7ecff' : '#eef6ff'
        ctx.fillText(char, c * cw + cw / 2, r * ch + ch / 2)
      })
    })
  }
  paint(true)
  paint(false)
  return canvas
}
