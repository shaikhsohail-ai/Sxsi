/**
 * Output for the flight computer: safe DOM builders + a typewriter printer.
 *
 * Text only ever enters the DOM through `textContent` / text nodes, so
 * visitor input can be echoed back verbatim without being parsed as HTML.
 *
 * The typewriter: each printed line is appended to the log in full (screen
 * readers get whole lines through the role="log" live region, never
 * character spam), then revealed visually with a stepped clip-path — one
 * step per character, so it reads as typing. Lines follow each other with a
 * slight overlap. Any keypress calls `skip()` to land the rest instantly.
 */

/**
 * Tiny element builder. Children may be strings (become text nodes), nodes,
 * arrays, or null/false (skipped).
 *
 *   h('div', 't-line', 'T−', h('span', 't-ignite', '10'))
 */
export function h(tag, className, ...children) {
  const node = document.createElement(tag)
  if (className) node.className = className
  append(node, children)
  return node
}

function append(node, children) {
  for (const child of children) {
    if (child == null || child === false) continue
    if (Array.isArray(child)) append(node, child)
    else node.append(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child)
  }
}

/* ---- Output vocabulary ------------------------------------------------- */
/** A plain output line. */
export const line = (...parts) => h('p', 't-line', ...parts)
/** A line with a tone: 'dim' | 'head' | 'accent' | 'ok' | 'warn' | 'ignite' | 'err'. */
export const tone = (name, ...parts) => h('p', `t-line t-${name}`, ...parts)
/** Inline span with a tone. */
export const em = (name, text) => h('span', `t-${name}`, text)
/** A command name, styled as code. */
export const cmd = (text) => h('span', 't-cmd', text)
/** Section heading inside output, e.g. "SYSTEMS CHECK · SIMULATED". */
export const head = (...parts) => h('p', 't-line t-head', ...parts)
/** Empty spacer line. */
export const gap = () => h('p', 't-line t-gap', '\u00a0')
/** Tiny nominal dot. */
export const dot = (kind = 'ok') => {
  const node = h('span', `t-dot t-dot--${kind}`)
  node.setAttribute('aria-hidden', 'true')
  return node
}
/**
 * A table row. `variant` selects a fixed column template in CSS so every row
 * of the same table lines up even though rows are printed one at a time.
 */
export const row = (variant, ...cells) =>
  h('div', `t-row t-row--${variant}`, ...cells.map((cell) => (cell instanceof Node ? cell : h('span', 't-cell', cell))))
/** External link (opens in a new tab). Only ever pass trusted URLs. */
export function link(text, href, { external = true } = {}) {
  const a = h('a', 't-link', text)
  a.href = href
  if (external) {
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
  }
  return a
}

/* ---- Printer ----------------------------------------------------------- */
/**
 * @param {object} o
 * @param {HTMLElement} o.log        role="log" container lines are appended to
 * @param {HTMLElement} o.scroller   scrolling viewport to keep pinned to the end
 * @param {boolean}     o.instant    no typewriter (reduced motion)
 * @param {(node) => void} [o.onLine]  called for every appended line
 * @param {(busy: boolean) => void} [o.onBusy]
 */
const SCROLLBACK = 320 // lines kept in the log, like a terminal's buffer

export function createPrinter({ log, scroller, instant = false, onLine, onBusy }) {
  let chain = Promise.resolve()
  let pending = 0
  let skipping = false
  let epoch = 0 // bumped by clear() so queued lines from before it are dropped
  const anims = new Set()
  const waits = new Set()

  const nearEnd = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 64
  const toEnd = () => {
    scroller.scrollTop = scroller.scrollHeight
  }

  // A wait that `skip()` can cut short.
  const wait = (ms) =>
    new Promise((resolve) => {
      if (skipping || ms <= 0) return resolve()
      const entry = { resolve, id: setTimeout(() => done(), ms) }
      const done = () => {
        clearTimeout(entry.id)
        waits.delete(entry)
        resolve()
      }
      entry.resolve = done
      waits.add(entry)
    })

  function reveal(node) {
    const length = node.textContent.length
    if (instant || skipping || !length || typeof node.animate !== 'function') return 0
    const steps = Math.max(1, Math.min(length, 72))
    const duration = Math.min(620, Math.max(90, length * 9))
    const anim = node.animate(
      [{ clipPath: 'inset(-6px 100% -6px -6px)' }, { clipPath: 'inset(-6px -12px -6px -6px)' }],
      { duration, easing: `steps(${steps}, end)` },
    )
    anims.add(anim)
    const forget = () => anims.delete(anim)
    anim.addEventListener('finish', forget)
    anim.addEventListener('cancel', forget)
    return duration
  }

  async function run(nodes, pace, at) {
    for (const node of nodes) {
      if (at !== epoch) return
      const stick = nearEnd()
      log.append(node)
      while (log.childElementCount > SCROLLBACK) log.firstElementChild.remove()
      onLine?.(node)
      const duration = reveal(node)
      if (stick) toEnd()
      if (duration) await wait(duration * pace)
    }
  }

  return {
    /**
     * Queue lines for output. Resolves once they are all on screen.
     * `pace` = how far into a line's reveal the next one starts (0..1).
     */
    print(nodes, { pace = 0.55 } = {}) {
      const list = (Array.isArray(nodes) ? nodes : [nodes]).flat(Infinity).filter(Boolean)
      if (!list.length) return chain
      pending++
      onBusy?.(true)
      const at = epoch
      chain = chain
        .then(() => run(list, pace, at))
        .catch((error) => console.error('[terminal] print failed', error))
        .finally(() => {
          pending--
          if (!pending) {
            skipping = false
            onBusy?.(false)
          }
        })
      return chain
    },

    /** Land everything that's queued or mid-reveal immediately. */
    skip() {
      if (!pending && !anims.size) return
      skipping = true
      for (const entry of [...waits]) entry.resolve()
      for (const anim of [...anims]) anim.finish()
      toEnd()
    },

    /** Resolves when the queue is empty. */
    idle: () => chain,

    clear() {
      epoch++
      this.skip()
      log.replaceChildren()
      toEnd()
    },

    scrollToEnd: toEnd,
    get busy() {
      return pending > 0
    },
  }
}
