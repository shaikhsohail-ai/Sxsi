/**
 * Join — the boarding gate and finale.
 *
 *  · Crew registration form → a personalised, holographic boarding pass
 *    (live preview while typing, "printed" on submit), with download / share.
 *  · Optional waitlist POST, only when WAITLIST_ENDPOINT is configured.
 *  · A shader sunrise behind the whole section, scrubbed by scroll, that
 *    crests the limb under "FOR THE SKY.".
 *
 * All copy lives in join.html; this file only enhances it. User input is only
 * ever written with textContent / attributes — never innerHTML.
 */
import { gsap, ScrollTrigger, scrollToTarget } from '../../lib/motion.js'
import { emit } from '../../lib/bus.js'
import { hasWebGL, reducedMotion } from '../../lib/quality.js'
import { createRenderLoop, observeVisibility } from '../../lib/visibility.js'
import { $, $$, clamp, lerp, pad } from '../../lib/dom.js'
import { CONTACT_EMAIL, NEXT_MISSION, SHARE, WAITLIST_ENDPOINT } from '../../config.js'
import {
  NAME_MAX,
  createPass,
  guillochePath,
  matrixCodePath,
  normaliseName,
  samplePass,
  validateEmail,
  validateName,
} from './pass-data.js'

const GLYPHS = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789'
const PLACEHOLDER_NAME = 'Your name here'

export function init() {
  const root = document.getElementById('join')
  if (!root) return

  const motion = !reducedMotion
  if (motion) root.classList.remove('s-join--static')

  hydrateConfig(root)
  const pass = createPassView(root, motion)
  const tilt = motion ? initTilt(root) : null
  const actions = initActions(root, pass)
  initForm(root, { pass, tilt, actions, motion })
  initSky(root, motion)
  if (motion) initReveals(root)
}

/* --------------------------------------------------------------------------
 * Config → markup (keeps the static copy in sync with src/config.js)
 * ------------------------------------------------------------------------ */
function hydrateConfig(root) {
  const sample = samplePass()
  const values = { ...sample, pad: NEXT_MISSION.pad, missionName: titleCase(sample.missionName) }
  for (const el of $$('[data-join-c]', root)) {
    const value = values[el.dataset.joinC]
    if (value != null) el.textContent = value
  }

  const contact = $('[data-join-contact]', root)
  if (contact && CONTACT_EMAIL) {
    contact.href = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent('Hello from sxsi.ai')}`
  }
  const x = $('[data-join-x]', root)
  if (x) {
    const params = new URLSearchParams({ text: SHARE.text, url: SHARE.url })
    x.href = `https://x.com/intent/post?${params.toString().replace(/\+/g, '%20')}`
  }
  const copyInput = $('#join-copy-url', root)
  if (copyInput) copyInput.value = SHARE.url
}

const titleCase = (s) => s.charAt(0) + s.slice(1).toLowerCase()

/* --------------------------------------------------------------------------
 * The pass
 * ------------------------------------------------------------------------ */
