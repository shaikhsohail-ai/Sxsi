/**
 * SXSI soundscape — synthesised entirely with Web Audio (no audio files).
 *
 *   ambient  a deep, slowly evolving drone: detuned saw/sine voices through a
 *            breathing low-pass, a bed of filtered "solar wind" noise and the
 *            odd distant beacon ping.
 *   cues     'ignition' | 'blip' | 'whoosh' | 'confirm', requested by any
 *            section via emit('sound:cue', { type }).
 *
 * OFF by default. The AudioContext is only created inside a user gesture. The
 * preference is remembered, but even when remembered as on, nothing plays until
 * the visitor's next gesture (click / key / tap) on the page.
 */
import { emit, on } from '../../lib/bus.js'

const STORAGE_KEY = 'sxsi:sound'
const MASTER_LEVEL = 0.6

// Low voicings the drone drifts between (Hz). Roots: A, F, G, E.
const CHORDS = [
  [55, 82.41, 110, 164.81],
  [43.65, 65.41, 87.31, 130.81],
  [49, 73.42, 98, 146.83],
  [41.2, 61.74, 82.41, 123.47],
]

const readPref = () => {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'on'
  } catch {
    return false
  }
}

const writePref = (value) => {
  try {
    localStorage.setItem(STORAGE_KEY, value ? 'on' : 'off')
  } catch {
    /* storage blocked — preference just isn't remembered */
  }
}

