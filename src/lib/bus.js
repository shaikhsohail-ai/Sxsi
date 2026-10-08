/**
 * Tiny cross-section event bus.
 *
 * Known events:
 *   'boot:done'                       — boot overlay finished (see `booted`)
 *   'sound:cue'   { type }            — ask the sound system to play a cue
 *                                       ('ignition' | 'blip' | 'whoosh' | 'confirm')
 *   'sound:state' { enabled }         — sound toggled on/off
 *   'menu:state'  { open }            — overlay menu opened/closed
 */
const target = new EventTarget()

export function emit(type, detail) {
  target.dispatchEvent(new CustomEvent(type, { detail }))
}

/** Subscribe; returns an unsubscribe function. */
export function on(type, handler) {
  const listener = (event) => handler(event.detail)
  target.addEventListener(type, listener)
  return () => target.removeEventListener(type, listener)
}

let resolveBooted
/** Resolves once the boot sequence has finished (or was skipped). */
export const booted = new Promise((resolve) => (resolveBooted = resolve))

/** Marks the boot sequence complete. Safe to call more than once. */
export function markBooted() {
  const root = document.documentElement
  if (root.dataset.booted === 'true') return
  root.dataset.booted = 'true'
  resolveBooted()
  emit('boot:done')
}
