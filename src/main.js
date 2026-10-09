import './styles/index.css'
import { initMotion, keepTriggersSorted, lockScroll, restoreScroll, settleScroll, sortTriggers, ScrollTrigger } from './lib/motion.js'
import { markBooted } from './lib/bus.js'

// Scroll restoring is ours (see "Reading position" in lib/motion.js): pins add
// thousands of px after load, so a remembered pixel lands in the wrong section.
if ('scrollRestoration' in history) history.scrollRestoration = 'manual'

// Every section's stylesheet is bundled up-front (no flash of unstyled content);
// their scripts are code-split and initialised in page order.
import.meta.glob('./sections/*/*.css', { eager: true })

// Section entry modules, in page order. Listed explicitly (not globbed) so helper
// modules and the hero's network worker never become stray main-thread chunks.
const SECTION_MODULES = {
  boot: () => import('./sections/boot/boot.js'),
  nav: () => import('./sections/nav/nav.js'),
  hero: () => import('./sections/hero/hero.js'),
  mission: () => import('./sections/mission/mission.js'),
  ascent: () => import('./sections/ascent/ascent.js'),
  fleet: () => import('./sections/fleet/fleet.js'),
  control: () => import('./sections/control/control.js'),
  manifest: () => import('./sections/manifest/manifest.js'),
  terminal: () => import('./sections/terminal/terminal.js'),
  join: () => import('./sections/join/join.js'),
  footer: () => import('./sections/footer/footer.js'),
}
const SECTIONS = Object.keys(SECTION_MODULES)

/**
 * Runs `callback` in a new task, queued behind work that is already waiting —
 * notably the hero's scene chunk (scheduler.yield() would jump ahead of it). A
 * posted message, unlike setTimeout, is neither clamped nor throttled in background tabs.
 */
function postTask(callback) {
  const { port1, port2 } = new MessageChannel()
  port1.onmessage = () => {
    port1.close()
    callback()
  }
  port2.postMessage(null)
}

/** Ends the current task, so the browser can paint and run queued work between inits. */
const yieldToBrowser = () => new Promise((resolve) => postTask(resolve))

/** Waits for a painted frame (capped at 100 ms — none come in a background tab). */
const afterPaint = () =>
  new Promise((resolve) => {
    requestAnimationFrame(() => postTask(resolve))
    setTimeout(resolve, 100)
  })

initMotion()

async function start() {
  // Start downloading every section in parallel...
  const pending = SECTIONS.map((name) => SECTION_MODULES[name]().catch((error) => ({ error })))

  // ...but initialise strictly in page order so pinned ScrollTriggers stack correctly.
  for (const [index, name] of SECTIONS.entries()) {
    const mod = await pending[index]
    try {
      if (mod?.error) throw mod.error
      await mod?.init?.()
    } catch (error) {
      console.error(`[sxsi] section "${name}" failed to initialise`, error)
      if (name === 'boot') dismissBoot()
    }
    // Everything above a #deep-link now has its pins: keep it in view meanwhile.
    restoreScroll()
    // The boot overlay is what's on screen: its countdown (or its dismissal) paints
    // before the heavier sections initialise.
    await (name === 'boot' ? afterPaint() : yieldToBrowser())
  }

  sortTriggers()
  ScrollTrigger.refresh()

  // A breakpoint flip (resize, rotation) rebuilds that query's pins at the end of
  // ScrollTrigger's list: from here on every refresh re-sorts first, so the triggers
  // below them include their spacing.
  keepTriggersSorted()

  // Land #deep-links and reloads on their section now that the pins exist.
  settleScroll()
}

/** The boot sequence couldn't run: hand the page back now, not at the CSS failsafe (~7.6 s). */
function dismissBoot() {
  document.documentElement.dataset.boot = 'done'
  document.querySelector('.s-boot')?.remove()
  lockScroll(false)
  markBooted()
}

start()

// Safety net: never leave the page waiting on a boot sequence that stalled. A boot
// still on screen calls markBooted itself on every exit, so it gets one extension.
let bootGrace = 1
setTimeout(function bootSafetyNet() {
  if (document.documentElement.dataset.boot === 'run' && bootGrace-- > 0) setTimeout(bootSafetyNet, 6000)
  else markBooted()
}, 6000)
