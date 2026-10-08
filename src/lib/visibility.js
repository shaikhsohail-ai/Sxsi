/**
 * Visibility helpers so render loops only run while their section is on
 * screen and the tab is visible.
 */

/**
 * Calls `callback(isVisible, entry)` whenever `el` enters/leaves the viewport.
 * Returns an unsubscribe function.
 */
export function observeVisibility(el, callback, { rootMargin = '0px', threshold = 0 } = {}) {
  if (!el || typeof IntersectionObserver === 'undefined') {
    callback(true)
    return () => {}
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) callback(entry.isIntersecting, entry)
    },
    { rootMargin, threshold },
  )
  io.observe(el)
  return () => io.disconnect()
}

/**
 * Runs `frame(timeSeconds, deltaSeconds)` on requestAnimationFrame, but only
 * while `el` is (nearly) in view and the document is visible.
 *
 *   const loop = createRenderLoop(section, (t, dt) => render(t, dt))
 *   loop.destroy() // when done
 */
export function createRenderLoop(el, frame, { rootMargin = '150px' } = {}) {
  let inView = false
  let rafId = 0
  let last = 0
  let destroyed = false

  const tick = (now) => {
    rafId = requestAnimationFrame(tick)
    const t = now / 1000
    const dt = last ? Math.min(t - last, 0.1) : 1 / 60
    last = t
    frame(t, dt)
  }

  const update = () => {
    const shouldRun = !destroyed && inView && document.visibilityState === 'visible'
    if (shouldRun && !rafId) {
      last = 0
      rafId = requestAnimationFrame(tick)
    } else if (!shouldRun && rafId) {
      cancelAnimationFrame(rafId)
      rafId = 0
    }
  }

  const unobserve = observeVisibility(
    el,
    (visible) => {
      inView = visible
      update()
    },
    { rootMargin },
  )
  document.addEventListener('visibilitychange', update)

  return {
    get running() {
      return Boolean(rafId)
    },
    destroy() {
      destroyed = true
      update()
      unobserve()
      document.removeEventListener('visibilitychange', update)
    },
  }
}
