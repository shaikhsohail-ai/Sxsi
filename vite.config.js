import { defineConfig } from 'vite'
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.resolve(import.meta.dirname, 'src')

/**
 * Expands `<!-- @include sections/hero/hero.html -->` comments in index.html
 * with the partial's contents (resolved from /src). Keeps every section's
 * markup in static HTML (crawlable, works without JS) while letting each
 * section live in its own folder.
 */
function htmlPartials() {
  const INCLUDE = /<!--\s*@include\s+([\w./-]+)\s*-->/g

  const expand = (html, depth = 0) => {
    if (depth > 5) throw new Error('[html-partials] include depth exceeded')
    return html.replace(INCLUDE, (_, rel) => {
      const file = path.resolve(SRC, rel)
      if (!file.startsWith(SRC + path.sep)) throw new Error(`[html-partials] refusing to include ${rel}`)
      return expand(fs.readFileSync(file, 'utf8'), depth + 1)
    })
  }

  return {
    name: 'sxsi-html-partials',
    transformIndexHtml: { order: 'pre', handler: (html) => expand(html) },
    handleHotUpdate({ file, server }) {
      if (file.startsWith(SRC) && file.endsWith('.html')) {
        server.ws.send({ type: 'full-reload' })
        return []
      }
    },
  }
}

export default defineConfig({
  plugins: [htmlPartials()],
  build: {
    target: 'es2020',
    assetsInlineLimit: 4096,
    chunkSizeWarningLimit: 900,
  },
  server: { host: '127.0.0.1' },
  preview: { host: '127.0.0.1' },
})
