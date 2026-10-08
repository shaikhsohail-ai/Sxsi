import './styles/index.css'
import { initMotion, ScrollTrigger } from './lib/motion.js'
import { markBooted } from './lib/bus.js'

// Every section's stylesheet is bundled up-front (no flash of unstyled content);
// their scripts are code-split and initialised in page order.
import.meta.glob('./sections/*/*.css', { eager: true })
const sectionModules = import.meta.glob('./sections/*/*.js')

const SECTIONS = ['boot', 'nav', 'hero', 'mission', 'ascent', 'fleet', 'control', 'manifest', 'terminal', 'join', 'footer']

initMotion()

async function start() {
  // Start downloading every section in parallel...
  const pending = SECTIONS.map((name) => {
    const load = sectionModules[`./sections/${name}/${name}.js`]
    return load ? load().catch((error) => ({ error })) : Promise.resolve(null)
  })

  // ...but initialise strictly in page order so pinned ScrollTriggers stack correctly.
  for (const [index, name] of SECTIONS.entries()) {
    const mod = await pending[index]
    try {
      if (mod?.error) throw mod.error
      await mod?.init?.()
    } catch (error) {
      console.error(`[sxsi] section "${name}" failed to initialise`, error)
      if (name === 'boot') markBooted()
    }
  }

  ScrollTrigger.sort()
  ScrollTrigger.refresh()
}

start()

// Safety net: never leave the page waiting on a boot sequence that stalled.
setTimeout(markBooted, 6000)
