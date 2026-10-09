/**
 * "Input signal" oscilloscope for the console rail (2D canvas).
 * A quiet carrier wave that spikes with every keystroke and every printed
 * line — `kick(amount)` feeds it energy, which decays over ~1 s.
 * Runs only while visible; renders a single still under reduced motion.
 */
import { dpr, reducedMotion } from '../../lib/quality.js'
import { createRenderLoop } from '../../lib/visibility.js'

export function createScope(canvas) {
  if (!canvas) return { kick() {}, destroy() {} }
  const ctx = canvas.getContext('2d')
  if (!ctx) return { kick() {}, destroy() {} }

  let w = 0
  let h = 0
  let samples = new Float32Array(0)
  let head = 0
  let energy = 0.15
  let phase = 0
  let acc = 0

  function resize() {
    // Layout size (not getBoundingClientRect: the console is CSS-transformed while it scrolls in).
    if (!canvas.clientWidth || !canvas.clientHeight) return false
    w = canvas.clientWidth
    h = canvas.clientHeight
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const count = Math.max(32, Math.round(w / 2))
    if (samples.length !== count) {
      samples = new Float32Array(count)
      head = 0
      for (let i = 0; i < count; i++) push(1 / 60)
    }
    return true
  }

  // One new sample: a carrier + harmonics, amplitude driven by energy.
  function push(dt) {
    phase += dt
    const carrier = Math.sin(phase * 9.0) * 0.55 + Math.sin(phase * 23.0 + 1.3) * 0.25 + Math.sin(phase * 61.0) * 0.12
    const noise = (Math.random() - 0.5) * 0.35
    samples[head] = (carrier + noise * energy * 2.2) * (0.12 + energy * 0.88)
    head = (head + 1) % samples.length
  }

  function draw() {
    ctx.clearRect(0, 0, w, h)
    const mid = h / 2

    // Graticule
    ctx.strokeStyle = 'rgba(111, 195, 255, 0.08)'
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let x = 0.5; x < w; x += w / 8) {
      ctx.moveTo(Math.round(x) + 0.5, 0)
      ctx.lineTo(Math.round(x) + 0.5, h)
    }
    for (let y = 1; y < 4; y++) {
      const yy = Math.round((h / 4) * y) + 0.5
      ctx.moveTo(0, yy)
      ctx.lineTo(w, yy)
    }
    ctx.stroke()

    // Trace: oldest sample on the left
    const n = samples.length
    const step = w / (n - 1)
    const trace = () => {
      ctx.beginPath()
      for (let i = 0; i < n; i++) {
        const v = samples[(head + i) % n]
        const x = i * step
        const y = mid - v * (h * 0.42)
        if (i) ctx.lineTo(x, y)
        else ctx.moveTo(x, y)
      }
    }
    trace()
    ctx.lineJoin = 'round'
    ctx.strokeStyle = 'rgba(111, 195, 255, 0.16)'
    ctx.lineWidth = 4
    ctx.stroke()
    ctx.strokeStyle = 'rgba(199, 236, 255, 0.92)'
    ctx.lineWidth = 1.2
    ctx.stroke()

    // Write head
    const last = samples[(head + n - 1) % n]
    ctx.fillStyle = '#ffffff'
    ctx.beginPath()
    ctx.arc(w - 1.5, mid - last * (h * 0.42), 1.8, 0, Math.PI * 2)
    ctx.fill()
  }

  // Advance at a fixed ~60 Hz regardless of display rate.
  const frame = (t, dt) => {
    acc += dt
    let guard = 0
    while (acc >= 1 / 60 && guard++ < 6) {
      push(1 / 60)
      acc -= 1 / 60
    }
    energy += (0.12 - energy) * Math.min(1, dt * 1.6)
    draw()
  }

  // The rail is display:none on narrow screens — only keep a loop while the
  // canvas actually has a size.
  let loop = null
  const ro = new ResizeObserver(() => {
    const ready = resize()
    if (ready) draw()
    if (ready && !loop && !reducedMotion) loop = createRenderLoop(canvas, frame)
    if (!ready && loop) {
      loop.destroy()
      loop = null
    }
  })
  ro.observe(canvas)

  return {
    kick(amount = 0.35) {
      energy = Math.min(1, energy + amount)
    },
    destroy() {
      loop?.destroy()
      ro.disconnect()
    },
  }
}