function createPassView(root, motion) {
  const el = $('[data-join-pass]', root)
  const nameEl = $('[data-join-name]', el)
  const chip = $('[data-join-chip]', el)
  const rosette = $('[data-join-rosette]', el)
  const rosetteSvg = rosette.closest('svg')
  const code = $('[data-join-code]', el)
  const codeSvg = code.closest('svg')
  const flown = $('[data-join-flown]', el)
  const scan = $('[data-join-scan]', el)
  const stamp = $('[data-join-stamp]', el)
  const fields = $$('[data-join-f]', el)

  let current = samplePass()
  let timeline = null
  const decoders = []

  const setFields = (data) => {
    for (const f of fields) {
      const value = data[f.dataset.joinF]
      if (value == null) continue
      f.textContent = f.dataset.joinF === 'missionName' ? titleCase(value) : value
    }
  }

  // Shrink long names to fit their line (measured, so it works in both layouts).
  const fitName = () => {
    el.style.setProperty('--s-join-fit', '1')
    const overflow = nameEl.scrollWidth / Math.max(1, nameEl.clientWidth)
    if (overflow > 1) el.style.setProperty('--s-join-fit', (0.98 / overflow).toFixed(3))
  }

  const setName = (name) => {
    nameEl.textContent = name || PLACEHOLDER_NAME
    el.classList.toggle('has-name', Boolean(name))
    fitName()
  }

  const drawArt = (seed) => {
    rosette.setAttribute('d', guillochePath(seed, { detail: 0.8 }))
    code.setAttribute('d', matrixCodePath(seed))
  }

  setFields(current)
  drawArt(current.seed)
  flown.style.strokeDashoffset = '1'

  // Re-fit when the card's width changes (e.g. landscape ⇄ portrait layouts).
  // Height is ignored: fitting the name can change it in portrait.
  let fittedWidth = 0
  new ResizeObserver(([entry]) => {
    const width = Math.round(entry.contentRect.width)
    if (width === fittedWidth) return
    fittedWidth = width
    fitName()
  }).observe(el)

  return {
    el,
    get data() {
      return current
    },
    get issued() {
      return el.classList.contains('is-issued')
    },

    /** Live preview while typing (draft state). */
    preview(raw) {
      const name = normaliseName(raw).toLocaleUpperCase().slice(0, 64)
      const changed = name !== nameEl.textContent
      setName(name)
      // Each keystroke "prints": a brief ion glow off the print head.
      if (motion && changed && name) {
        nameEl.animate(
          [{ textShadow: '0 0 14px rgba(111, 195, 255, 0.8)' }, { textShadow: '0 0 0 rgba(111, 195, 255, 0)' }],
          { duration: 700, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
        )
      }
    },

    setTyping(on) {
      el.classList.toggle('is-typing', on)
    },

    /** Back to an unissued draft (e.g. the name was edited after issuing). */
    toDraft() {
      timeline?.kill()
      decoders.splice(0).forEach((tween) => tween.kill())
      current = samplePass()
      el.classList.remove('is-issued')
      el.classList.add('is-draft')
      chip.textContent = 'Preview'
      setFields(current)
      drawArt(current.seed)
      gsap.set(stamp, { clearProps: 'all' })
      flown.style.strokeDashoffset = '1'
      el.setAttribute('aria-label', 'Crew boarding pass, preview')
    },

    /** Prints `data` onto the card. Resolves when the animation has landed. */
    issue(data, { onStamp } = {}) {
      timeline?.kill()
      decoders.splice(0).forEach((tween) => tween.kill())
      current = data
      setName(data.name)
      drawArt(data.seed)
      el.setAttribute('aria-label', `Crew boarding pass for ${data.name}`)

      const land = () => {
        setFields(data)
        chip.textContent = 'Issued'
        el.classList.remove('is-draft')
        el.classList.add('is-issued')
      }

      if (!motion) {
        land()
        flown.style.strokeDashoffset = '0'
        onStamp?.()
        return Promise.resolve()
      }

      const scrambles = fields.filter((f) => ['crewId', 'seat', 'group'].includes(f.dataset.joinF))
      return new Promise((resolve) => {
        timeline = gsap
          .timeline({ onComplete: resolve })
          // Print head sweeps the card
          .fromTo(scan, { xPercent: -100, opacity: 1 }, { xPercent: 640, duration: 1.15, ease: 'power2.inOut' }, 0)
          .set(scan, { opacity: 0 })
          // Rosette blooms from its centre, the code prints column by column
          .fromTo(rosetteSvg, { clipPath: 'circle(0% at 50% 50%)' }, { clipPath: 'circle(72% at 50% 50%)', duration: 1.6, ease: 'expo.out' }, 0.05)
          .fromTo(codeSvg, { clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0% 0 0)', duration: 0.9, ease: 'steps(19)' }, 0.35)
          // Ascent profile flies itself
          .fromTo(flown, { strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: 1.3, ease: 'power3.inOut' }, 0.15)
          .call(() => scrambles.forEach((f, i) => decoders.push(scramble(f, data[f.dataset.joinF], 0.75 + i * 0.08))), null, 0.1)
          .call(land, null, 0.95)
          .fromTo(
            stamp,
            { scale: 1.8, rotate: -15, opacity: 0 },
            { scale: 1, rotate: -8, opacity: 0.92, duration: 0.42, ease: 'power4.in' },
            1.05,
          )
          .call(() => onStamp?.(), null, 1.47)
          .fromTo(el, { y: 0 }, { y: 3, duration: 0.08, yoyo: true, repeat: 1, ease: 'power2.out' }, 1.47)
          .set([rosetteSvg, codeSvg], { clearProps: 'clipPath' })
      })
    },
  }
}

/** Departure-board decode: random glyphs resolving left to right. */
function scramble(el, finalText, duration = 0.8) {
  const chars = [...String(finalText)]
  const state = { p: 0 }
  let frame = 0
  return gsap.to(state, {
    p: 1,
    duration,
    ease: 'power1.inOut',
    onUpdate() {
      if (frame++ % 2) return // ~30 glyph changes per second reads better than 60
      const revealed = Math.floor(state.p * chars.length)
      el.textContent = chars
        .map((c, i) => (i < revealed || c === ' ' || c === '-' ? c : GLYPHS[(Math.random() * GLYPHS.length) | 0]))
        .join('')
    },
    onComplete() {
      el.textContent = finalText
    },
  })
}

/* --------------------------------------------------------------------------
 * Pointer tilt + holographic foil
 * ------------------------------------------------------------------------ */
function initTilt(root) {
  const stage = $('[data-join-stage]', root)
  const tiltEl = $('[data-join-tilt]', root)
  const sheen = $('[data-join-sheen]', root)
  const glare = $('[data-join-glare]', root)
  const narrow = matchMedia('(max-width: 720px)')

  const s = { tx: 0, ty: 0, x: 0, y: 0, hover: 0, h: 0, flash: 0 }
  let rect = null

  stage.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'touch') return
    rect ||= stage.getBoundingClientRect()
    s.tx = clamp(((event.clientX - rect.left) / rect.width) * 2 - 1, -1, 1)
    s.ty = clamp(((event.clientY - rect.top) / rect.height) * 2 - 1, -1, 1)
    s.hover = 1
  })
  stage.addEventListener('pointerleave', () => {
    s.hover = 0
    rect = null
  })
  // Only invalidate on scroll/resize; the rect is re-read lazily on the next move.
  const invalidate = () => (rect = null)
  window.addEventListener('scroll', invalidate, { passive: true })
  window.addEventListener('resize', invalidate)

  createRenderLoop(stage, (t, dt) => {
    const k = 1 - Math.exp(-dt * 5.5)
    // A slow idle sway keeps the foil alive on touch screens and at rest.
    const idleX = Math.sin(t * 0.45) * 0.42
    const idleY = Math.cos(t * 0.33) * 0.3
    s.h = lerp(s.h, s.hover, k)
    s.x = lerp(s.x, lerp(idleX, s.tx, s.h), k)
    s.y = lerp(s.y, lerp(idleY, s.ty, s.h), k)

    const restX = narrow.matches ? 4 : 7
    const restY = narrow.matches ? -4 : -9
    const range = narrow.matches ? 7 : 12
    tiltEl.style.transform = `rotateX(${(restX - s.y * range * 0.7).toFixed(2)}deg) rotateY(${(restY + s.x * range).toFixed(2)}deg)`
    sheen.style.transform = `translate3d(${(-s.x * 20 + s.flash * 34).toFixed(2)}%, ${(-s.y * 10).toFixed(2)}%, 0)`
    glare.style.transform = `translate3d(${(s.x * 22).toFixed(2)}%, ${(s.y * 22).toFixed(2)}%, 0)`
  })

  return {
    /** A bright foil sweep across the card (used when a pass is issued). */
    flash() {
      gsap.fromTo(s, { flash: -1.4 }, { flash: 1.4, duration: 1.4, ease: 'power2.inOut', onComplete: () => (s.flash = 0) })
    },
  }
}

