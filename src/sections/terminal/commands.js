/**
 * Flight computer command set. Every reply is scripted here — the console
 * matches a short list of keywords and never generates text.
 *
 * `createCommands(api)` returns { exec(raw), abort(), names, launching }.
 * `api` is supplied by terminal.js:
 *   print(nodes, opts)  queue output (typewriter)        clear()
 *   sleep(ms)           real-time wait                    emit(type, detail)
 *   history()           submitted commands (oldest first) visible()  console on screen?
 *   fx.arm(bool) · fx.ignite() → Promise (T−0 liftoff) · fx.rain(ms) · setMode(text)
 *   handoff()           plan the scroll to #ascent → { autopilot, go() } | null
 *   reducedMotion · touch (coarse pointer: no keyboard hints)
 */
import { NEXT_MISSION, COORDINATES, CONTACT_EMAIL, SHARE, SITE, SOCIAL } from '../../config.js'
import { pad } from '../../lib/dom.js'
import { h, line, tone, em, cmd, head, gap, dot, row, link } from './printer.js'

/** Listed in `help`, offered by Tab completion and the "did you mean" hint. */
export const PUBLIC = [
  ['help', 'List commands'],
  ['status', 'Run a systems check'],
  ['mission', 'Brief on the next mission'],
  ['fleet', 'The vehicles on the roadmap'],
  ['manifest', 'Every mission, in order'],
  ['launch', 'Start a T−10 countdown'],
  ['about', 'What SXSI is'],
  ['contact', 'Open a channel to the crew · --copy copies the email'],
  ['share', 'Broadcast sxsi.ai on X'],
  ['date', 'UTC mission clock (also: time)'],
  ['whoami', 'Your crew record'],
  ['coordinates', 'Launch site (simulated)'],
  ['clear', 'Clear the screen (Ctrl+L)'],
]
export const COMPLETIONS = [...PUBLIC.map(([name]) => name), 'time']

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MISSION_NUMBER = NEXT_MISSION?.number ?? '002'
const titleCase = (text) => String(text).toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase())
const MISSION_NAME = titleCase(NEXT_MISSION?.name ?? 'Ignition')
const PAD = NEXT_MISSION?.pad ?? 'LC-01'

/* Fleet registry — mirrors the copy in the Fleet section. Roadmap, not product. */
const FLEET = [
  { num: '01', name: 'Nova', orbit: 'Low orbit', role: 'Compact · built for the edge', status: 'In development', kind: 'ok' },
  { num: '02', name: 'Vector', orbit: 'Transfer orbit', role: 'Agentic · intelligence with a heading', status: 'Planned', kind: 'idle' },
  { num: '03', name: 'Apogee', orbit: 'High orbit', role: 'Frontier reasoning', status: 'Planned', kind: 'idle' },
  { num: '04', name: 'Zenith', orbit: null, role: null, status: 'Classified', kind: 'live' },
]

/* Manifest fallback (copy kept in step with manifest.html) — the Manifest
   section's markup is the source of truth and is read first (see readManifest). */
const MANIFEST = [
  { number: '001', name: 'First Light', status: 'complete', window: 'Q4 2026', objective: 'sxsi.ai goes live and the mission is announced. The first signal leaves the pad.' },
  { number: '002', name: 'Ignition', status: 'active', window: '01 Jan 2027', objective: 'Assemble the crew. Secure the compute. Light the engines.' },
  { number: '003', name: 'Ascent', status: 'planned', window: '2027', objective: 'First model flight test. Leave the pad, measure everything, publish what we learn.' },
  { number: '004', name: 'Orbit', status: 'planned', window: 'NET 2028', objective: 'Public release of the fleet. Intelligence in a stable orbit, built for anyone to reach.' },
  { number: '005', name: 'Beyond', status: 'tbd', window: 'TBD', objective: 'Superintelligence research, done safely. Past the edge of the map, with safety as the flight rule — not a footnote.' },
]
const STATUS_LABEL = { complete: ['Complete', 'ok'], active: ['In progress', 'live'], planned: ['Planned', 'idle'], tbd: ['TBD', 'idle'] }

/* Countdown call-outs, T−10 … T−01. Original copy. */
const CALLOUTS = [
  'Flight computer to launch mode',
  'Range is green',
  'Guidance is internal',
  'Weights loaded · checksums verified',
  'Evaluation suite: go',
  'Safety interlocks armed',
  'Compute at full thrust',
  'Ignition sequence start',
  'Go for launch',
  'All systems go',
]

