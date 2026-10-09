/**
 * Glyph scramble: the label decodes left → right through random glyphs on
 * mouse hover / keyboard focus. Width is locked meanwhile so neighbours never
 * shift. Links using it carry an aria-label, so assistive tech never hears
 * the noise. No-op under reduced motion.
 */
import { reducedMotion } from '../../lib/quality.js'

const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/+#'

export function scramble(el, { duration = 460 } = {}) {
  if (reducedMotion || !el) return
  const text = (el.dataset.text ??= el.textContent)
  cancelAnimationFrame(el._scrambleRaf)
  if (!el._scrambling) el.style.width = `${el.getBoundingClientRect().width}px` // no reflow of neighbours
  el._scrambling = true
  const start = performance.now()
  let lastSwap = 0
  const step = (now) => {
    const p = Math.min(1, (now - start) / duration)
    if (now - lastSwap > 42 || p === 1) {
      lastSwap = now
      const settled = Math.floor(p * p * (text.length + 1)) // resolve left → right, easing in
      let out = ''
      for (let i = 0; i < text.length; i++) {
        out += i < settled || text[i] === ' ' ? text[i] : GLYPHS[(Math.random() * GLYPHS.length) | 0]
      }
      el.textContent = out
    }
    if (p < 1) el._scrambleRaf = requestAnimationFrame(step)
    else {
      el.textContent = text
      el.style.width = ''
      el._scrambling = false
    }
  }
  el._scrambleRaf = requestAnimationFrame(step)
}

export function initScramble(els) {
  for (const el of els) {
    const link = el.closest('a, button') || el
    link.addEventListener('pointerenter', (event) => event.pointerType === 'mouse' && scramble(el))
    link.addEventListener('focus', () => link.matches(':focus-visible') && scramble(el))
  }
}