export function createSound() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext
  const supported = Boolean(AudioCtx)

  let ctx = null
  let nodes = null
  let wanted = supported && readPref() // the visitor's preference
  let running = false // actually audible
  let suspendTimer = 0
  let evolveTimer = 0
  let beaconTimer = 0
  let chordIndex = 0
  const lastCue = {}
  const listeners = new Set()

  const notify = () => {
    const state = { wanted, running, supported }
    for (const fn of listeners) fn(state)
  }

  /* ------------------------------------------------------------------------
   * Graph
   * ---------------------------------------------------------------------- */
  function noiseBuffer(seconds = 4) {
    // Brown-ish noise: integrated white noise, gentle on the ears.
    const length = Math.floor(ctx.sampleRate * seconds)
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate)
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch)
      let last = 0
      for (let i = 0; i < length; i++) {
        const white = Math.random() * 2 - 1
        last = (last + 0.02 * white) / 1.02
        data[i] = last * 3.5
      }
    }
    return buffer
  }

  function whiteBuffer(seconds = 2) {
    const length = Math.floor(ctx.sampleRate * seconds)
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1
    return buffer
  }

  /** A synthetic hall: decaying stereo noise as the impulse response. */
  function impulse(seconds = 3.2, decay = 3) {
    const length = Math.floor(ctx.sampleRate * seconds)
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate)
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch)
      for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay)
    }
    return buffer
  }

  function lfo(frequency, depth, target) {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.frequency.value = frequency
    gain.gain.value = depth
    osc.connect(gain).connect(target)
    osc.start()
    return osc
  }

  function build() {
    const master = ctx.createGain()
    master.gain.value = 0
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -18
    comp.ratio.value = 3
    master.connect(comp).connect(ctx.destination)

    const reverb = ctx.createConvolver()
    reverb.buffer = impulse()
    const reverbOut = ctx.createGain()
    reverbOut.gain.value = 0.42
    reverb.connect(reverbOut).connect(master)

    // ---- Drone ------------------------------------------------------------
    const drone = ctx.createGain()
    drone.gain.value = 0.5
    drone.connect(master)

    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 420
    filter.Q.value = 0.9
    filter.connect(drone)
    lfo(0.031, 240, filter.frequency) // slow breathing of the timbre

    const voices = CHORDS[0].map((freq, i) => {
      const gain = ctx.createGain()
      gain.gain.value = [0.22, 0.13, 0.1, 0.05][i]
      gain.connect(filter)
      const oscs = [-7, 6].map((cents, j) => {
        const osc = ctx.createOscillator()
        osc.type = i === 0 && j === 0 ? 'sine' : 'sawtooth'
        osc.frequency.value = freq
        osc.detune.value = cents
        osc.connect(gain)
        osc.start()
        return osc
      })
      // Each voice swells on its own slow cycle so the chord never sits still
      const swell = ctx.createGain()
      swell.gain.value = 0.35 * gain.gain.value
      const mod = ctx.createOscillator()
      mod.frequency.value = 0.045 + i * 0.023
      mod.connect(swell).connect(gain.gain)
      mod.start()
      return { oscs, freq }
    })

    // Wide, quiet sub with a slight wobble in pitch
    const sub = ctx.createOscillator()
    sub.type = 'sine'
    sub.frequency.value = CHORDS[0][0] / 2
    const subGain = ctx.createGain()
    subGain.gain.value = 0.16
    sub.connect(subGain).connect(drone)
    sub.start()

    // Solar wind: band-passed brown noise drifting in level and colour
    const wind = ctx.createBufferSource()
    wind.buffer = noiseBuffer()
    wind.loop = true
    const windFilter = ctx.createBiquadFilter()
    windFilter.type = 'bandpass'
    windFilter.frequency.value = 900
    windFilter.Q.value = 0.7
    const windGain = ctx.createGain()
    windGain.gain.value = 0.05
    wind.connect(windFilter).connect(windGain).connect(drone)
    lfo(0.019, 500, windFilter.frequency)
    lfo(0.053, 0.03, windGain.gain)
    wind.start()

    // ---- Cues -------------------------------------------------------------
    const cues = ctx.createGain()
    cues.gain.value = 0.9
    cues.connect(master)
    const send = ctx.createGain()
    send.gain.value = 0.55
    cues.connect(send).connect(reverb)

    nodes = { master, drone, voices, sub, cues, white: whiteBuffer(), brown: wind.buffer }
  }

  /** Every ~20 s glide the drone to the next voicing. */
  function evolve() {
    if (!ctx || !nodes) return
    chordIndex = (chordIndex + 1) % CHORDS.length
    const chord = CHORDS[chordIndex]
    const t = ctx.currentTime
    nodes.voices.forEach((voice, i) => {
      for (const osc of voice.oscs) osc.frequency.setTargetAtTime(chord[i], t, 3.5)
    })
    nodes.sub.frequency.setTargetAtTime(chord[0] / 2, t, 3.5)
  }

  /** A faint, far-away beacon ping now and then. */
  function beacon() {
    if (!running) return
    const base = [1318.5, 1760, 1975.5][Math.floor(Math.random() * 3)]
    tone(base, { gain: 0.035, attack: 0.01, decay: 1.6, type: 'sine' })
    tone(base * 2, { gain: 0.008, attack: 0.01, decay: 0.9, type: 'sine', at: 0.24 })
    beaconTimer = setTimeout(beacon, 9000 + Math.random() * 9000)
  }

  /* ------------------------------------------------------------------------
   * Cue voices
   * ---------------------------------------------------------------------- */
  function tone(freq, { gain = 0.1, attack = 0.005, decay = 0.4, type = 'sine', at = 0, glide = 0 } = {}) {
    const t = ctx.currentTime + at
    const osc = ctx.createOscillator()
    const env = ctx.createGain()
    osc.type = type
    osc.frequency.setValueAtTime(freq, t)
    if (glide) osc.frequency.exponentialRampToValueAtTime(freq * glide, t + decay)
    env.gain.setValueAtTime(0.0001, t)
    env.gain.exponentialRampToValueAtTime(gain, t + attack)
    env.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay)
    osc.connect(env).connect(nodes.cues)
    osc.start(t)
    osc.stop(t + attack + decay + 0.05)
  }

  function noise({ buffer = nodes.white, type = 'bandpass', q = 1, from = 400, peak = 2400, to = 500, gain = 0.2, attack = 0.4, decay = 1, pan = 0 }) {
    const t = ctx.currentTime
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.loop = true
    const filter = ctx.createBiquadFilter()
    filter.type = type
    filter.Q.value = q
    filter.frequency.setValueAtTime(from, t)
    filter.frequency.exponentialRampToValueAtTime(peak, t + attack)
    filter.frequency.exponentialRampToValueAtTime(to, t + attack + decay)
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.0001, t)
    env.gain.exponentialRampToValueAtTime(gain, t + attack)
    env.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay)
    let chain = src.connect(filter).connect(env)
    if (pan && ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner()
      panner.pan.setValueAtTime(-pan, t)
      panner.pan.linearRampToValueAtTime(pan, t + attack + decay)
      chain = chain.connect(panner)
    }
    chain.connect(nodes.cues)
    src.start(t)
    src.stop(t + attack + decay + 0.1)
  }

  const CUES = {
    blip: () => tone(1480, { gain: 0.05, attack: 0.003, decay: 0.07, glide: 0.82 }),
    confirm: () => {
      tone(659.25, { gain: 0.09, decay: 0.9 })
      tone(987.77, { gain: 0.08, decay: 1.2, at: 0.11 })
      tone(1975.5, { gain: 0.012, decay: 1.1, at: 0.11 })
    },
    whoosh: () => noise({ q: 1.4, from: 260, peak: 2600, to: 420, gain: 0.12, attack: 0.5, decay: 1.1, pan: 0.6 }),
    ignition: () => {
      noise({ buffer: nodes.brown, type: 'lowpass', q: 0.5, from: 120, peak: 1400, to: 140, gain: 0.55, attack: 0.07, decay: 2.8 })
      noise({ type: 'highpass', q: 0.3, from: 2200, peak: 3400, to: 1800, gain: 0.03, attack: 0.05, decay: 1.4 })
      tone(52, { gain: 0.38, attack: 0.02, decay: 2.2, glide: 0.62 })
    },
  }

  function play(type) {
    if (!running || !nodes || !CUES[type]) return
    const now = performance.now()
    if (now - (lastCue[type] || 0) < (type === 'blip' ? 60 : 250)) return
    lastCue[type] = now
    try {
      CUES[type]()
    } catch {
      /* a failed cue must never break the page */
    }
  }

  /* ------------------------------------------------------------------------
   * Start / stop
   * ---------------------------------------------------------------------- */
  async function start() {
    if (!supported) return
    clearTimeout(suspendTimer)
    try {
      if (!ctx) {
        ctx = new AudioCtx({ latencyHint: 'playback' })
        build()
        evolveTimer = setInterval(evolve, 21000)
      }
      if (ctx.state !== 'running') await ctx.resume()
    } catch {
      return
    }
    if (!wanted) return // toggled off again while resuming
    running = true
    const t = ctx.currentTime
    nodes.master.gain.cancelScheduledValues(t)
    nodes.master.gain.setValueAtTime(nodes.master.gain.value, t)
    nodes.master.gain.setTargetAtTime(MASTER_LEVEL, t, 0.9) // slow swell in
    clearTimeout(beaconTimer)
    beaconTimer = setTimeout(beacon, 6000)
    notify()
  }

  function stop() {
    running = false
    clearTimeout(beaconTimer)
    if (ctx && nodes) {
      const t = ctx.currentTime
      nodes.master.gain.cancelScheduledValues(t)
      nodes.master.gain.setValueAtTime(nodes.master.gain.value, t)
      nodes.master.gain.setTargetAtTime(0, t, 0.28)
      clearTimeout(suspendTimer)
      suspendTimer = setTimeout(() => !running && ctx.suspend().catch(() => {}), 1600)
    }
    notify()
  }

  function setWanted(value) {
    wanted = Boolean(value) && supported
    writePref(wanted)
    emit('sound:state', { enabled: wanted })
    if (wanted) {
      start().then(() => play('confirm'))
    } else {
      stop()
    }
    notify()
  }

  // Remembered as on: wait for the visitor's next real gesture on the page.
  function armForGesture(ignore) {
    const events = ['click', 'keydown', 'touchend']
    const handler = (event) => {
      if (ignore && ignore.contains(event.target)) return // the toggle handles itself
      if (event.type === 'keydown' && (event.key === 'Escape' || event.key === 'Tab')) return
      events.forEach((type) => window.removeEventListener(type, handler, true))
      if (wanted && !running) start()
    }
    events.forEach((type) => window.addEventListener(type, handler, true))
  }

  on('sound:cue', (detail) => play(detail?.type))

  // Don't hum in a background tab.
  document.addEventListener('visibilitychange', () => {
    if (!ctx || !running) return
    if (document.hidden) ctx.suspend().catch(() => {})
    else ctx.resume().catch(() => {})
  })

  return {
    get state() {
      return { wanted, running, supported }
    },
    subscribe(fn) {
      listeners.add(fn)
      fn({ wanted, running, supported })
      return () => listeners.delete(fn)
    },
    toggle() {
      setWanted(!wanted)
    },
    armForGesture,
    play,
  }
}