/* ------------------------------------------------------------------------ */

const clean = (text) => (text || '').replace(/\s+/g, ' ').trim()

function readManifest() {
  const items = Array.from(document.querySelectorAll('#manifest [data-mission]'))
  if (!items.length) return MANIFEST
  return items.map((item) => {
    const number = item.dataset.number || ''
    const known = MANIFEST.find((m) => m.number === number) || {}
    const windowEl = item.querySelector('[data-mission-date], .s-manifest__window .hud-value')
    return {
      number,
      status: item.dataset.status || known.status || 'planned',
      name: clean(item.querySelector('[data-mission-name]')?.textContent) || known.name || `Mission ${number}`,
      window: clean(windowEl?.textContent) || known.window || 'TBD',
      objective: clean(item.querySelector('.s-manifest__objective')?.textContent) || known.objective,
    }
  })
}

const target = () => {
  const t = Date.parse(NEXT_MISSION?.launchAt)
  return Number.isFinite(t) ? t : null
}

/**
 * "T− 084D 02:41:10". Once the target passes the count holds at T− 000D
 * 00:00:00 — never T+: nothing is claimed to have launched (same rule as the
 * hero and the manifest).
 */
export function formatCountdown(now = Date.now()) {
  const at = target()
  if (at == null) return 'T− TBD'
  let s = Math.floor(Math.max(0, at - now) / 1000)
  const d = Math.floor(s / 86400)
  s -= d * 86400
  return `T− ${pad(d, 3)}D ${pad(s / 3600)}:${pad((s % 3600) / 60)}:${pad(s % 60)}`
}

/** True once the mission's target time has passed (the window is open, awaiting an update). */
export function windowOpen(now = Date.now()) {
  const at = target()
  return at != null && at <= now
}

