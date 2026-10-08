#!/usr/bin/env node
/**
 * Visual QA helper — screenshots the running site with headless Chromium
 * (software WebGL) and reports console / page errors.
 *
 *   node scripts/shot.mjs --url http://127.0.0.1:5173/ --selector '#ascent' --steps 6 --out shots/ascent
 *   node scripts/shot.mjs --mobile --selector '#hero'
 *   node scripts/shot.mjs --y 0,900,1800            # explicit scroll positions
 *   node scripts/shot.mjs                           # whole page, one shot per viewport height
 *
 * Options
 *   --url <url>         page to load (default http://127.0.0.1:5173/). `noboot=1` is appended
 *                       unless --boot is passed.
 *   --out <dir>         output directory (default ./shots)
 *   --name <prefix>     filename prefix (default derived from selector / "page")
 *   --mobile            390×844 touch viewport (iPhone-ish), DPR 1
 *   --width/--height    custom viewport (default 1440×900)
 *   --selector <css>    shoot across this element's scroll span (pin spacer aware)
 *   --steps <n>         number of evenly spaced shots across the selector span (default 4)
 *   --y <list>          comma separated absolute scroll positions
 *   --wait <ms>         wait after load (default 2500)
 *   --settle <ms>       wait after each scroll (default 1400)
 *   --reduced           emulate prefers-reduced-motion: reduce
 *   --boot              keep the boot sequence (don't append noboot=1)
 *   --full              also save a full-page screenshot
 *   --max <n>           max shots for whole-page mode (default 30)
 */
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const args = {}
for (let i = 0; i < argv.length; i++) {
  const key = argv[i]
  if (!key.startsWith('--')) continue
  const name = key.slice(2)
  const next = argv[i + 1]
  if (next === undefined || next.startsWith('--')) args[name] = true
  else {
    args[name] = next
    i++
  }
}

const url = new URL(args.url || 'http://127.0.0.1:5173/')
if (!args.boot) url.searchParams.set('noboot', '1')
const outDir = path.resolve(args.out || 'shots')
fs.mkdirSync(outDir, { recursive: true })

const mobile = Boolean(args.mobile)
const viewport = mobile
  ? { width: 390, height: 844 }
  : { width: Number(args.width) || 1440, height: Number(args.height) || 900 }
const waitMs = Number(args.wait ?? 2500)
const settleMs = Number(args.settle ?? 1400)
const prefix =
  args.name || (args.selector ? String(args.selector).replace(/[^a-z0-9]+/gi, '') : 'page') + (mobile ? '-m' : '')

const executablePath = fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome')
  ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
  : undefined

const browser = await chromium.launch({
  executablePath,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const context = await browser.newContext({
  viewport,
  deviceScaleFactor: 1,
  isMobile: mobile,
  hasTouch: mobile,
  reducedMotion: args.reduced ? 'reduce' : 'no-preference',
})
const page = await context.newPage()

const logs = []
page.on('console', (msg) => {
  if (msg.type() === 'error' || msg.type() === 'warning') logs.push(`[console.${msg.type()}] ${msg.text()}`)
})
page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`))
page.on('requestfailed', (req) => logs.push(`[requestfailed] ${req.url()} — ${req.failure()?.errorText}`))

const t0 = Date.now()
await page.goto(url.href, { waitUntil: 'networkidle', timeout: 90_000 })
await page.waitForTimeout(waitMs)

const scrollTo = async (y) => {
  await page.evaluate((top) => {
    const lenis = window.__sxsi?.lenis
    if (lenis) lenis.scrollTo(top, { immediate: true, force: true })
    else window.scrollTo(0, top)
  }, y)
  await page.waitForTimeout(settleMs)
}

const docHeight = await page.evaluate(() => document.documentElement.scrollHeight)
let positions = []

if (args.y) {
  positions = String(args.y)
    .split(',')
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isFinite(v))
} else if (args.selector) {
  const span = await page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const box = (el.parentElement?.classList.contains('pin-spacer') ? el.parentElement : el).getBoundingClientRect()
    return { top: box.top + window.scrollY, height: box.height }
  }, args.selector)
  if (!span) {
    console.error(`Selector not found: ${args.selector}`)
    await browser.close()
    process.exit(1)
  }
  const steps = Math.max(1, Number(args.steps) || 4)
  const start = span.top
  const end = span.top + Math.max(0, span.height - viewport.height)
  positions = Array.from({ length: steps }, (_, i) => Math.round(steps === 1 ? start : start + ((end - start) * i) / (steps - 1)))
} else {
  const max = Number(args.max) || 30
  for (let y = 0; y < docHeight && positions.length < max; y += viewport.height) positions.push(y)
}

const files = []
for (const [i, y] of positions.entries()) {
  await scrollTo(y)
  const file = path.join(outDir, `${prefix}-${String(i).padStart(2, '0')}-y${y}.png`)
  await page.screenshot({ path: file })
  files.push(file)
}

if (args.full) {
  await scrollTo(0)
  const file = path.join(outDir, `${prefix}-full.png`)
  await page.screenshot({ path: file, fullPage: true })
  files.push(file)
}

await browser.close()

console.log(
  JSON.stringify(
    { url: url.href, viewport, docHeight, positions, files, errors: logs, seconds: (Date.now() - t0) / 1000 },
    null,
    2,
  ),
)
