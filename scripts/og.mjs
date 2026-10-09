#!/usr/bin/env node
/**
 * Generates the social share image (public/og.png, 1200×630) from the live
 * hero scene, plus PNG app icons from public/favicon.svg.
 *
 *   npm run dev            # in another terminal
 *   node scripts/og.mjs --url http://127.0.0.1:5173/
 */
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const urlArg = argv[argv.indexOf('--url') + 1]
const url = new URL(argv.includes('--url') && urlArg ? urlArg : 'http://127.0.0.1:5173/')
url.searchParams.set('noboot', '1')

const root = path.resolve(import.meta.dirname, '..')
const publicDir = path.join(root, 'public')
const logoSvg = fs.readFileSync(path.join(publicDir, 'logo.svg'), 'utf8')
const faviconSvg = fs.readFileSync(path.join(publicDir, 'favicon.svg'), 'utf8')

const executablePath = fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome')
  ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
  : undefined

const browser = await chromium.launch({
  executablePath,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})

// ---- Social card ------------------------------------------------------------
{
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 })
  await page.goto(url.href, { waitUntil: 'networkidle', timeout: 90_000 })
  await page.waitForTimeout(4000)

  // Hide the live page UI, keep the hero's backdrop, lay our own type on top.
  await page.addStyleTag({
    content: `
      .s-nav, .skip-link, .s-hero__frame > :not(.s-hero__stage), .s-hero__reticle { visibility: hidden !important; }
      #og-card { position: fixed; inset: 0; z-index: 99999; pointer-events: none;
        display: flex; flex-direction: column; justify-content: space-between; padding: 64px 72px;
        color: #f4f6fb; font-family: var(--font-display); text-transform: uppercase;
        background: linear-gradient(180deg, rgba(0,0,0,.55), transparent 55%); }
      #og-card .og-logo svg { width: 190px; height: auto; color: #f4f6fb; fill: currentColor; }
      #og-card h1 { margin: 0; font-size: 88px; line-height: .9; font-stretch: 118%; font-weight: 700; letter-spacing: .01em; max-width: 900px; }
      #og-card .og-meta { display: flex; justify-content: space-between; font-family: var(--font-mono);
        font-size: 18px; letter-spacing: .24em; color: rgba(244,246,251,.75); }
      #og-card .og-meta b { color: #6fc3ff; font-weight: 500; }
    `,
  })
  await page.evaluate((logo) => {
    const card = document.createElement('div')
    card.id = 'og-card'
    card.innerHTML = `
      <div class="og-logo">${logo}</div>
      <h1>Intelligence,<br>beyond orbit.</h1>
      <div class="og-meta"><span>Super Intelligence. Launched.</span><b>www.sxsi.ai</b></div>`
    document.body.append(card)
  }, logoSvg)
  await page.waitForTimeout(600)
  await page.screenshot({ path: path.join(publicDir, 'og.png') })
  await page.close()
  console.log('wrote public/og.png')
}

// ---- App icons ----------------------------------------------------------------
const icons = [
  { file: 'apple-touch-icon.png', size: 180, scale: 1 },
  { file: 'icon-192.png', size: 192, scale: 1 },
  { file: 'icon-512.png', size: 512, scale: 1 },
]
for (const { file, size, scale } of icons) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 })
  const dataUri = `data:image/svg+xml;base64,${Buffer.from(faviconSvg).toString('base64')}`
  await page.setContent(`<html style="color-scheme:dark"><body style="margin:0;width:${size}px;height:${size}px;display:grid;place-items:center;
    background:#000">
    <img src="${dataUri}" style="width:${Math.round(size * scale)}px;height:${Math.round(size * scale)}px"></body></html>`)
  await page.waitForTimeout(200)
  await page.screenshot({ path: path.join(publicDir, file) })
  await page.close()
  console.log(`wrote public/${file}`)
}

await browser.close()