/* --------------------------------------------------------------------------
 * Form
 * ------------------------------------------------------------------------ */
function initForm(root, { pass, tilt, actions, motion }) {
  const form = $('[data-join-form]', root)
  const nameInput = $('#join-name', root)
  const emailField = $('[data-join-field="email"]', root)
  const emailInput = $('#join-email', root)
  const submit = $('[data-join-submit]', root)
  const submitLabel = $('[data-join-submit-label]', root)
  const count = $('[data-join-count]', root)
  const note = $('[data-join-note]', root)
  const lead = $('[data-join-lead]', root)
  const waitlist = $('[data-join-waitlist]', root)
  const stage = $('[data-join-stage]', root)
  const live = $('[data-join-live]', root)
  const ctaLabel = $('[data-join-cta-label]', root)
  const finaleCrew = $('[data-join-finale-crew]', root)
  const hasWaitlist = Boolean(String(WAITLIST_ENDPOINT || '').trim())

  // The submit button ends on a check mark once the pass is out.
  const setSubmit = (label, done = false) => {
    submitLabel.textContent = label
    submit.classList.toggle('is-done', done)
  }

  let busy = false
  let issuedName = ''
  let sentEmail = ''
  let passInView = false
  observeVisibility(stage, (visible) => (passInView = visible), { threshold: 0.55 })

  // Copy for the configured mode. Without an endpoint nothing claims a sign-up.
  if (hasWaitlist) {
    emailField.hidden = false
    emailInput.disabled = false
    lead.textContent =
      'Every mission begins with a crew. Give the flight computer your callsign and it will print your boarding pass for ' +
      `Mission ${NEXT_MISSION.number}. Add your email to join the waitlist.`
    note.textContent =
      'Your pass is printed in your browser. If you add an email, it is sent to our waitlist so we can write when there’s ' +
      `news, and nothing else. Mission ${NEXT_MISSION.number} is a planned milestone on our roadmap, not a scheduled flight.`
  }

  const announce = (message) => {
    // Clear first so repeating the same message is still announced.
    live.textContent = ''
    requestAnimationFrame(() => (live.textContent = message))
  }

  const setError = (input, message) => {
    const field = input.closest('[data-join-field]')
    const error = $('[data-join-error]', field)
    const hint = `${input.id}-hint`
    if (message) {
      error.textContent = message
      error.hidden = false
      input.setAttribute('aria-invalid', 'true')
      input.setAttribute('aria-describedby', `${error.id} ${hint}`)
    } else {
      error.textContent = ''
      error.hidden = true
      input.removeAttribute('aria-invalid')
      input.setAttribute('aria-describedby', hint)
    }
  }

  nameInput.addEventListener('input', () => {
    const value = nameInput.value
    count.textContent = pad(Math.min([...value].length, NAME_MAX))
    if (nameInput.getAttribute('aria-invalid') === 'true') setError(nameInput, validateName(value))

    const upper = normaliseName(value).toLocaleUpperCase()
    if (pass.issued && upper !== issuedName) {
      // Editing an issued pass returns it to draft until it's reissued.
      pass.toDraft()
      actions.hide()
      issuedName = ''
      setSubmit('Reissue boarding pass')
      if (ctaLabel) ctaLabel.textContent = 'Claim your seat'
      if (finaleCrew) finaleCrew.hidden = true
    }
    pass.preview(value)
  })
  nameInput.addEventListener('focus', () => pass.setTyping(true))
  nameInput.addEventListener('blur', () => pass.setTyping(false))

  // Finale CTA: glide back to the form and hand focus to the callsign field —
  // or, once a pass is issued, back to the pass itself.
  $('[data-join-cta]', root)?.addEventListener('click', (event) => {
    event.preventDefault()
    const navH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--nav-h')) || 72
    const issued = pass.issued
    scrollToTarget(issued ? stage : $('.s-join__intake', root), { offset: -(navH + 32) })
    const target = issued ? pass.el : nameInput
    setTimeout(() => target.focus({ preventScroll: true }), motion ? 1100 : 0)
  })

  emailInput.addEventListener('input', () => {
    if (emailInput.getAttribute('aria-invalid') === 'true') setError(emailInput, validateEmail(emailInput.value))
    const pending = emailInput.value.trim() && emailInput.value.trim() !== sentEmail
    if (pass.issued) setSubmit(pending ? 'Join waitlist' : 'Pass issued', !pending)
  })

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (busy) return

    const nameError = validateName(nameInput.value)
    const emailError = hasWaitlist ? validateEmail(emailInput.value) : ''
    setError(nameInput, nameError)
    if (hasWaitlist) setError(emailInput, emailError)
    if (nameError || emailError) {
      ;(nameError ? nameInput : emailInput).focus()
      announce(nameError || emailError)
      return
    }

    const data = createPass(nameInput.value)
    const email = hasWaitlist ? emailInput.value.trim() : ''
    const alreadyIssued = pass.issued && data.name === issuedName

    busy = true
    submit.classList.add('is-busy')
    submit.setAttribute('aria-disabled', 'true')

    if (!alreadyIssued) {
      setSubmit('Printing…')
      announce('Printing your boarding pass.')
      nameInput.readOnly = true
      form.setAttribute('aria-busy', 'true')

      // Bring the card into view first (on phones it sits above the form).
      if (!passInView) {
        scrollToTarget(stage, { offset: -96, duration: motion ? 1.1 : undefined })
        if (motion) await wait(900)
      }

      await pass.issue(data, {
        onStamp: () => {
          emit('sound:cue', { type: 'confirm' })
          tilt?.flash()
        },
      })
      issuedName = data.name
      // The finale remembers who is on board.
      if (finaleCrew) {
        finaleCrew.textContent = `Crew ${data.name} · Seat ${data.seat}`
        finaleCrew.hidden = false
      }
      nameInput.readOnly = false
      form.removeAttribute('aria-busy')
      actions.show(motion)
      pass.el.focus({ preventScroll: true })
      announce(
        `Boarding pass issued for ${data.name}. Crew ID ${data.crewId}, seat ${data.seat}, Mission ${data.missionNumber} ${data.missionName}. ` +
          'Download or share it with the buttons below the pass.',
      )
    }

    let sent = true
    if (email && email !== sentEmail) {
      // The waitlist gets the name as typed; the pass prints it in capitals.
      sent = await sendWaitlist({ name: normaliseName(nameInput.value), email })
      if (sent) sentEmail = email
    } else if (alreadyIssued) {
      tilt?.flash()
      announce('Your boarding pass is already issued. Download or share it with the buttons below the pass.')
    }

    setSubmit(sent ? 'Pass issued' : 'Retry transmission', sent)
    if (ctaLabel) ctaLabel.textContent = 'View your pass'
    submit.classList.remove('is-busy')
    submit.removeAttribute('aria-disabled')
    busy = false
  })

  async function sendWaitlist({ name, email }) {
    const setState = (state, message) => {
      waitlist.hidden = false
      waitlist.dataset.state = state
      waitlist.textContent = message
    }
    setState('sending', 'Transmitting to mission control…')
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 12000)
      const response = await fetch(WAITLIST_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ name, email, source: 'sxsi.ai' }),
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      setState('ok', 'Confirmed. You’re on the waitlist. We’ll write before launch.')
      announce('Confirmed. You are on the waitlist.')
      emit('sound:cue', { type: 'blip' })
      return true
    } catch {
      const fallback = CONTACT_EMAIL ? ` or write to ${CONTACT_EMAIL}` : ''
      setState('error', `Transmission failed. Your pass is safe. Submit again to retry${fallback}.`)
      announce(`Waitlist transmission failed. Your pass is safe. Submit again to retry${fallback}.`)
      return false
    }
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* --------------------------------------------------------------------------
 * Download / share / copy
 * ------------------------------------------------------------------------ */
