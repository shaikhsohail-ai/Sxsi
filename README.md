# SXSI — Super Intelligence. Launched.

The website for **[www.sxsi.ai](https://www.sxsi.ai)**: a cinematic, sci‑fi, space‑program‑inspired site for an artificial‑intelligence company. Pure black space, monumental type, real‑time WebGL, and scroll choreography from launch pad to orbit. *For the sky.*

## Quick start

```bash
npm install
npm run dev        # http://127.0.0.1:5173
npm run build      # production build → dist/
npm run preview    # serve the production build
```

Node 20+ required.

## What's on the page

| Section | Folder | What it is |
| --- | --- | --- |
| Boot | `src/sections/boot` | First‑visit flight‑computer boot + ignition countdown (skippable, once per session) |
| Nav | `src/sections/nav` | Fixed header, full‑screen menu, UTC mission clock, synthesized ambient sound (off by default) |
| Hero | `src/sections/hero` | WebGL orbital sunrise over a planet whose city lights form a neural network, plus a live countdown |
| Mission | `src/sections/mission` | Scroll‑lit manifesto and mission principles |
| Ascent | `src/sections/ascent` | Pinned, scroll‑driven launch from pad to orbit with live telemetry, each flight event mapped to a stage of building AI |
| Fleet | `src/sections/fleet` | The SXSI model "vehicles", shown as holograms with spec sheets |
| Mission Control | `src/sections/control` | Capability bento grid with live micro‑visualizations |
| Manifest | `src/sections/manifest` | Roadmap as a launch manifest, with mission patches generated from the data |
| Flight Computer | `src/sections/terminal` | An interactive command console (try `help`, `launch`) |
| Join | `src/sections/join` | Personalized crew boarding passes you can download and share, plus an optional waitlist |
| Footer | `src/sections/footer` | Sign‑off, links, legal line |

Each section is self‑contained: an HTML partial (inlined into `index.html` at build time, so all copy is static and crawlable), a scoped stylesheet, and a script exporting `init()`.

## Editing content

- **Dates, mission name, contact, socials, waitlist:** `src/config.js`
- **Copy:** the `.html` partial in each section folder
- **Design tokens (colors, type, spacing, easing):** `src/styles/tokens.css`
- **Shared components (buttons, labels, panels):** `src/styles/components.css`

### Waitlist

Sign‑ups are off by default. Set `WAITLIST_ENDPOINT` in `src/config.js` to any endpoint that accepts a CORS `POST` with JSON `{ name, email, source }` (Formspree, Basin, a serverless function, …) and the Join form will start collecting emails. While it's empty, the site only issues boarding passes and never claims anyone joined a list.

## Deploying to www.sxsi.ai

The build is a static folder (`dist/`), so it runs on any static host.

**GitHub Pages (included):** `.github/workflows/deploy.yml` builds and publishes on every push to `main`.

1. Repo **Settings → Pages → Source:** `GitHub Actions`.
2. `public/CNAME` already contains `www.sxsi.ai`.
3. At your DNS provider:
   - `www` → `CNAME` → `<your-github-username>.github.io`
   - apex `sxsi.ai` → `A` records `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153` (GitHub then redirects to `www`).
4. Back in Settings → Pages, tick **Enforce HTTPS** once the certificate is issued.

**Vercel / Netlify / Cloudflare Pages:** import the repo, build command `npm run build`, output directory `dist`, then add `www.sxsi.ai` as a custom domain.

## Tooling

- `npm run shot -- --url http://127.0.0.1:5173/ --selector '#ascent' --steps 6` takes headless screenshots across a section and prints console errors (see `scripts/shot.mjs` for options).
- `node scripts/og.mjs` regenerates the social share image and app icons from the live hero.

## Accessibility and performance

- Respects `prefers-reduced-motion`. You get a still, fully readable page with no pinned or scrubbed motion.
- Every section's text is in the static HTML. JavaScript only enhances it.
- Render loops pause when off screen. Pixel ratio and particle counts scale with device capability (`src/lib/quality.js`).

---

SXSI is an independent company and is not affiliated with Space Exploration Technologies Corp.
