#!/usr/bin/env node
/**
 * Generates the social share image (public/og.png, 1200×630) from the live
 * hero scene, a lightweight progressive JPEG of it for link previews
 * (public/og.jpg — what og:image points at), plus PNG app icons from
 * public/favicon.svg.
 *
 *   npm run dev            # in another terminal
 *   node scripts/og.mjs --url http://127.0.0.1:5173/
 *   node scripts/og.mjs --jpeg-only        # re-encode og.jpg from the existing og.png
 *   node scripts/og.mjs --out /tmp/og      # write somewhere other than public/
 *
 * Why a JPEG: the photographic PNG is ~500 KB, and some preview consumers
 * (WhatsApp at ~300 KB) skip or downscale images that large. The JPEG is
 * re-encoded from the PNG (progressive, q85, 4:2:0) with Python + Pillow or
 * ImageMagick, whichever is installed; without either it falls back to the
 * browser's baseline JPEG encoder.
 */
import { chromium } from 'playwright'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const option = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null
}
const url = new URL(option('--url') || 'http://127.0.0.1:5173/')
url.searchParams.set('noboot', '1')
const jpegOnly = argv.includes('--jpeg-only')

const root = path.resolve(import.meta.dirname, '..')
const publicDir = path.join(root, 'public')
const outDir = path.resolve(option('--out') || publicDir)
fs.mkdirSync(outDir, { recursive: true })

const JPEG_QUALITY = 85
const pngPath = path.join(outDir, 'og.png')
const jpgPath = path.join(outDir, 'og.jpg')

/** Re-encodes og.png as a progressive JPEG; returns the encoder used, or null. */
function encodeJpeg(src, dest) {
  const pillow = `
import sys
from PIL import Image
Image.open(sys.argv[1]).convert('RGB').save(sys.argv[2], 'JPEG', quality=${JPEG_QUALITY}, progressive=True, optimize=True, subsampling=2)
`
  const encoders = [
    ['Pillow', 'python3', ['-c', pillow, src, dest]],
    ['ImageMagick', 'magick', [src, '-strip', '-interlace', 'Plane', '-sampling-factor', '4:2:0', '-quality', String(JPEG_QUALITY), dest]],
    ['ImageMagick', 'convert', [src, '-strip', '-interlace', 'Plane', '-sampling-factor', '4:2:0', '-quality', String(JPEG_QUALITY), dest]],
  ]
  for (const [name, cmd, args] of encoders) {
    const result = spawnSync(cmd, args, { stdio: 'ignore' })
    if (result.status === 0 && fs.existsSync(dest)) return name
  }
  return null
}

const shortPath = (file) => (path.relative(root, file).startsWith('..') ? file : path.relative(root, file))
const report = (file) => console.log(`wrote ${shortPath(file)} (${Math.round(fs.statSync(file).size / 1024)} KB)`)

if (jpegOnly) {
  if (!fs.existsSync(pngPath)) {
    console.error(`no ${shortPath(pngPath)} to re-encode — run without --jpeg-only first`)
    process.exit(1)
  }
  const encoder = encodeJpeg(pngPath, jpgPath)
  if (!encoder) {
    console.error('no JPEG encoder found (install Python + Pillow or ImageMagick, or run without --jpeg-only)')
    process.exit(1)
  }
  report(jpgPath)
  process.exit(0)
}

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
  // Wait for the hero scene (or its static fallback) rather than a fixed delay:
  // software GL on a busy machine can take a while to show the first frame.
  await page
    .waitForFunction(() => document.querySelector('.s-hero')?.matches('.is-webgl, .is-fallback'), null, { timeout: 60_000 })
    .catch(() => console.warn('hero scene not ready after 60 s — capturing anyway'))
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
  await page.screenshot({ path: pngPath })
  report(pngPath)

  if (!encodeJpeg(pngPath, jpgPath)) {
    console.warn('no Pillow / ImageMagick: og.jpg falls back to a baseline (non-progressive) JPEG')
    await page.screenshot({ path: jpgPath, type: 'jpeg', quality: JPEG_QUALITY })
  }
  report(jpgPath)
  await page.close()
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
  await page.screenshot({ path: path.join(outDir, file) })
  await page.close()
  report(path.join(outDir, file))
}

await browser.close()