function initActions(root, pass) {
  const wrap = $('[data-join-actions]', root)
  const hint = $('[data-join-hint]', root)
  const download = $('[data-join-download]', root)
  const downloadLabel = $('[data-join-download-label]', root)
  const copy = $('[data-join-copy]', root)
  const copyLabel = $('[data-join-copy-label]', root)
  const share = $('[data-join-share]', root)
  const copyFallback = $('[data-join-copy-fallback]', root)
  const live = $('[data-join-live]', root)

  const announce = (message) => {
    live.textContent = ''
    requestAnimationFrame(() => (live.textContent = message))
  }

  // Briefly swap a button label, then restore its original text.
  const originals = new Map([downloadLabel, copyLabel].map((el) => [el, el.textContent.trim()]))
  const timers = new Map()
  const flashLabel = (el, text, ms = 2200) => {
    el.textContent = text
    clearTimeout(timers.get(el))
    timers.set(el, setTimeout(() => (el.textContent = originals.get(el)), ms))
  }

  const fileName = () => `sxsi-boarding-pass-${pass.data.crewId.toLowerCase()}.png`

  async function renderBlob() {
    const { renderPassImage, toBlob } = await import('./pass-image.js')
    return toBlob(await renderPassImage(pass.data))
  }

  download.addEventListener('click', async () => {
    if (download.getAttribute('aria-disabled') === 'true') return
    download.setAttribute('aria-disabled', 'true')
    downloadLabel.textContent = 'Rendering…'
    try {
      const blob = await renderBlob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = fileName()
      document.body.append(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 4000)
      flashLabel(downloadLabel, 'Pass saved')
      announce('Boarding pass image downloaded.')
      emit('sound:cue', { type: 'blip' })
    } catch (error) {
      console.error('[sxsi] join: pass image failed', error)
      flashLabel(downloadLabel, 'Try again')
      announce('Sorry, the pass image could not be created. Please try again.')
    } finally {
      download.removeAttribute('aria-disabled')
    }
  })

  copy.addEventListener('click', async () => {
    const ok = await copyText(SHARE.url)
    if (ok) {
      copyFallback.hidden = true
      flashLabel(copyLabel, 'Link copied')
      announce('Link copied to clipboard.')
      emit('sound:cue', { type: 'blip' })
    } else {
      copyFallback.hidden = false
      const input = $('input', copyFallback)
      input.focus()
      input.select()
      announce('Copy the link from the field below the buttons.')
    }
  })

  // Native share sheet with the image attached, where the platform supports it.
  let canShareFiles = false
  try {
    canShareFiles = Boolean(navigator.canShare?.({ files: [new File([''], 'pass.png', { type: 'image/png' })] }))
  } catch {
    canShareFiles = false
  }
  if (canShareFiles) {
    share.hidden = false
    share.addEventListener('click', async () => {
      try {
        const blob = await renderBlob()
        const file = new File([blob], fileName(), { type: 'image/png' })
        await navigator.share({ files: [file], title: 'My SXSI boarding pass', text: SHARE.text, url: SHARE.url })
      } catch (error) {
        if (error?.name !== 'AbortError') announce('Sharing isn’t available right now. Try downloading the pass instead.')
      }
    })
  }

  return {
    show(animate) {
      hint.hidden = true
      wrap.hidden = false
      if (animate) {
        gsap.fromTo(
          $$('.s-join__act:not([hidden])', wrap),
          { opacity: 0, y: 14 },
          { opacity: 1, y: 0, duration: 0.9, ease: 'expo.out', stagger: 0.07 },
        )
      }
    },
    hide() {
      wrap.hidden = true
      copyFallback.hidden = true
      hint.hidden = false
    },
  }
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    // Fall through to the legacy path (older browsers, insecure contexts).
  }
  const area = document.createElement('textarea')
  area.value = value
  area.setAttribute('readonly', '')
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none'
  document.body.append(area)
  area.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  area.remove()
  return ok
}

