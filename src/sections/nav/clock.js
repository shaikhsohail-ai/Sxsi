/**
 * One shared UTC mission clock for the chrome (nav, menu, footer, boot).
 * Ticks on the second boundary; a single timer no matter how many readouts.
 */
import { pad } from '../../lib/dom.js'

const subscribers = new Set()
let timer = 0

export const formatUtc = (date = new Date()) =>
  `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`

function tick() {
  const now = new Date()
  const text = formatUtc(now)
  for (const callback of subscribers) callback(text, now)
  // Re-align to the next whole second (setInterval drifts)
  timer = setTimeout(tick, 1000 - now.getMilliseconds() + 8)
}

/** Calls `callback(text, date)` now and every second. Returns an unsubscribe fn. */
export function onClock(callback) {
  subscribers.add(callback)
  callback(formatUtc(), new Date())
  if (!timer) timer = setTimeout(tick, 1000 - new Date().getMilliseconds() + 8)
  return () => {
    subscribers.delete(callback)
    if (!subscribers.size) {
      clearTimeout(timer)
      timer = 0
    }
  }
}

/** Keeps every element's textContent in sync with the clock. */
export function bindClock(elements) {
  const els = elements.filter(Boolean)
  if (!els.length) return () => {}
  return onClock((text) => {
    for (const el of els) if (el.textContent !== text) el.textContent = text
  })
}