const formatDate = (ms) => {
  const d = new Date(ms)
  return `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

function formatCoords() {
  // Brand fiction: open North Atlantic, no real facility (see config.js).
  const lat = Number(COORDINATES?.lat ?? 31.4159)
  const lon = Number(COORDINATES?.lon ?? -42.7183)
  return { lat: `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}`, lon: `${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? 'E' : 'W'}` }
}

/** Small Levenshtein distance for "did you mean". */
function distance(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= b.length; j++) {
      const temp = dp[j]
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = temp
    }
  }
  return dp[b.length]
}

/** Own-key lookup: command tables must never answer with Object.prototype members. */
const has = (table, key) => Object.hasOwn(table, key)

const th = (node) => (node.classList.add('t-row--th'), node)
const kv = (key, ...value) => row('kv', em('dim', key), h('span', 't-cell', ...value))
const status = (kind, text) => h('span', 't-cell t-state', dot(kind), text)
const anchor = (text, hash) => {
  const a = h('a', 't-link', text)
  a.href = hash
  return a
}
const redacted = (size = '') => {
  const bar = h('span', `t-redact ${size}`, h('span', 'sr-only', 'Redacted'))
  return h('span', 't-cell', bar)
}

/* ------------------------------------------------------------------------ */

export function createCommands(api) {
  const { print, sleep, emit } = api
  const bootedAt = performance.now()
  let launch = null // { abort } while a countdown runs

  const echo = (raw) =>
    h(
      'p',
      't-line t-echo',
      h('span', 't-ps1', h('span', 't-ps1__user', 'sxsi@orbit'), h('span', 't-ps1__sep', ':'), h('span', 't-ps1__path', '~'), h('span', 't-ps1__sign', '$')),
      ' ',
      raw,
    )

  /* ---- Commands ---------------------------------------------------------- */
  const COMMANDS = {
    help() {
      return print([
        head('Available commands'),
        ...PUBLIC.map(([name, desc]) => row('help', cmd(name), em('dim', desc))),
        gap(),
        api.touch
          ? tone('dim', 'Tap a command below, or type one and press Enter.')
          : tone('dim', 'Keys: ↑ ↓ history · Tab completes · Ctrl+L clears · Esc cancels'),
      ])
    },

    status() {
      const { lat, lon } = formatCoords()
      return print([
        head('Systems check ', em('dim', '· simulated')),
        th(row('status', em('dim', 'Subsystem'), em('dim', 'State'), em('dim', 'Note'))),
        row('status', 'Guidance', status('ok', 'Nominal'), em('dim', 'Heading: up')),
        row('status', 'Propulsion', status('ok', 'Nominal'), em('dim', 'Ambition at full thrust')),
        row('status', 'Navigation', status('ok', 'Nominal'), em('dim', `${lat} ${lon}`)),
        row('status', 'Comms', status('ok', 'Nominal'), em('dim', `Ground link to ${SITE?.domain ?? 'sxsi.ai'}`)),
        row('status', 'Life support', status('ok', 'Nominal'), em('dim', 'Coffee reserves holding')),
        row('status', 'Safety', status('ok', 'Armed'), em('dim', 'Interlocks before altitude')),
        row('status', 'Payload', status('idle', 'Building'), em('dim', `Mission ${MISSION_NUMBER} · ${MISSION_NAME}`)),
        gap(),
        tone('accent', 'All systems nominal. Go for launch.'),
      ])
    },

    mission() {
      const at = target()
      const known = readManifest().find((m) => m.number === MISSION_NUMBER)
      return print([
        head(`Mission ${MISSION_NUMBER} · ${MISSION_NAME}`),
        kv('Status', dot('live'), 'In progress'),
        kv('Pad', PAD),
        kv('Target', at ? `${formatDate(at)} · ${pad(new Date(at).getUTCHours())}:${pad(new Date(at).getUTCMinutes())} UTC` : 'TBD'),
        kv('Count', em('ignite', formatCountdown()), windowOpen() ? em('dim', ' · window open, awaiting update') : null),
        kv('Objective', known?.objective || 'Assemble the crew. Secure the compute. Light the engines.'),
        gap(),
        line('Board it: type ', cmd('contact'), ', or head to ', anchor('Join the mission', '#join'), '.'),
        tone('dim', 'Target dates are aspirational and will move.'),
      ])
    },

    fleet() {
      return print([
        head('Fleet registry ', em('dim', `· ${pad(FLEET.length)} vehicles`)),
        ...FLEET.map((v) =>
          row(
            'fleet',
            em('dim', v.num),
            h('span', 't-cell t-strong', v.name),
            v.orbit ? em('dim', v.orbit) : redacted('t-redact--short'),
            v.role ? h('span', 't-cell', v.role) : redacted('t-redact--long'),
            status(v.kind, v.status),
          ),
        ),
        gap(),
        tone('dim', 'Vehicles are roadmap, not shipped products. Specs are design targets.'),
        line('Inspect them in ', anchor('The fleet', '#fleet'), '.'),
      ])
    },

    manifest() {
      const missions = readManifest()
      const flown = missions.filter((m) => m.status === 'complete').length
      return print([
        head('Launch manifest ', em('dim', `· ${pad(missions.length, 3)} missions · ${pad(flown, 2)} flown`)),
        ...missions.flatMap((m) => {
          const [label, kind] = STATUS_LABEL[m.status] || STATUS_LABEL.planned
          const nodes = [row('manifest', em('dim', m.number), h('span', 't-cell t-strong', m.name), status(kind, label), em('dim', m.window))]
          if (m.objective) nodes.push(h('p', 't-line t-dim t-indent', m.objective))
          return nodes
        }),
        gap(),
        tone('dim', 'Windows are targets, not promises. The destination is fixed.'),
      ])
    },

    launch: () => runLaunch(),

    about() {
      return print([
        head('About SXSI'),
        line('SXSI is an independent artificial intelligence company.'),
        line('We build intelligence the way a space program builds vehicles: ambitious targets, relentless testing, every system checked before launch.'),
        gap(),
        line('Early stage. Building toward superintelligence, with safety as the flight rule.'),
        tone('dim', 'Not affiliated with any space agency or launch provider.'),
        tone('accent', SITE?.motto || 'For the sky.'),
      ])
    },

    // The visitor's clipboard is theirs: it is only written on request (`contact --copy`).
    async contact(args = []) {
      const nodes = [head('Open channel'), kv('Email', link(CONTACT_EMAIL, `mailto:${CONTACT_EMAIL}`, { external: false }))]
      for (const [name, url] of Object.entries(SOCIAL || {})) {
        if (url && /^https:\/\//.test(url)) nodes.push(kv(name === 'x' ? 'X' : name[0].toUpperCase() + name.slice(1), link(url.replace(/^https:\/\/(www\.)?/, ''), url)))
      }
      nodes.push(gap(), line('Select the address to open your mail client.'))
      if (args.some((arg) => arg === '--copy' || arg === '-c' || arg === 'copy')) {
        let copied = false
        try {
          if (navigator.clipboard) {
            await navigator.clipboard.writeText(CONTACT_EMAIL)
            copied = true
          }
        } catch {
          copied = false
        }
        nodes.push(copied ? tone('dim', 'Address copied to your clipboard.') : tone('dim', 'Clipboard unavailable. Select the address above to copy it.'))
      } else {
        nodes.push(line(em('dim', 'Want it on your clipboard? Type '), cmd('contact --copy'), em('dim', '.')))
      }
      emit('sound:cue', { type: 'confirm' })
      return print(nodes)
    },

    share() {
      const url = `https://x.com/intent/post?text=${encodeURIComponent(SHARE?.text ?? '')}&url=${encodeURIComponent(SHARE?.url ?? '')}`
      try {
        window.open(url, '_blank', 'noopener,noreferrer')
      } catch {
        /* popup blocked — the link below still works */
      }
      emit('sound:cue', { type: 'confirm' })
      return print([
        head('Broadcast'),
        line('Opening a post window on X…'),
        tone('dim', `“${SHARE?.text ?? ''}”`),
        line('Nothing opened? ', link('Post it yourself', url), '.'),
      ])
    },

    date() {
      const now = new Date()
      const start = Date.UTC(now.getUTCFullYear(), 0, 1)
      const day = Math.floor((now.getTime() - start) / 86400000) + 1
      const leap = new Date(Date.UTC(now.getUTCFullYear(), 1, 29)).getUTCDate() === 29
      const met = Math.floor((performance.now() - bootedAt) / 1000)
      return print([
        head('Mission clock ', em('dim', '· UTC')),
        kv('Date', `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`),
        kv('Time', `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())} UTC`),
        kv('Day', `${pad(day, 3)} of ${leap ? 366 : 365}`),
        kv('MET', `T+ ${pad(met / 3600)}:${pad((met % 3600) / 60)}:${pad(met % 60)}`, em('dim', ' · since you came aboard')),
      ])
    },

    whoami() {
      return print([
        line('crew member, unassigned'),
        tone('dim', 'Clearance: visitor · Seat: open · Badge: pending'),
        line('Claim a seat in ', anchor('Join the mission', '#join'), '.'),
      ])
    },

    coordinates() {
      const { lat, lon } = formatCoords()
      return print([
        head('Launch site ', em('dim', '· simulated')),
        kv('Pad', PAD),
        kv('Latitude', lat),
        kv('Longitude', lon),
        tone('dim', 'Brand coordinates. The real launch site is wherever the crew is working.'),
      ])
    },

    clear() {
      api.clear()
    },

    /* ---- Off the manual ------------------------------------------------ */
    sudo: () => print(line(em('warn', 'Permission denied. '), 'Superintelligence is earned, not granted.')),
    'ad astra': () => print([line('Per aspera.'), tone('dim', 'Through hardship, to the stars.')]),
    hello: () => print([line('Hello, crew member. Ground is listening.'), tone('dim', 'Type help to begin.')]),
    42: () => print([line('The answer, confirmed.'), tone('dim', 'Now we are building something that can tell us the question.')]),
    ping: () => runPing(),
    matrix: () => runMatrix(),
    exit: () => print(line('There is no exit. Only ascent.')),
    ls: () =>
      print([
        line('mission.txt   fleet/   manifest.log   launch.sh   ', em('dim', '.classified')),
        tone('dim', 'Files are above your clearance. The commands are not — type help.'),
      ]),
    cat: () => print(line(em('warn', 'Access denied. '), 'Clearance level: visitor. Try ', cmd('mission'), ' instead.')),
    rm: () => print(line(em('warn', 'Refused. '), 'Flight software is write-protected. Nice try.')),
    echo: (args, raw) => print(line(raw.replace(/^\s*echo\s?/i, '') || '\u00a0')),
    history() {
      const list = api.history()
      if (!list.length) return print(tone('dim', 'No history yet.'))
      return print(list.slice(-20).map((entry, i, arr) => row('history', em('dim', pad(list.length - arr.length + i + 1, 3)), entry)))
    },
    abort: () => print(tone('dim', 'Nothing to abort. All quiet on the pad.')),
    sxsi: () => {
      const svg = api.banner?.()
      return print([
        svg ? h('div', 't-banner t-banner--echo', svg) : null,
        tone('accent', SITE?.tagline || 'Super Intelligence. Launched.'),
        tone('dim', SITE?.motto || 'For the sky.'),
      ])
    },
    weather: () => print([line('Launch weather: 100% go.'), tone('dim', 'Simulated. We do not own a weather balloon. Yet.')]),
    'open the pod bay doors': () => print([line('Pod bay doors are not on this console.'), tone('dim', 'It is scripted — no HAL aboard.')]),
  }

  // Aliases. Lookups go through `has()` so input such as `constructor` or
  // `__proto__` never resolves to an Object.prototype member.
  const ALIASES = {
    time: 'date',
    '?': 'help',
    man: 'help',
    commands: 'help',
    hi: 'hello',
    hey: 'hello',
    hola: 'hello',
    quit: 'exit',
    logout: 'exit',
    hold: 'abort',
    dir: 'ls',
    cls: 'clear',
    banner: 'sxsi',
    'adastra': 'ad astra',
    'ad astra.': 'ad astra',
    'per aspera ad astra': 'ad astra',
    'open the pod bay doors, hal': 'open the pod bay doors',
  }

  /* ---- Launch ------------------------------------------------------------ */
  function countdownBoard() {
    const num = h('span', 't-count__num', 'T−10')
    const label = h('span', 't-count__label', 'Count in progress')
    const fill = h('span', 't-count__fill')
    const bar = h('span', 't-count__bar', fill)
    const meta = h('span', 't-count__meta', `Mission ${MISSION_NUMBER} · Pad ${PAD} · Simulated`)
    const node = h('div', 't-count', h('span', 't-count__top', num, label), bar, meta)
    node.setAttribute('aria-hidden', 'true')
    return {
      node,
      set(t, progress) {
        num.textContent = `T−${pad(t)}`
        fill.style.setProperty('--p', progress)
        if (!api.reducedMotion && typeof num.animate === 'function') {
          num.animate([{ opacity: 0.35, filter: 'blur(3px)' }, { opacity: 1, filter: 'blur(0)' }], { duration: 380, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' })
        }
      },
      hold() {
        node.classList.add('is-hold')
        label.textContent = 'Hold'
      },
      liftoff() {
        node.classList.add('is-liftoff')
        num.textContent = 'Liftoff'
        label.textContent = 'T+00'
        fill.style.setProperty('--p', 1)
      },
    }
  }

  async function runLaunch() {
    if (launch) return print(tone('warn', 'Countdown already running. Type abort to hold.'))
    let aborted = false
    let wake = null
    const tick = (ms) =>
      new Promise((resolve) => {
        const id = setTimeout(resolve, ms)
        wake = () => {
          clearTimeout(id)
          resolve()
        }
      })
    launch = {
      abort() {
        aborted = true
        wake?.()
      },
    }

    api.fx.arm(true)
    api.setMode('Countdown')
    await print([
      head('Launch sequence ', em('dim', `· Mission ${MISSION_NUMBER} · simulated`)),
      tone('dim', 'Esc, Ctrl+C or abort holds the count.'),
    ])
    let board = null
    let t = 10
    if (!aborted) {
      board = countdownBoard()
      await print(board.node)
    }
    while (!aborted && t > 0) {
      board.set(t, (11 - t) / 10)
      print(row('count', em('ignite', `T−${pad(t)}`), CALLOUTS[10 - t]))
      if (t > 1) emit('sound:cue', { type: 'blip' })
      await tick(1000)
      if (!aborted) t--
    }

    if (aborted) {
      board?.hold()
      api.fx.arm(false)
      api.setMode('Interactive')
      launch = null
      await print([tone('warn', `Hold. Hold. Hold. Count stopped at T−${pad(t)}.`), tone('dim', 'Recycling to T−10. Type launch to go again.')])
      return
    }

    board.liftoff()
    emit('sound:cue', { type: 'ignition' })
    launch = null // past the point of no hold
    // The ASCII vehicle climbs out of the screen while the call-outs print.
    const flight = api.fx.ignite()
    await print([tone('ignite', 'Ignition. Liftoff.'), line('Intelligence is ascending.')])
    await Promise.all([flight, sleep(api.reducedMotion ? 900 : 0)])
    await print(tone('dim', 'Tower clear. Vehicle is supersonic.'))
    await sleep(500)

    const handoff = api.visible() ? api.handoff() : null
    if (handoff) {
      await print([
        tone('dim', 'Handing over to ascent tracking ↑'),
        handoff.autopilot ? tone('dim', 'Autopilot engaged — scroll at any time to take manual control.') : null,
      ])
      emit('sound:cue', { type: 'whoosh' })
      await sleep(api.reducedMotion ? 600 : 450)
      handoff.go()
    } else {
      await print(tone('dim', 'Follow the vehicle in the ascent profile, up the page.'))
    }
    await sleep(1200)
    api.fx.arm(false)
    api.setMode('Interactive')
  }

  /* ---- Ping (simulated light-lag to low orbit) ---------------------------- */
  async function runPing() {
    const altitude = 408 // km — the same orbit the hero HUD reads out
    const floor = ((2 * altitude) / 299792.458) * 1000 // round trip at c, ms
    await print(line(`PING ground → orbit (${altitude} km) · 56 bytes · `, em('dim', 'simulated')))
    const times = []
    for (let seq = 0; seq < 4; seq++) {
      await sleep(380)
      const ms = floor + 0.4 + Math.random() * 1.6
      times.push(ms)
      print(line(`64 bytes from orbit: seq=${seq} time=${ms.toFixed(2)} ms`))
    }
    await sleep(200)
    const avg = times.reduce((a, b) => a + b, 0) / times.length
    return print([
      tone('dim', `--- 4 sent · 4 received · 0% loss · avg ${avg.toFixed(2)} ms · light-speed floor ${floor.toFixed(2)} ms`),
      tone('accent', 'pong'),
    ])
  }

  /* ---- Matrix ------------------------------------------------------------ */
  async function runMatrix() {
    if (api.reducedMotion) {
      return print([line('Rain suppressed — reduced motion is on.'), tone('dim', 'There is no spoon either.')])
    }
    await api.fx.rain(2000)
    return print([line('Wake up, crew member.'), tone('dim', 'Wrong film. Follow the rocket, not the rabbit.')])
  }

  /* ---- Dispatch ---------------------------------------------------------- */
  function resolve(raw) {
    const lower = raw.toLowerCase().replace(/\s+/g, ' ').trim()
    if (has(ALIASES, lower)) return { name: ALIASES[lower], args: [] }
    if (has(COMMANDS, lower) && lower.includes(' ')) return { name: lower, args: [] }
    const [first, ...args] = lower.split(' ')
    const name = has(ALIASES, first) ? ALIASES[first] : first
    if (name === 'rm' || lower.startsWith('rm ')) return { name: 'rm', args }
    return { name, args }
  }

  function unknown(raw, input) {
    const name = String(input ?? '')
    const words = raw.trim().split(/\s+/).length
    if (/[?]/.test(raw) || words >= 4) {
      return print([
        line(em('warn', 'Not understood. '), 'This is a scripted flight computer, not an AI model — it only knows a short list of commands.'),
        line('Type ', cmd('help'), ' to see them.'),
      ])
    }
    const best = COMPLETIONS.map((candidate) => [candidate, distance(name, candidate)]).sort((a, b) => a[1] - b[1])[0]
    const nodes = [line(em('warn', 'Command not found: '), name.slice(0, 40))]
    if (best && best[1] <= 2) nodes.push(line('Did you mean ', cmd(best[0]), '?'))
    else nodes.push(line('Type ', cmd('help'), ' for the list.'))
    return print(nodes)
  }

  return {
    names: COMPLETIONS,
    get launching() {
      return Boolean(launch)
    },

    /** Echo + run one line of input. Resolves when its output has printed. */
    async exec(raw) {
      const text = String(raw).slice(0, 80)
      print(echo(text))
      if (!text.trim()) return
      const { name, args } = resolve(text)

      if (launch) {
        if (name === 'abort' || name === 'exit') return launch.abort()
        if (name === 'clear') return api.clear()
        return print(tone('warn', 'Countdown in progress. Type abort to hold.'))
      }

      const handler = has(COMMANDS, name) ? COMMANDS[name] : null
      emit('sound:cue', { type: 'blip' })
      if (!handler) return unknown(text, name)
      return handler(args, text)
    },

    /** Ctrl+C: echo the line with ^C and hold any countdown. */
    interrupt(text = '') {
      print(echo(`${String(text).slice(0, 80)}^C`))
      launch?.abort()
    },

    /** Hold the countdown (Esc). Returns true if one was running. */
    abort() {
      if (!launch) return false
      launch.abort()
      return true
    },
  }
}