/* --------------------------------------------------------------------------
 * Sky
 * ------------------------------------------------------------------------ */
function initSky(root, motion) {
  const canvas = $('[data-join-canvas]', root)
  if (!canvas || !hasWebGL()) return

  const state = { rise: motion ? 0 : 1, target: motion ? 0 : 1 }

  // While a live sky is expected, keep the static rendition out of the way.
  root.classList.add('is-sky-live')
  const fail = () => root.classList.remove('is-webgl', 'is-sky-live')

  if (motion) {
    // The sun comes up as the finale scrolls in and settles.
    ScrollTrigger.create({
      trigger: $('[data-join-finale]', root),
      start: 'top bottom',
      end: 'bottom bottom',
      onUpdate: (self) => (state.target = self.progress),
      onRefresh: (self) => (state.target = self.progress),
    })
  }

  // Build the GL context lazily, once the section is getting close.
  let started = false
  const stop = observeVisibility(
    root,
    (visible) => {
      if (!visible || started) return
      started = true
      stop?.()
      import('./sky.js')
        .then(({ createSky }) => startSky(createSky))
        .catch((error) => {
          console.error('[sxsi] join sky unavailable', error)
          fail()
        })
    },
    { rootMargin: '100% 0px' },
  )

  function startSky(createSky) {
    let sky
    try {
      sky = createSky(canvas, { onLost: fail })
    } catch (error) {
      console.error('[sxsi] join sky failed to compile', error)
    }
    if (!sky) return fail()

    let shown = false
    const draw = (t) => {
      sky.render(t, state.rise)
      if (!shown && sky.ready) {
        shown = true
        root.classList.add('is-webgl')
      }
    }

    if (!motion) {
      // One still frame, redrawn only when the canvas is resized.
      sky.onResize = () => draw(12)
      return
    }

    // While the sky is at rest (the visitor is reading or typing) only the
    // stars twinkle, so draw every other frame; full rate while it moves.
    let frame = 0
    let drawnRise = -1
    createRenderLoop(root, (t, dt) => {
      state.rise = lerp(state.rise, state.target, 1 - Math.exp(-dt * 4))
      const settled = Math.abs(state.rise - drawnRise) < 1e-4
      if (settled && frame++ % 2) return
      drawnRise = state.rise
      draw(t)
    })
  }
}

/* --------------------------------------------------------------------------
 * Scroll reveals (motion only — under reduced motion everything is visible)
 * ------------------------------------------------------------------------ */
function initReveals(root) {
  const head = $('.s-join__head', root)
  const lines = $$('[data-join-line]', root)
  const reveals = $$('[data-join-reveal]', root)
  const float = $('[data-join-float]', root)
  const hint = $('[data-join-hint]', root)
  const finale = $('[data-join-finale]', root)
  const words = $$('[data-join-word]', root)
  const finaleHud = $$('[data-join-finale-hud] > *', root)

  gsap.set(lines, { yPercent: 110 })
  gsap.set(reveals, { opacity: 0, y: 26 })
  gsap.set(float, { opacity: 0, y: 110, z: -260, rotateX: 34, rotateY: -16 })
  gsap.set(hint, { opacity: 0 })
  gsap.set(words, { yPercent: 115 })
  gsap.set(finaleHud, { opacity: 0, y: 18 })

  // Crossing the Kármán line: the rule draws out from the centre, then its
  // readouts decode like a departures board.
  const karman = $('[data-join-karman]', root)
  const karmanRule = $('[data-join-karman-rule]', root)
  const karmanLabels = $$('.s-join__karman-label', karman)
  gsap.set(karmanRule, { scaleX: 0 })
  gsap.set(karmanLabels, { opacity: 0 })
  ScrollTrigger.create({
    trigger: karman,
    start: 'top 78%',
    once: true,
    onEnter: () => {
      gsap.to(karmanRule, { scaleX: 1, duration: 2, ease: 'expo.inOut' })
      gsap.to(karmanLabels, { opacity: 1, duration: 0.8, ease: 'power2.out', stagger: 0.18, delay: 0.7 })
      gsap.delayedCall(0.7, () => scramble(karmanLabels[0], karmanLabels[0].textContent, 0.9))
      emit('sound:cue', { type: 'blip' })
    },
  })

  ScrollTrigger.create({
    trigger: head,
    start: 'top 82%',
    once: true,
    onEnter: () => {
      gsap.to(lines, { yPercent: 0, duration: 1.6, ease: 'expo.out', stagger: 0.12 })
      gsap.to(reveals, { opacity: 1, y: 0, duration: 1.4, ease: 'expo.out', stagger: 0.12, delay: 0.25 })
    },
  })

  ScrollTrigger.create({
    trigger: float,
    start: 'top 88%',
    once: true,
    onEnter: () => {
      gsap.to(float, { opacity: 1, y: 0, z: 0, rotateX: 0, rotateY: 0, duration: 2.4, ease: 'expo.out', delay: 0.15 })
      gsap.to(hint, { opacity: 1, duration: 1.2, ease: 'power2.out', delay: 1.1 })
    },
  })

  ScrollTrigger.create({
    trigger: finale,
    start: 'top 45%',
    once: true,
    onEnter: () => {
      gsap.to(words, { yPercent: 0, duration: 1.9, ease: 'expo.out', stagger: 0.14 })
      gsap.to(finaleHud, { opacity: 1, y: 0, duration: 1.4, ease: 'expo.out', stagger: 0.1, delay: 0.6 })
      emit('sound:cue', { type: 'whoosh' })
    },
  })

  // A whisper of parallax on the finale type as the sun comes up.
  gsap.fromTo(
    $('[data-join-sky-title]', root),
    { y: 70 },
    { y: 0, ease: 'none', scrollTrigger: { trigger: finale, start: 'top bottom', end: 'bottom bottom', scrub: true } },
  )
}
